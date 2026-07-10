import http from 'node:http';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertSafePathSegment, resolveInside } from './lib/path-safety.mjs';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3210;
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 200 * 1024;
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const controlFile = path.join(projectRoot, 'control.mjs');
const importScript = path.join(projectRoot, 'import-newbooks.mjs');
const previewScript = path.join(projectRoot, 'preview-volumes.mjs');
const startChromeScript = path.join(projectRoot, 'start-chrome.ps1');
const uiRoot = path.join(projectRoot, 'ui');
const configFiles = { chai: 'config-chai.json', xie: 'config-xie.json' };

const staticFiles = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class ControlError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

function parsePort(argv) {
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error('--port 必须是 1 到 65535 之间的整数。');
      }
      port = value;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`本机小说队列控制面板\n\n用法：node local-ui.mjs [--port ${DEFAULT_PORT}]`);
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return port;
}

function securityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  };
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendEmpty(res, status) {
  res.writeHead(status, securityHeaders());
  res.end();
}

function tryParseJson(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runControl(args, timeout = 20_000) {
  // control.mjs 支持 --json
  return runNodeScript(controlFile, [...args, '--json'], timeout, { expectJson: true });
}

// 运行 Node 脚本。expectJson=true 时强制脚本输出 JSON；否则把 stdout 当文本返回。
function runNodeScript(scriptFile, args, timeout = 20_000, { expectJson = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scriptFile, ...args],
      {
        cwd: projectRoot,
        windowsHide: true,
        timeout,
        maxBuffer: 32 * 1024 * 1024,  // 32MB：大项目 state.json 可能达数 MB
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const output = tryParseJson(stdout) || tryParseJson(stderr);
        // 文本脚本：即使退出码非0（如 import 脚本遇到冲突 exitCode=2），只要 stdout 有内容就当作正常结果
        if (!expectJson && stdout && stdout.trim() && (!error || error.code === 2 || error.code === 1)) {
          resolve({ ok: !error, raw: true, text: String(stdout).trim(), exitCode: error?.code ?? 0 });
          return;
        }
        if (error) {
          const message = output?.error || String(stderr || stdout || error.message).trim();
          reject(
            new ControlError(message || '脚本执行失败。', {
              code: error.code || null,
              signal: error.signal || null,
              result: output,
              stdout: stdout ? String(stdout).slice(-4000) : null,
              stderr: stderr ? String(stderr).slice(-4000) : null,
            }),
          );
          return;
        }
        if (expectJson) {
          if (!output || typeof output !== 'object') {
            reject(new ControlError('脚本没有返回有效的 JSON。'));
            return;
          }
          resolve(output);
          return;
        }
        // 文本脚本：返回 stdout
        resolve({ ok: true, raw: true, text: String(stdout || '').trim(), exitCode: 0 });
      },
    );
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
      req.resume();
      reject(new HttpError(413, '请求内容不能超过 64KB。'));
      return;
    }

    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, '请求内容不能超过 64KB。'));
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const value = text ? JSON.parse(text) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('JSON 顶层必须是对象。');
        }
        resolve(value);
      } catch (error) {
        reject(new HttpError(400, `JSON 格式无效：${error.message}`));
      }
    });
    req.on('aborted', () => reject(new HttpError(400, '请求已中断。')));
    req.on('error', (error) => reject(new HttpError(400, error.message)));
  });
}

function isSameOriginWrite(req, port) {
  const origin = req.headers.origin;
  const host = String(req.headers.host || '').toLowerCase();
  const expectedHost = port === 80 ? HOST : `${HOST}:${port}`;
  if (!origin || host !== expectedHost) return false;
  try {
    const parsed = new URL(origin);
    const originPort = Number(parsed.port || (parsed.protocol === 'http:' ? 80 : 0));
    return parsed.protocol === 'http:' && parsed.hostname === HOST && originPort === port;
  } catch {
    return false;
  }
}

