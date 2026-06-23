/**
 * HTTP 路由
 *
 * 处理所有 API 路由（GET 和 POST），保持与现有 API 完全兼容。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { ApiResult } from './types.js';
import {
  PATHS,
  REQUEST_BODY_LIMIT,
  errorMessage,
  getConfig,
  getPort,
  readText,
  taskName,
  TASK_DIRS,
  TASK_NAMES,
  getTaskPaths,
  getTaskConfig,
  getTaskScanConfig,
} from './config.js';
import { chromeStatus } from './chrome.js';
import {
  parseDaemonLog,
  parseRunLogForTask,
  speedFromEvents,
  statusSnapshotForTask,
  allTaskStatuses,
} from './logs.js';
import { getPlan, getScan, getBookDetails, getScanForTask, getBookDetailsForTask } from './scanner.js';
import {
  handleQueueAction,
  handleQueueControl,
  loadQueueStore,
  publicQueueStore,
  queueItemDetails,
  queuePlanDetails,
  readQueueEvents,
} from './queue.js';
import {
  browseDir,
  chatGptWorkbenchSnapshot,
  doControl,
  handleChatGptAction,
  saveConfigRouteForTask,
} from './control.js';
import { healthSnapshot } from './health.js';
import {
  loadLibraryMeta,
  saveLibraryMeta,
  scanLibrary,
  syncLibraryMeta,
  addBookToLibrary,
  updateBookMeta,
  removeBookFromLibrary,
  getBookById,
  searchBooks,
  getBooksByStatus,
  migrateRawChapters,
  loadDirections,
  addDirection,
  getDirectionById,
  updateDirection,
  deleteDirection,
  batchSyncDirections,
  loadPoolItems,
  addPoolItem,
  getPoolItemById,
  updatePoolItem,
  deletePoolItem,
  batchSyncPool,
  getAvailableGenres,
  loadNewBooks,
  createNewBook,
  getNewBookById,
  updateNewBook,
  deleteNewBook,
  addChapterToBook,
  removeChapterFromBook,
  exportBookOutline,
  deepseek,
} from '@novel-pipeline/shared';

type Body = Record<string, unknown>;

/** 发送 JSON 响应 */
export function sendJson(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

/** 读取请求体（限制 4MB，UTF-8 解码） */
export function readBody(req: http.IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    req.setEncoding('utf8');
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > REQUEST_BODY_LIMIT) {
        req.destroy();
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => {
      try {
        resolve(d ? (JSON.parse(d) as Body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/** 主路由处理 */
export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method || 'GET';

  try {
    // ---------- 静态页面 ----------
    if (p === '/' || p === '/index.html') {
      const htmlPath = path.join(PATHS.webDist, 'index.html');
      const html = fs.existsSync(htmlPath)
        ? readText(htmlPath, '<h1>web/dist/index.html 缺失</h1>')
        : '<h1>控制中心 API</h1><p>Web 前端未构建，请运行 <code>pnpm --filter @novel-pipeline/web build</code></p>';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    // ---------- 静态资源 (assets) ----------
    if (p.startsWith('/assets/')) {
      const assetPath = path.join(PATHS.webDist, p);
      if (fs.existsSync(assetPath)) {
        const ext = path.extname(assetPath);
        const mimeTypes: Record<string, string> = {
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const content = fs.readFileSync(assetPath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000',
        });
        res.end(content);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    // ---------- GET 路由 ----------

    // 所有任务的状态摘要（多任务总览）
    if (p === '/api/tasks') {
      return sendJson(res, 200, {
        tasks: allTaskStatuses(),
        taskIds: Object.keys(TASK_DIRS),
      });
    }

    if (p === '/api/state') {
      const taskId = url.searchParams.get('task') || 'outline';
      const events = parseRunLogForTask(taskId, 300);
      // 多任务：使用任务专属扫描结果和配置
      const scan =
        taskId === 'outline' ? await getScan(false) : await getScanForTask(taskId, false);
      const cfg = taskId === 'outline' ? getConfig() : getTaskConfig<Record<string, unknown>>(taskId);
      // 通用字段：所有任务都有 gptUrl/cdpUrl；outline 额外有 libraryRoot/outputDir/selection 等
      const commonCfg: Record<string, unknown> = {
        gptUrl: cfg.gptUrl,
        cdpUrl: cfg.cdpUrl,
        taskName: taskName(),
        pipelineStages: cfg.pipelineStages || [],
      };
      if (taskId === 'outline') {
        const o = cfg as ReturnType<typeof getConfig>;
        Object.assign(commonCfg, {
          libraryRoot: o.libraryRoot,
          outputDir: o.outputDir,
          chaptersPerConversation: o.chaptersPerConversation,
          bigThreshold: o.selection?.bigThreshold,
          scheduledTaskName: o.scheduledTaskName,
        });
      } else {
        const t = cfg as Record<string, unknown>;
        Object.assign(commonCfg, {
          inputRoot: t.inputRoot,
          outputRoot: t.outputRoot,
          inputExt: t.inputExt,
          outputExt: t.outputExt,
          scheduledTaskName: t.scheduledTaskName,
        });
      }
      return sendJson(res, 200, {
        status: statusSnapshotForTask(taskId, events),
        totals: scan.totals,
        tiers: scan.tiers,
        speed: speedFromEvents(events),
        scanAgeSec: Math.round((Date.now() - scan.scannedAt) / 1000),
        config: commonCfg,
        taskId,
      });
    }

    if (p === '/api/chrome') return sendJson(res, 200, await chromeStatus());

    if (p === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        pid: process.pid,
        memory: process.memoryUsage(),
        chrome: { up: false },
        queue: { ok: true, summary: { total: 0, pending: 0, running: 0, done: 0, failed: 0 } },
        runtime: { running: false, heartbeatAgeSec: null },
        recentEvents: [],
      });
    }

    if (p === '/api/chatgpt/workbench' && method === 'GET')
      return sendJson(res, 200, await chatGptWorkbenchSnapshot());

    if (p === '/api/log') {
      const which = url.searchParams.get('which') || 'run';
      const n = Math.min(1000, Number(url.searchParams.get('n')) || 250);
      const taskId = url.searchParams.get('task') || 'outline';
      if (which === 'daemon') return sendJson(res, 200, { daemon: parseDaemonLog(n) });
      const events = parseRunLogForTask(taskId, n);
      return sendJson(res, 200, { events, speed: speedFromEvents(events) });
    }

    if (p === '/api/books') {
      const taskId = url.searchParams.get('task') || 'outline';
      const scan = await getScanForTask(taskId, false);
      return sendJson(res, 200, {
        books: scan.books,
        scanAgeSec: Math.round((Date.now() - scan.scannedAt) / 1000),
        taskId,
      });
    }

    if (p === '/api/failures') {
      const taskId = url.searchParams.get('task') || 'outline';
      const scan = await getScanForTask(taskId, false);
      return sendJson(res, 200, { failures: scan.failures, taskId });
    }

    if (p === '/api/plan') {
      const force = url.searchParams.get('force') === '1';
      const plan = await getPlan(force);
      return sendJson(res, 200, {
        ...plan,
        ageSec: Math.round((Date.now() - plan.builtAt) / 1000),
      });
    }

    if (p === '/api/prompt-queue' && method === 'GET')
      return sendJson(res, 200, publicQueueStore());

    if (p === '/api/prompt-queue/events' && method === 'GET') {
      const n = Math.min(500, Math.max(1, Number(url.searchParams.get('n')) || 120));
      return sendJson(res, 200, { events: readQueueEvents(n) });
    }

    if (p === '/api/prompt-queue/plan' && method === 'GET') {
      const n = Math.min(500, Math.max(1, Number(url.searchParams.get('n')) || 120));
      return sendJson(res, 200, queuePlanDetails(loadQueueStore(), n));
    }

    if (p === '/api/prompt-queue/item' && method === 'GET') {
      const item = queueItemDetails(url.searchParams.get('id') || '');
      if (!item) return sendJson(res, 404, { error: '任务不存在' });
      return sendJson(res, 200, item);
    }

    if (p === '/api/config' && method === 'GET') {
      const taskId = url.searchParams.get('task') || 'outline';
      try {
        const cfg = taskId === 'outline' ? getConfig() : getTaskConfig(taskId);
        const paths = getTaskPaths(taskId);
        return sendJson(res, 200, {
          config: cfg,
          path: paths.config,
          port: getPort(),
          taskId,
          taskName: TASK_NAMES[taskId] || taskId,
        });
      } catch (err) {
        return sendJson(res, 500, { error: errorMessage(err) });
      }
    }

    if (p === '/api/browse')
      return sendJson(res, 200, browseDir(url.searchParams.get('path') || ''));

    if (p === '/api/book') {
      const taskId = url.searchParams.get('task') || 'outline';
      const name = url.searchParams.get('name') || '';
      const book =
        taskId === 'outline' ? getBookDetails(name) : getBookDetailsForTask(taskId, name);
      if (!book) return sendJson(res, 404, { error: '未找到该书' });
      return sendJson(res, 200, book);
    }

    if (p === '/api/outline') {
      const taskId = url.searchParams.get('task') || 'outline';
      const scanCfg = getTaskScanConfig(taskId);
      const fp = url.searchParams.get('path') || '';
      // 路径合法性：必须在任务输出根或输入根下，且扩展名匹配
      const validRoots = [scanCfg.outputRoot, scanCfg.inputRoot].filter(Boolean);
      const validRoot = validRoots.some((r) => fp.startsWith(r));
      const validExt = fp.toLowerCase().endsWith(String(scanCfg.outputExt || '.md').toLowerCase());
      if (!fp || !validRoot || !validExt)
        return sendJson(res, 400, { error: '路径不合法' });
      const text = readText(fp, '');
      if (!text && !fs.existsSync(fp)) return sendJson(res, 404, { error: '文件不存在' });
      return sendJson(res, 200, { path: fp, text });
    }

    if (p === '/api/chapter') {
      const cfg = getConfig();
      const fp = url.searchParams.get('path') || '';
      if (!fp.startsWith(cfg.libraryRoot) || !fp.toLowerCase().endsWith('.txt'))
        return sendJson(res, 400, { error: '路径不合法' });
      const text = readText(fp, '');
      if (!text && !fs.existsSync(fp)) return sendJson(res, 404, { error: '文件不存在' });
      return sendJson(res, 200, {
        path: fp,
        text: text.slice(0, 20000),
        truncated: text.length > 20000,
      });
    }

    // ---------- 书库 API ----------
    if (p === '/api/library' && method === 'GET') {
      const query = url.searchParams.get('q') || '';
      const status = url.searchParams.get('status') || '';
      const cfg = getConfig();
      if (query) {
        return sendJson(res, 200, { books: searchBooks(cfg.pipelineRoot, query) });
      }
      if (status) {
        return sendJson(res, 200, { books: getBooksByStatus(cfg.pipelineRoot, status as any) });
      }
      return sendJson(res, 200, loadLibraryMeta(cfg.pipelineRoot));
    }

    if (p === '/api/library/sync' && method === 'POST') {
      const cfg = getConfig();
      const meta = syncLibraryMeta(cfg.pipelineRoot);
      return sendJson(res, 200, meta);
    }

    if (p === '/api/library/migrate' && method === 'POST') {
      const cfg = getConfig();
      migrateRawChapters(cfg.pipelineRoot);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/library/book' && method === 'GET') {
      const cfg = getConfig();
      const bookId = url.searchParams.get('id') || '';
      const book = getBookById(cfg.pipelineRoot, bookId);
      if (!book) return sendJson(res, 404, { error: '未找到该书' });
      return sendJson(res, 200, book);
    }

    if (p === '/api/library/book' && method === 'POST') {
      const cfg = getConfig();
      const body = await readBody(req);
      const book = addBookToLibrary(cfg.pipelineRoot, String(body.sourcePath || ''), {
        name: String(body.name || ''),
        author: String(body.author || ''),
        tags: (body.tags as string[]) || [],
      });
      return sendJson(res, 200, book);
    }

    if (p === '/api/library/book' && method === 'PUT') {
      const cfg = getConfig();
      const body = await readBody(req);
      const bookId = String(body.id || '');
      const updates = body.updates as Record<string, unknown> || {};
      const book = updateBookMeta(cfg.pipelineRoot, bookId, updates as any);
      if (!book) return sendJson(res, 404, { error: '未找到该书' });
      return sendJson(res, 200, book);
    }

    if (p === '/api/library/book' && method === 'DELETE') {
      const cfg = getConfig();
      const bookId = url.searchParams.get('id') || '';
      const ok = removeBookFromLibrary(cfg.pipelineRoot, bookId);
      return sendJson(res, ok ? 200 : 404, { ok });
    }

    // ---------- 改编方向 API ----------
    if (p === '/api/directions' && method === 'GET') {
      const cfg = getConfig();
      const bookId = url.searchParams.get('bookId') || '';
      const directions = loadDirections(cfg.pipelineRoot, bookId);
      return sendJson(res, 200, { directions });
    }

    if (p === '/api/directions' && method === 'POST') {
      const cfg = getConfig();
      const body = await readBody(req);
      const direction = addDirection(cfg.pipelineRoot, body as any);
      return sendJson(res, 200, direction);
    }

    if (p === '/api/directions/batch' && method === 'POST') {
      const cfg = getConfig();
      const body = await readBody(req);
      const count = batchSyncDirections(cfg.pipelineRoot);
      return sendJson(res, 200, { count });
    }

    if (p === '/api/directions/:id' && method === 'GET') {
      const cfg = getConfig();
      const directionId = p.split('/').pop() || '';
      const direction = getDirectionById(cfg.pipelineRoot, directionId);
      if (!direction) return sendJson(res, 404, { error: '未找到该改编方向' });
      return sendJson(res, 200, direction);
    }

    if (p === '/api/directions/:id' && method === 'PUT') {
      const cfg = getConfig();
      const directionId = p.split('/').pop() || '';
      const body = await readBody(req);
      const direction = updateDirection(cfg.pipelineRoot, directionId, body as any);
      if (!direction) return sendJson(res, 404, { error: '未找到该改编方向' });
      return sendJson(res, 200, direction);
    }

    if (p === '/api/directions/:id' && method === 'DELETE') {
      const cfg = getConfig();
      const directionId = p.split('/').pop() || '';
      const ok = deleteDirection(cfg.pipelineRoot, directionId);
      return sendJson(res, ok ? 200 : 404, { ok });
    }

    // ---------- 大纲池 API ----------
    if (p === '/api/pool' && method === 'GET') {
      const cfg = getConfig();
      const genre = url.searchParams.get('genre') || '';
      const items = loadPoolItems(cfg.pipelineRoot, genre);
      return sendJson(res, 200, { items });
    }

    if (p === '/api/pool' && method === 'POST') {
      const cfg = getConfig();
      const body = await readBody(req);
      const item = addPoolItem(cfg.pipelineRoot, body as any);
      return sendJson(res, 200, item);
    }

    if (p === '/api/pool/batch' && method === 'POST') {
      const cfg = getConfig();
      const count = batchSyncPool(cfg.pipelineRoot);
      return sendJson(res, 200, { count });
    }

    if (p === '/api/pool/genres' && method === 'GET') {
      const cfg = getConfig();
      const genres = getAvailableGenres(cfg.pipelineRoot);
      return sendJson(res, 200, { genres });
    }

    if (p.startsWith('/api/pool/') && method === 'GET') {
      const cfg = getConfig();
      const itemId = p.split('/').pop() || '';
      const item = getPoolItemById(cfg.pipelineRoot, itemId);
      if (!item) return sendJson(res, 404, { error: '未找到该大纲池项' });
      return sendJson(res, 200, item);
    }

    if (p.startsWith('/api/pool/') && method === 'PUT') {
      const cfg = getConfig();
      const itemId = p.split('/').pop() || '';
      const body = await readBody(req);
      const item = updatePoolItem(cfg.pipelineRoot, itemId, body as any);
      if (!item) return sendJson(res, 404, { error: '未找到该大纲池项' });
      return sendJson(res, 200, item);
    }

    if (p.startsWith('/api/pool/') && method === 'DELETE') {
      const cfg = getConfig();
      const itemId = p.split('/').pop() || '';
      const ok = deletePoolItem(cfg.pipelineRoot, itemId);
      return sendJson(res, ok ? 200 : 404, { ok });
    }

    // ---------- 新书组稿 API ----------
    if (p === '/api/books/new' && method === 'GET') {
      const cfg = getConfig();
      const books = loadNewBooks(cfg.pipelineRoot);
      return sendJson(res, 200, { books });
    }

    if (p === '/api/books/new' && method === 'POST') {
      const cfg = getConfig();
      const body = await readBody(req);
      const book = createNewBook(cfg.pipelineRoot, body as any);
      return sendJson(res, 200, book);
    }

    if (p.startsWith('/api/books/new/') && method === 'GET') {
      const cfg = getConfig();
      const bookId = p.split('/').pop() || '';
      const book = getNewBookById(cfg.pipelineRoot, bookId);
      if (!book) return sendJson(res, 404, { error: '未找到该书' });
      return sendJson(res, 200, book);
    }

    if (p.startsWith('/api/books/new/') && method === 'PUT') {
      const cfg = getConfig();
      const bookId = p.split('/').pop() || '';
      const body = await readBody(req);
      const book = updateNewBook(cfg.pipelineRoot, bookId, body as any);
      if (!book) return sendJson(res, 404, { error: '未找到该书' });
      return sendJson(res, 200, book);
    }

    if (p.startsWith('/api/books/new/') && method === 'DELETE') {
      const cfg = getConfig();
      const bookId = p.split('/').pop() || '';
      const ok = deleteNewBook(cfg.pipelineRoot, bookId);
      return sendJson(res, ok ? 200 : 404, { ok });
    }

    if (p.startsWith('/api/books/new/') && p.endsWith('/chapters') && method === 'POST') {
      const cfg = getConfig();
      const parts = p.split('/');
      const bookId = parts[parts.length - 2] || '';
      const body = await readBody(req);
      const book = addChapterToBook(cfg.pipelineRoot, bookId, body as any);
      if (!book) return sendJson(res, 404, { error: '未找到该书' });
      return sendJson(res, 200, book);
    }

    if (p.startsWith('/api/books/new/') && p.includes('/chapters/') && method === 'DELETE') {
      const cfg = getConfig();
      const parts = p.split('/');
      const bookId = parts[parts.length - 3] || '';
      const chapterId = parts[parts.length - 1] || '';
      const book = removeChapterFromBook(cfg.pipelineRoot, bookId, chapterId);
      if (!book) return sendJson(res, 404, { error: '未找到该书或章节' });
      return sendJson(res, 200, book);
    }

    if (p.startsWith('/api/books/new/') && p.endsWith('/export') && method === 'POST') {
      const cfg = getConfig();
      const bookId = p.split('/').filter(Boolean).pop() || '';
      const outputPath = exportBookOutline(cfg.pipelineRoot, bookId);
      if (!outputPath) return sendJson(res, 404, { error: '未找到该书' });
      return sendJson(res, 200, { path: outputPath });
    }

    // ---------- POST 路由 ----------
    if (method === 'POST' && p === '/api/prompt-queue') {
      const body = await readBody(req);
      const r = handleQueueAction(body);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (method === 'POST' && p === '/api/prompt-queue/control') {
      const body = await readBody(req);
      const r = handleQueueControl(body);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (method === 'POST' && p === '/api/chatgpt/action') {
      const body = await readBody(req);
      const r = await handleChatGptAction(body);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/deepseek/test' && method === 'POST') {
      const body = await readBody(req);
      const apiKey = String(body.apiKey || '');
      if (!apiKey) return sendJson(res, 400, { error: 'apiKey 不能为空' });
      const valid = await deepseek.checkApiKey(apiKey);
      return sendJson(res, 200, { valid, message: valid ? 'API Key 有效' : 'API Key 无效' });
    }

    if (p === '/api/deepseek/models' && method === 'POST') {
      const body = await readBody(req);
      const apiKey = String(body.apiKey || '');
      const baseUrl = String(body.baseUrl || '');
      if (!apiKey) return sendJson(res, 400, { error: 'apiKey 不能为空' });
      const models = await deepseek.listModels(apiKey, baseUrl || undefined);
      return sendJson(res, 200, { models });
    }

    if (p === '/api/deepseek/chat' && method === 'POST') {
      const body = await readBody(req);
      const prompt = String(body.prompt || '');
      const apiKey = String(body.apiKey || '');
      const model = String(body.model || '');
      const systemMessage = String(body.systemMessage || '');
      if (!prompt) return sendJson(res, 400, { error: 'prompt 不能为空' });
      if (!apiKey) return sendJson(res, 400, { error: 'apiKey 不能为空' });
      const result = await deepseek.sendChat(prompt, {
        apiKey,
        model: model || undefined,
      }, systemMessage || undefined);
      return sendJson(res, 200, result);
    }

    if (method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      const taskId = String(body.task || 'outline');
      const config = (body.config || body) as unknown;
      const r = saveConfigRouteForTask(taskId, config) as ApiResult;
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (method === 'POST' && p === '/api/control') {
      const body = await readBody(req);
      const r = await doControl(String(body.action || ''), body);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    // ---------- 404 ----------
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  } catch (err) {
    return sendJson(res, 500, { error: errorMessage(err) });
  }
}