async function tailLog(stage) {
  if (!configFiles[stage]) throw new HttpError(400, 'stage 必须是 chai 或 xie。');
  const configFile = path.join(projectRoot, configFiles[stage]);
  const config = JSON.parse((await fs.readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
  const configuredPath = config.logFile || path.join(config.outputDir || '', 'run.log');
  const logFile = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(projectRoot, configuredPath);

  let handle;
  try {
    handle = await fs.open(logFile, 'r');
    const stat = await handle.stat();
    const size = Math.min(stat.size, MAX_LOG_BYTES);
    const start = Math.max(0, stat.size - size);
    const buffer = Buffer.alloc(size);
    if (size) await handle.read(buffer, 0, size, start);
    return {
      ok: true,
      stage,
      logFile: path.relative(projectRoot, logFile),
      text: buffer.toString('utf8'),
      truncated: stat.size > MAX_LOG_BYTES,
      size: stat.size,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        ok: true,
        stage,
        logFile: path.relative(projectRoot, logFile),
        text: '',
        truncated: false,
        size: 0,
      };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function publicError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof ControlError ? { details: error.details } : {}),
  };
}

// 全局写操作互斥：同一时间只允许一个 control 写操作，避免状态文件冲突
let writeBusy = false;

function acquireWriteLock() {
  if (writeBusy) {
    throw new HttpError(409, '另一个控制操作正在执行，请稍后再试。');
  }
  writeBusy = true;
}

function releaseWriteLock() {
  writeBusy = false;
}

// 不同命令的超时：大项目（1000万字 ≈ 3000章）时 status/reconcile/normalize 可能较慢
const COMMAND_TIMEOUTS = {
  status: 30_000,      // 大项目 state.json 可达数 MB
  preflight: 90_000,   // 包含 CDP + 文件扫描
  reconcile: 120_000,  // 对比 state 与磁盘，大项目慢
  progress: 120_000,   // 遍历所有书/卷
  normalize: 120_000,  // 重命名大量文件
  import: 300_000,     // 复制大量文件
  'preview-volumes': 120_000,
  default: 30_000,
};

function timeoutFor(command) {
  return COMMAND_TIMEOUTS[command] || COMMAND_TIMEOUTS.default;
}

// 通用写操作包装：先校验同源 + 互斥，再执行 control.mjs，最后回读状态
async function runWriteAction(req, res, buildArgs, { timeout = 30_000, rerunStatus = true } = {}) {
  if (!isSameOriginWrite(req, /* port injected later */ runWriteAction.port)) {
    throw new HttpError(403, '拒绝非同源写请求。请使用服务器输出的 127.0.0.1 地址打开面板。');
  }
  const body = await readJsonBody(req);
  acquireWriteLock();
  try {
    let before = null;
    try {
      before = await runControl(['status']);
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        error: '执行写操作前无法确认队列状态，因此没有执行操作。',
        cause: publicError(error),
      });
      return;
    }

    let result = null;
    let actionError = null;
    try {
      const args = buildArgs(body);
      result = await runControl(args, timeout);
    } catch (error) {
      actionError = error;
    }

    let after = null;
    let afterError = null;
    if (rerunStatus) {
      try {
        after = await runControl(['status']);
      } catch (error) {
        afterError = error;
      }
    }

    if (actionError) {
      sendJson(res, 409, {
        ok: false,
        error: actionError.message,
        cause: publicError(actionError),
        before,
        after,
        afterError: afterError ? publicError(afterError) : null,
      });
      return;
    }
    if (afterError) {
      sendJson(res, 502, {
        ok: false,
        actionApplied: true,
        error: '操作已提交，但无法读取操作后的队列状态。',
        cause: publicError(afterError),
        before,
        result,
      });
      return;
    }

    sendJson(res, 200, { ok: true, before, result, after });
  } finally {
    releaseWriteLock();
  }
}

// 启动 / 继续 / 停止 队列（增强：支持 limit 和 force）
async function handleAction(req, res) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new HttpError(415, '请求必须使用 application/json。');
  }
  await runWriteAction(req, res, (body) => {
    const action = body.action;
    const stage = body.stage;
    if (!['start', 'resume', 'stop'].includes(action)) {
      throw new HttpError(400, 'action 只能是 start、resume 或 stop。');
    }
    if ((action === 'start' || action === 'resume') && !['chai', 'xie'].includes(stage)) {
      throw new HttpError(400, '开始或继续时必须选择 chai 或 xie 阶段。');
    }
    if (action === 'resume' && body.force) {
      throw new HttpError(400, 'resume 不支持 --force。');
    }
    if (action === 'stop') return ['stop'];

    const args = [action, stage];
    const limit = Number(body.limit);
    if (body.limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new HttpError(400, 'limit 必须是正整数。');
    }
    if (limit > 0) args.push('--limit', String(limit));
    if (body.force) args.push('--force');
    return args;
  });
}

// 修复状态：reconcile <stage> [--apply]
async function handleReconcile(req, res) {
  await runWriteAction(req, res, (body) => {
    const stage = body.stage || 'all';
    if (!['chai', 'xie', 'all'].includes(stage)) {
      throw new HttpError(400, 'stage 必须是 chai、xie 或 all。');
    }
    const args = ['reconcile', stage];
    if (body.apply) args.push('--apply');
    return args;
  }, { timeout: timeoutFor('reconcile') });
}

// 生成每本书的 进度.md
async function handleProgress(req, res) {
  await runWriteAction(req, res, () => ['progress'], { timeout: timeoutFor('progress') });
}

// 章节编号补零重命名：normalize <书名> [卷名] [--apply]
async function handleNormalize(req, res) {
  await runWriteAction(req, res, (body) => {
    const book = String(body.book || '').trim();
    const volume = String(body.volume || '').trim();
    if (!book) throw new HttpError(400, '请指定书名。');
    const args = ['normalize', book];
    if (volume) args.push(volume);
    if (body.apply) args.push('--apply');
    return args;
  }, { timeout: timeoutFor('normalize') });
}

// 导入新书：import-newbooks.mjs <源目录> [--apply]
async function handleImport(req, res) {
  if (!isSameOriginWrite(req, handleImport.port)) {
    throw new HttpError(403, '拒绝非同源写请求。');
  }
  const body = await readJsonBody(req);
  const source = String(body.source || '').trim();
  if (!source) throw new HttpError(400, '请指定源目录。');
  if (!fssync.existsSync(source)) throw new HttpError(400, `源目录不存在: ${source}`);
  acquireWriteLock();
  try {
    const args = [source];
    if (body.apply) args.push('--apply');
    const result = await runNodeScript(importScript, args, timeoutFor('import'));
    sendJson(res, 200, { ok: true, result });
  } finally {
    releaseWriteLock();
  }
}

// 生成分卷预览报告：preview-volumes.mjs <源目录>
async function handlePreviewVolumes(req, res) {
  if (!isSameOriginWrite(req, handlePreviewVolumes.port)) {
    throw new HttpError(403, '拒绝非同源写请求。');
  }
  const body = await readJsonBody(req);
  const source = String(body.source || '').trim();
  if (!source) throw new HttpError(400, '请指定源目录。');
  if (!fssync.existsSync(source)) throw new HttpError(400, `源目录不存在: ${source}`);
  acquireWriteLock();
  try {
    const args = [source];
    const result = await runNodeScript(previewScript, args, timeoutFor('preview-volumes'));
    sendJson(res, 200, { ok: true, result });
  } finally {
    releaseWriteLock();
  }
}

// 启动 Chrome 调试浏览器（非阻塞，不占用写锁）
async function handleChrome(req, res) {
  if (!isSameOriginWrite(req, handleChrome.port)) {
    throw new HttpError(403, '拒绝非同源写请求。');
  }
  await readJsonBody(req); // 消费请求体
  if (process.platform !== 'win32') {
    throw new HttpError(501, '此接口仅在 Windows 下可用；其他平台请手动启动 Chrome --remote-debugging-port=9222。');
  }
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startChromeScript], {
    cwd: projectRoot,
    windowsHide: false,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  sendJson(res, 200, { ok: true, message: 'Chrome 启动命令已发出，请稍候查看 CDP 状态。', pid: child.pid });
}

// 列出 书籍/ 下的书和卷结构（只读）
async function listBooks() {
  const chaiCfg = JSON.parse((await fs.readFile(path.join(projectRoot, configFiles.chai), 'utf8')).replace(/^\uFEFF/, ''));
  const booksDir = path.resolve(projectRoot, chaiCfg.inputDir || '书籍');
  const volumeMode = Boolean(chaiCfg.volumeMode);
  const books = [];
  if (!fssync.existsSync(booksDir)) return { ok: true, books, volumeMode, booksDir: path.relative(projectRoot, booksDir) };

  const entries = await fs.readdir(booksDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const bookDir = path.join(booksDir, entry.name);
    const book = { name: entry.name, volumes: [], fileCounts: {} };
    if (volumeMode) {
      const vols = (await fs.readdir(bookDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name);
      for (const volName of vols) {
        const counts = await countSubdirs(path.join(bookDir, volName));
        book.volumes.push({ name: volName, fileCounts: counts });
      }
    } else {
      book.fileCounts = await countSubdirs(bookDir);
    }
    books.push(book);
  }
  return { ok: true, books, volumeMode, booksDir: path.relative(projectRoot, booksDir) };
}

async function countSubdirs(dir) {
  const counts = { 原文: 0, 拆分: 0, 正文: 0 };
  for (const sub of Object.keys(counts)) {
    const subDir = path.join(dir, sub);
    if (!fssync.existsSync(subDir)) continue;
    try {
      const files = (await fs.readdir(subDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && ['.txt', '.md'].includes(path.extname(e.name).toLowerCase()));
      counts[sub] = files.length;
    } catch { /* ignore */ }
  }
  return counts;
}

// 读取配置文件
async function readConfig(stage) {
  if (!configFiles[stage]) throw new HttpError(400, 'stage 必须是 chai 或 xie。');
  const file = path.join(projectRoot, configFiles[stage]);
  const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  return { ok: true, stage, file: configFiles[stage], config: JSON.parse(text) };
}

// 配置 schema 基本校验：防止破坏性字段被改成非法值
function validateConfig(stage, cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new HttpError(400, '配置必须是 JSON 对象。');
  }
  const requiredString = ['cdpUrl', 'gptUrl', 'inputDir', 'outputDir', 'stateFile', 'logFile', 'promptTemplate'];
  for (const key of requiredString) {
    if (key in cfg && typeof cfg[key] !== 'string') {
      throw new HttpError(400, `${key} 必须是字符串。`);
    }
  }
  if (typeof cfg.gptUrl === 'string' && !cfg.gptUrl.startsWith('https://chatgpt.com/g/')) {
    throw new HttpError(400, 'gptUrl 必须形如 https://chatgpt.com/g/<id>。');
  }
  const numericPositive = ['maxPromptChars', 'chaptersPerPrompt', 'maxRetries', 'rateLimitWaitMs', 'rateLimitMaxAttempts', 'safetyMaxAttempts', 'waitReplyTimeoutMs', 'replyStableMs', 'maxStableGeneratingMs', 'betweenItemsMs', 'minReplyChars'];
  for (const key of numericPositive) {
    if (key in cfg && (!Number.isFinite(Number(cfg[key])) || Number(cfg[key]) < 0)) {
      throw new HttpError(400, `${key} 必须是非负数字。`);
    }
  }
  const boolKeys = ['volumeMode', 'priorVolumeContext', 'recursive', 'skipExisting', 'includeFileHeaders'];
  for (const key of boolKeys) {
    if (key in cfg && typeof cfg[key] !== 'boolean') {
      throw new HttpError(400, `${key} 必须是布尔值。`);
    }
  }
  if (stage === 'xie' && cfg.volumeMode && cfg.priorVolumeContext) {
    if (!String(cfg.promptTemplate || '').includes('{{priorVolumes}}')) {
      throw new HttpError(400, '启用 priorVolumeContext 时，promptTemplate 必须包含 {{priorVolumes}} 占位符。');
    }
  }
  if (stage === 'xie' && cfg.inputSubdir !== '拆分') {
    throw new HttpError(400, 'xie 阶段的 inputSubdir 必须为 "拆分"，否则会断开流水线。');
  }
  if (stage === 'chai' && cfg.outputSubdir !== '拆分') {
    throw new HttpError(400, 'chai 阶段的 outputSubdir 必须为 "拆分"。');
  }
  if (stage === 'xie' && cfg.outputSubdir !== '正文') {
    throw new HttpError(400, 'xie 阶段的 outputSubdir 必须为 "正文"。');
  }
}

// 保存配置文件（原子写）
async function saveConfig(stage, cfg, req, res) {
  if (!isSameOriginWrite(req, saveConfig.port)) {
    throw new HttpError(403, '拒绝非同源写请求。');
  }
  if (!configFiles[stage]) throw new HttpError(400, 'stage 必须是 chai 或 xie。');
  validateConfig(stage, cfg);
  const file = path.join(projectRoot, configFiles[stage]);
  const text = `${JSON.stringify(cfg, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
  sendJson(res, 200, { ok: true, stage, file: configFiles[stage], saved: true });
}

// 读取单个文件内容（限制大小，仅限 书籍/ 目录下）
async function readFileInBooks(url, res) {
  const target = url.searchParams.get('path');
  if (!target) throw new HttpError(400, '请提供 path 参数。');
  const chaiCfg = JSON.parse((await fs.readFile(path.join(projectRoot, configFiles.chai), 'utf8')).replace(/^\uFEFF/, ''));
  const booksDir = path.resolve(projectRoot, chaiCfg.inputDir || '书籍');
  const resolved = path.resolve(booksDir, target);
  // 防止路径穿越：必须位于 booksDir 之内
  const relative = path.relative(booksDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, '路径必须位于书籍目录之内。');
  }
  if (!fssync.existsSync(resolved) || fssync.statSync(resolved).isDirectory()) {
    throw new HttpError(404, '文件不存在。');
  }
  const stat = await fs.stat(resolved);
  const maxBytes = 200 * 1024;
  if (stat.size > maxBytes) {
    throw new HttpError(413, `文件过大（${stat.size} 字节），仅支持 200KB 以内的预览。`);
  }
  const text = await fs.readFile(resolved, 'utf8');
  sendJson(res, 200, {
    ok: true,
    path: path.relative(projectRoot, resolved),
    size: stat.size,
    text,
  });
}

async function serveStatic(pathname, req, res) {
  const entry = staticFiles.get(pathname);
  if (!entry) return false;
  const body = await fs.readFile(path.join(uiRoot, entry.file));
  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': entry.type,
    'Content-Length': body.length,
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
  return true;
}

function createServer(port) {
  // 把 port 注入到写操作闭包里，用于同源校验
  runWriteAction.port = port;
  handleImport.port = port;
  handlePreviewVolumes.port = port;
  handleChrome.port = port;
  saveConfig.port = port;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}:${port}`);
      const method = req.method || 'GET';
      const pathname = url.pathname;

      // 只读接口
      if (method === 'GET' && pathname === '/api/status') {
        sendJson(res, 200, await runControl(['status'], timeoutFor('status')));
        return;
      }
      if (method === 'GET' && pathname === '/api/preflight') {
        sendJson(res, 200, await runControl(['preflight'], timeoutFor('preflight')));
        return;
      }
      if (method === 'GET' && pathname === '/api/logs') {
        const stage = url.searchParams.get('stage');
        if (!['chai', 'xie'].includes(stage)) {
          throw new HttpError(400, 'stage 必须是 chai 或 xie。');
        }
        sendJson(res, 200, await tailLog(stage));
        return;
      }
      if (method === 'GET' && pathname === '/api/books') {
        sendJson(res, 200, await listBooks());
        return;
      }
      if (method === 'GET' && pathname === '/api/config') {
        const stage = url.searchParams.get('stage');
        sendJson(res, 200, await readConfig(stage));
        return;
      }
      if (method === 'GET' && pathname === '/api/file') {
        await readFileInBooks(url, res);
        return;
      }

      // 写接口
      if (method === 'POST' && pathname === '/api/action') {
        await handleAction(req, res);
        return;
      }
      if (method === 'POST' && pathname === '/api/reconcile') {
        await handleReconcile(req, res);
        return;
      }
      if (method === 'POST' && pathname === '/api/progress') {
        await handleProgress(req, res);
        return;
      }
      if (method === 'POST' && pathname === '/api/normalize') {
        await handleNormalize(req, res);
        return;
      }
      if (method === 'POST' && pathname === '/api/import') {
        await handleImport(req, res);
        return;
      }
      if (method === 'POST' && pathname === '/api/preview-volumes') {
        await handlePreviewVolumes(req, res);
        return;
      }
      if (method === 'POST' && pathname === '/api/chrome') {
        await handleChrome(req, res);
        return;
      }
      if (method === 'POST' && pathname === '/api/config') {
        const body = await readJsonBody(req);
        const stage = body.stage;
        const config = body.config;
        if (!configFiles[stage]) throw new HttpError(400, 'stage 必须是 chai 或 xie。');
        await saveConfig(stage, config, req, res);
        return;
      }

      if (pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'POST') {
          res.setHeader('Allow', 'GET, POST');
          throw new HttpError(405, '不支持此请求方法。');
        }
        throw new HttpError(404, '接口不存在。');
      }
      if ((method === 'GET' || method === 'HEAD') && (await serveStatic(pathname, req, res))) {
        return;
      }
      if (method === 'GET' && pathname === '/favicon.ico') {
        sendEmpty(res, 204);
        return;
      }
      throw new HttpError(method === 'GET' || method === 'HEAD' ? 404 : 405, '页面不存在。');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof ControlError ? 502 : 500;
      sendJson(res, status, { ok: false, error: publicError(error).message });
    }
  });
}

const port = parsePort(process.argv.slice(2));
const server = createServer(port);

server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
server.on('error', (error) => {
  console.error(`面板启动失败：${error.message}`);
  process.exitCode = 1;
});
server.listen(port, HOST, () => {
  console.log(`本机小说队列控制面板：http://${HOST}:${port}`);
  console.log('仅监听 127.0.0.1；按 Ctrl+C 退出。');
});
