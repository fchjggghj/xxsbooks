import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  acquireQueueLock,
  isProcessAlive,
  readQueueLock,
  releaseQueueLock,
} from './queue-lock.mjs';
import { inspectChatGptSession } from './lib/chatgpt-session.mjs';
import { extractFileOrder, sortVolumeNames } from './lib/naming.mjs';
import { assertSafePathSegment, resolveInside } from './lib/path-safety.mjs';
import { loadBookCatalog, settingsForBook } from './lib/book-catalog.mjs';
import { createControlStatusRuntime } from './lib/control/status.mjs';
import { runFanqieControl } from './fanqie-control.mjs';
import { runMaterialControl } from './material-control.mjs';
import { runExternalResourceImport } from './scripts/import-external-resources.mjs';
import { runCampaignControl } from './campaign-control.mjs';

const projectRoot = path.resolve(
  process.env.XXSBOOKS_PROJECT_ROOT || path.dirname(fileURLToPath(import.meta.url)),
);
const STAGES = {
  chai: 'config-chai.json',
  xie: 'config-xie.json',
};
const statusRuntime = createControlStatusRuntime(projectRoot, STAGES);

function usage() {
  return `XXSBooks control

Usage:
  node control.mjs status [chai|xie|all] [--json]
  node control.mjs start <chai|xie> [--book 书名] [--limit N] [--per-novel-limit N] [--force] [--json]
  node control.mjs resume <chai|xie> [--book 书名] [--limit N] [--per-novel-limit N] [--json]
  node control.mjs stop [--json]
  node control.mjs reconcile <chai|xie|all> [--apply] [--json]
  node control.mjs preflight [--json]
  node control.mjs progress [--json]
  node control.mjs normalize <书名> [卷名] [--apply] [--json]
  node control.mjs fanqie <local-status|chrome|status|upload|reconcile> [...番茄参数]
  node control.mjs resources import --fanqie-root <目录> --material-root <目录> [--apply] [--json]
  node control.mjs material <local-status|index|search|import> [...素材参数]
  node control.mjs campaign <status|tick|bootstrap|enroll|metrics|decide> [...投放参数]

status and reconcile without --apply are read-only. start/resume run in the background.
--limit N: 本次运行最多处理 N 个 pending 任务（全局顺序截断）。
--per-novel-limit N: 每个 novelKey 本次最多处理 N 个 pending 任务（跨书轮询，可让多本书各处理前 N 章）。
--book 书名: 仅处理指定书；可重复传入，未选中的书籍状态保持不变。
preflight: 跑前预检（Chrome/CDP/登录态/输入文件齐全/编号连续）。
progress: 显式生成每本书的进度.md（写操作）。
normalize: 预览补零重命名；只有 --apply 才写入。`;
}

function parseArgs(argv) {
  const positional = [];
  const options = { json: false, apply: false, force: false, limit: null, perNovelLimit: null, books: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error('--limit must be a positive integer.');
      options.limit = value;
    } else if (arg === '--per-novel-limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) throw new Error('--per-novel-limit must be a non-negative integer.');
      options.perNovelLimit = value;
    } else if (arg === '--book') {
      const value = String(argv[++i] || '').trim();
      if (!value) throw new Error('--book requires a book name.');
      options.books.push(value);
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  return { positional, options };
}

function requireStage(value, allowAll = false) {
  const stage = value || (allowAll ? 'all' : '');
  if (stage === 'all' && allowAll) return stage;
  if (!Object.hasOwn(STAGES, stage)) throw new Error('Stage must be chai or xie.');
  return stage;
}

function resolveFromRoot(value) {
  return statusRuntime.resolveFromRoot(value);
}

async function readJson(file) {
  return statusRuntime.readJson(file);
}

async function loadStage(stage) {
  return statusRuntime.loadStage(stage);
}

function taskOutputPath(task) {
  return statusRuntime.taskOutputPath(task);
}

async function cdpStatus() {
  return statusRuntime.cdpStatus();
}

async function buildStatus(stage = 'all') {
  return statusRuntime.buildStatus(stage);
}

function ensureIdle(status) {
  if (status.lock.active) {
    throw new Error(`Queue is already running under PID ${status.lock.info?.pid || 'unknown'}.`);
  }
  if (status.processes.length) {
    throw new Error(`Found an existing gpts-queue process (PID ${status.processes[0].pid}).`);
  }
}

function ensureXieAllowed(status) {
  const chai = status.stages.chai;
  if (!chai) {
    throw new Error('Cannot start xie: chai stage state not found.');
  }
  // 约束本意：xie 处理某章前该章的 chai 拆分必须已完成。
  // 全量完成（chai.complete）直接放行；部分推进时要求 chai 无运行中任务且已有可改编素材，
  // 避免 chai/xie 同时操作同一本书产生竞态。xie 处理具体章节时若对应拆分文件不存在会在队列中报错。
  if (chai.counts.running > 0) {
    throw new Error(`Cannot start xie while chai is running (${chai.counts.running} task(s) in progress).`);
  }
  if (chai.counts.done === 0) {
    throw new Error('Cannot start xie: no chai outputs available yet.');
  }
}

function tailFile(file, maxChars = 2000) {
  try {
    const text = fssync.readFileSync(file, 'utf8');
    return text.slice(-maxChars);
  } catch {
    return '';
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch(command, stage, options) {
  const status = await buildStatus('all');
  ensureIdle(status);
  if (stage === 'xie') ensureXieAllowed(status);

  const stageStatus = status.stages[stage];
  if (command === 'resume') {
    if (!stageStatus.stateExists) throw new Error(`Cannot resume ${stage}: its state file does not exist.`);
    if (stageStatus.complete) throw new Error(`${stage} is already complete.`);
  }

  // 控制器日志跟随该阶段 stateFile 所在目录（书籍/.state/<stage>），避免散落在各书目录中。
  const stageCfg = await readJson(path.join(projectRoot, STAGES[stage]));
  const stateAbsPath = resolveFromRoot(stageCfg.stateFile || path.join(stageCfg.outputDir, 'state.json'));
  const logPath = path.join(path.dirname(stateAbsPath), `control-${stage}.log`);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(
    logPath,
    `\n${new Date().toISOString()} CONTROL ${command} stage=${stage} books=${options.books.join('|')} limit=${options.limit || ''} perNovelLimit=${options.perNovelLimit ?? ''} force=${options.force}\n`,
    'utf8',
  );
  const logFd = fssync.openSync(logPath, 'a');
  const args = ['gpts-queue.mjs', '--config', STAGES[stage]];
  if (options.limit) args.push('--limit', String(options.limit));
  if (options.perNovelLimit != null) args.push('--per-novel-limit', String(options.perNovelLimit));
  for (const book of options.books) args.push('--book', book);
  if (options.force) args.push('--force');

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  fssync.closeSync(logFd);
  child.unref();

  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(100);
    const lock = await readQueueLock(projectRoot);
    if (lock.active && Number(lock.info?.pid) === child.pid) {
      return {
        ok: true,
        command,
        stage,
        pid: child.pid,
        lock: path.relative(projectRoot, lock.path),
        logFile: path.relative(projectRoot, logPath),
      };
    }
    if (!isProcessAlive(child.pid)) {
      throw new Error(`Queue process exited before acquiring the lock.\n${tailFile(logPath)}`.trim());
    }
    if (lock.active && Number(lock.info?.pid) !== child.pid) {
      throw new Error(`Another queue acquired the lock under PID ${lock.info?.pid}.`);
    }
  }

  throw new Error(`Queue PID ${child.pid} started but did not acquire the lock in time. Check ${logPath}.`);
}

async function stopQueue() {
  const status = await buildStatus('all');
  let pid = status.lock.active ? Number(status.lock.info?.pid) : null;
  if (!pid && status.processes.length === 1) pid = status.processes[0].pid;
  if (!pid && status.processes.length > 1) {
    throw new Error('Multiple queue processes exist without one clear lock owner; refusing to guess.');
  }
  if (!pid) return { ok: true, command: 'stop', stopped: false, message: 'No active queue.' };

  process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50 && isProcessAlive(pid); attempt++) await delay(100);
  if (isProcessAlive(pid)) throw new Error(`PID ${pid} did not stop within 5 seconds.`);

  const stale = await readQueueLock(projectRoot);
  if (stale.exists && !stale.active) {
    const cleanup = await acquireQueueLock(projectRoot, { command: 'control-stop-cleanup' });
    await releaseQueueLock(cleanup);
  }
  return { ok: true, command: 'stop', stopped: true, pid };
}

function reconcileChanges(loaded) {
  const changes = [];
  for (const task of Object.values(loaded.state?.tasks || {})) {
    const outputPath = taskOutputPath(task);
    const outputExists = Boolean(outputPath && fssync.existsSync(outputPath));
    if (task.status === 'done' && !outputExists) {
      changes.push({ id: task.id, field: 'status', from: task.status, to: 'pending', reason: 'output_missing' });
    } else if (task.status !== 'done' && outputExists) {
      changes.push({ id: task.id, field: 'status', from: task.status || 'pending', to: 'done', reason: 'output_exists' });
    } else if (task.status === 'running') {
      // No live queue can be running this task by the time reconcile --apply runs
      // (ensureIdle guards it); a lingering 'running' status means the process was
      // killed mid-task. Reset so the task becomes retryable.
      changes.push({ id: task.id, field: 'status', from: 'running', to: 'pending', reason: 'stuck_running' });
    }
  }
  // currentTaskId is only meaningful while a queue process owns the lock. When the
  // referenced task is not (or will not be) running, the pointer is stale and should
  // be cleared so status --json stops reporting a phantom active task.
  const currentId = loaded.state?.currentTaskId;
  if (currentId) {
    const curTask = loaded.state?.tasks?.[currentId];
    const flaggedStuck = changes.some((c) => c.id === currentId && c.reason === 'stuck_running');
    const willBeRunning = curTask?.status === 'running' && !flaggedStuck;
    if (!willBeRunning) {
      changes.push({ id: currentId, field: 'currentTaskId', from: currentId, to: null, reason: 'stale_current' });
    }
  }

  // novelConversations retains the ChatGPT URL last used for each novel. When a
  // novel has zero done tasks (all pending/failed), that URL led to no successful
  // output — reusing it risks re-opening a broken/failed conversation and stalling
  // the next run. Drop it so ensureNovelConversation opens a fresh conversation.
  const conversations = loaded.state?.novelConversations || {};
  const tasksByNovel = new Map();
  for (const task of Object.values(loaded.state?.tasks || {})) {
    if (!tasksByNovel.has(task.novelKey)) tasksByNovel.set(task.novelKey, []);
    tasksByNovel.get(task.novelKey).push(task);
  }
  for (const [novelKey, url] of Object.entries(conversations)) {
    if (!url) continue;
    const novelTasks = tasksByNovel.get(novelKey) || [];
    const hasDone = novelTasks.some((t) => {
      const flagged = changes.find((c) => c.id === t.id && c.reason === 'output_missing');
      return t.status === 'done' && !flagged;
    });
    if (!hasDone) {
      changes.push({ id: novelKey, field: 'novelConversation', from: url, to: null, reason: 'stale_conversation' });
    }
  }
  return changes;
}

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      lastError = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
      if (attempt < 5) {
        await delay(250 * attempt);
        await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8').catch(() => {});
      }
    }
  }
  throw lastError;
}

// 原子写文本文件（进度.md 用），Windows 上 rename 可能因锁失败，重试几次
async function atomicWriteText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      lastError = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
      if (attempt < 5) {
        await delay(250 * attempt);
        await fs.writeFile(tmp, text, 'utf8').catch(() => {});
      }
    }
  }
  throw lastError;
}

function applyChanges(loaded, changes) {
  for (const change of changes) {
    if (change.field === 'currentTaskId') {
      loaded.state.currentTaskId = null;
      loaded.state.currentNovelKey = null;
      continue;
    }
    if (change.field === 'novelConversation') {
      if (loaded.state?.novelConversations) delete loaded.state.novelConversations[change.id];
      continue;
    }
    const task = loaded.state?.tasks?.[change.id];
    if (!task || change.field !== 'status') continue;
    task.status = change.to;
    task.updatedAt = new Date().toISOString();
    if (change.reason === 'output_missing') {
      task.lastError = '';
      task.sent = false;
      delete task.doneAt;
    } else if (change.reason === 'output_exists') {
      task.lastError = '';
      if (!task.doneAt) task.doneAt = new Date().toISOString();
    } else if (change.reason === 'stuck_running') {
      // Preserve sent/conversationUrl so edit-and-resend can still recover the
      // interrupted turn if the queue is configured for it. Only the misleading
      // 'running' status is cleared.
    }
  }
  // After status changes land, a stuck_running current task is now 'pending'. Clear
  // the pointer for any current task that is no longer running: reconcile --apply
  // always runs under ensureIdle, so no currentTaskId can legitimately be active.
  const curId = loaded.state?.currentTaskId;
  if (curId) {
    const curTask = loaded.state?.tasks?.[curId];
    if (!curTask || curTask.status !== 'running') {
      loaded.state.currentTaskId = null;
      loaded.state.currentNovelKey = null;
    }
  }
}

async function reconcile(stage, apply) {
  const selected = stage === 'all' ? Object.keys(STAGES) : [stage];
  if (!apply) {
    const loaded = await Promise.all(selected.map(loadStage));
    return {
      ok: true,
      command: 'reconcile',
      applied: false,
      readOnly: true,
      stages: Object.fromEntries(
        loaded.map((item) => [item.stage, { stateExists: Boolean(item.state), changes: reconcileChanges(item) }]),
      ),
    };
  }

  const status = await buildStatus('all');
  ensureIdle(status);
  const handle = await acquireQueueLock(projectRoot, { command: 'control-reconcile', stages: selected });
  try {
    const loaded = await Promise.all(selected.map(loadStage));
    const results = {};
    for (const item of loaded) {
      const changes = reconcileChanges(item);
      if (item.state && changes.length) {
        applyChanges(item, changes);
        await atomicWriteJson(item.statePath, item.state);
      }
      results[item.stage] = { stateExists: Boolean(item.state), changes };
    }
    return { ok: true, command: 'reconcile', applied: true, readOnly: false, stages: results };
  } finally {
    await releaseQueueLock(handle);
  }
}

function printResult(result, asJson) {
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else if (result.command === 'status') {
    console.log(`CDP: ${result.cdp.ready ? 'ready' : 'offline'} (${result.cdp.url})`);
    console.log(`Lock: ${result.lock.active ? `active PID ${result.lock.info?.pid}` : result.lock.stale ? 'stale' : 'idle'}`);
    for (const stage of Object.values(result.stages)) {
      const total = stage.taskCount || 0;
      const done = stage.counts.done || 0;
      const bar = progressBar(done, total);
      console.log(
        `${stage.stage}: ${bar} done=${done} failed=${stage.counts.failed} pending=${stage.counts.pending} running=${stage.counts.running} missing=${stage.missingOutputs.length}`,
      );
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

// 进度条：done/total 用方块字符展示
function progressBar(done, total, width = 10) {
  if (!total) return `[${'░'.repeat(width)}] 0/0`;
  const filled = Math.round((done / total) * width);
  const pct = Math.round((done / total) * 100);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${done}/${total} ${pct}%`;
}

// 为每本书/卷目录生成 进度.md，资源管理器里打开就能看到进度
async function writeBookProgressFiles(statusResult) {
  const chaiStage = statusResult.stages.chai;
  const xieStage = statusResult.stages.xie;
  if (!chaiStage && !xieStage) return [];

  // 从 state.tasks 收集每个卷的进度
  const progress = new Map();
  for (const stageInfo of [chaiStage, xieStage].filter(Boolean)) {
    const loaded = await loadStage(stageInfo.stage);
    if (!loaded.state?.tasks) continue;
    for (const task of Object.values(loaded.state.tasks)) {
      const key = task.novelKey; // 卷模式下是 "书名/卷名"
      if (!progress.has(key)) {
        progress.set(key, {
          book: task.novelName || key,
          volume: task.volumeName || '',
          chai: { done: 0, total: 0 },
          xie: { done: 0, total: 0 },
        });
      }
      const bp = progress.get(key);
      bp[stageInfo.stage].total++;
      if (task.status === 'done') bp[stageInfo.stage].done++;
    }
  }

  const booksDir = resolveFromRoot('书籍');
  const written = [];
  for (const [key, bp] of progress) {
    // 卷模式下 key = "书名/卷名"，进度文件写到卷目录下
    const keyParts = key.split(/[\\/]+/).filter(Boolean);
    for (const [index, part] of keyParts.entries()) {
      assertSafePathSegment(part, index === 0 ? '书名' : '卷名');
    }
    const targetDir = resolveInside(booksDir, ...keyParts);
    if (!fssync.existsSync(targetDir)) continue;
    const title = bp.volume ? `${bp.book} - ${bp.volume}` : bp.book;
    const lines = [
      `# ${title} 进度`,
      '',
      `更新时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      '',
      `## 拆分 (chai)`,
      `${progressBar(bp.chai.done, bp.chai.total)}  ${bp.chai.done}/${bp.chai.total} 章`,
      '',
      `## 正文 (xie)`,
      `${progressBar(bp.xie.done, bp.xie.total)}  ${bp.xie.done}/${bp.xie.total} 章`,
      '',
    ];
    const progressFile = path.join(targetDir, '进度.md');
    await atomicWriteText(progressFile, lines.join('\n'));
    written.push(path.relative(projectRoot, progressFile));
  }
  return written;
}

async function generateProgressFiles() {
  const status = await buildStatus('all');
  ensureIdle(status);
  const handle = await acquireQueueLock(projectRoot, { command: 'control-progress' });
  try {
    const written = await writeBookProgressFiles(status);
    return { ok: true, command: 'progress', applied: true, written };
  } finally {
    await releaseQueueLock(handle);
  }
}

// 检查单个源目录的输入文件齐全性和编号连续性
async function checkInputFiles(sourceDir, label) {
  if (!fssync.existsSync(sourceDir)) {
    return { name: `${label} 输入目录`, ok: false, detail: `目录不存在: ${path.relative(projectRoot, sourceDir)}` };
  }
  const files = (await fs.readdir(sourceDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && ['.txt', '.md'].includes(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
  if (files.length === 0) {
    return { name: `${label} 输入文件`, ok: false, detail: '没有 .txt/.md 文件' };
  }
  const issues = [];
  const nums = files.map((f) => parseInt(path.parse(f).name.replace(/\D/g, ''), 10)).filter((n) => !isNaN(n));
  if (nums.length === files.length) {
    const max = Math.max(...nums);
    for (let i = 1; i <= max; i++) {
      if (!nums.includes(i)) issues.push(`缺第${i}章`);
    }
  } else if (nums.length > 0) {
    issues.push('部分文件名无法解析为编号');
  }
  return { name: `${label} 输入文件`, ok: issues.length === 0, detail: `${files.length} 个文件${issues.length ? '，问题: ' + issues.join(', ') : '，编号连续'}` };
}

// 跑前预检：Chrome/CDP/登录态/输入文件齐全/编号连续
async function preflight() {
  const checks = [];
  const chaiCfg = await readJson(path.join(projectRoot, STAGES.chai));
  const xieCfg = await readJson(path.join(projectRoot, STAGES.xie));

  // 1. CDP 可达性
  const cdp = await cdpStatus();
  checks.push({ name: 'Chrome CDP', ok: cdp.ready, detail: cdp.ready ? `ready (${cdp.url})` : `offline (${cdp.url})，请先运行 npm run chrome` });

  // 2. 登录态：通过 CDP 读取已有浏览器会话，不使用没有 Cookie 的 Node HTTP 请求。
  if (cdp.ready) {
    const session = await inspectChatGptSession(chaiCfg.cdpUrl || cdp.url);
    checks.push({ name: 'ChatGPT 登录态', ...session });
  } else {
    checks.push({ name: 'ChatGPT 登录态', ok: false, detail: '跳过（CDP 不可达）' });
  }

  // 3. GPTS 地址格式
  for (const [stageName, configFile] of Object.entries(STAGES)) {
    const cfg = await readJson(path.join(projectRoot, configFile));
    const valid = String(cfg.gptUrl || '').startsWith('https://chatgpt.com/g/');
    checks.push({ name: `${stageName} GPTS 地址`, ok: valid, detail: valid ? cfg.gptUrl : `无效: ${cfg.gptUrl}` });
  }

  // 4. 两阶段配置必须形成闭环，避免拆分输出和正文输入错位。
  const sameVolumeMode = Boolean(chaiCfg.volumeMode) === Boolean(xieCfg.volumeMode);
  checks.push({
    name: '分卷模式一致性',
    ok: sameVolumeMode,
    detail: sameVolumeMode ? `均为 ${Boolean(chaiCfg.volumeMode)}` : 'config-chai.json 与 config-xie.json 的 volumeMode 不一致',
  });
  const stagePipelineMatches = chaiCfg.outputSubdir === xieCfg.inputSubdir;
  checks.push({
    name: '阶段目录衔接',
    ok: stagePipelineMatches,
    detail: stagePipelineMatches ? `${chaiCfg.outputSubdir} -> ${xieCfg.inputSubdir}` : `chai 输出 ${chaiCfg.outputSubdir} 不等于 xie 输入 ${xieCfg.inputSubdir}`,
  });
  const stateFilesDistinct = resolveFromRoot(chaiCfg.stateFile) !== resolveFromRoot(xieCfg.stateFile);
  checks.push({ name: '状态文件隔离', ok: stateFilesDistinct, detail: stateFilesDistinct ? 'chai/xie 独立' : 'chai/xie 使用了同一状态文件' });
  if (xieCfg.priorVolumeContext) {
    const contextConfigOk = Boolean(xieCfg.volumeMode) && String(xieCfg.promptTemplate || '').includes('{{priorVolumes}}');
    checks.push({
      name: '前卷上下文配置',
      ok: contextConfigOk,
      detail: contextConfigOk ? `上限 ${Number(xieCfg.priorVolumeContextMaxChars || 30000)} 字符` : '需要 volumeMode=true 且模板包含 {{priorVolumes}}',
    });
  }

  // 5. 每本书/卷输入文件齐全 + 编号连续
  const booksDir = resolveFromRoot(chaiCfg.inputDir || '书籍');
  const inputSubdir = chaiCfg.inputSubdir || '';
  const volumeMode = chaiCfg.volumeMode || false;
  const catalog = await loadBookCatalog({
    ...chaiCfg,
    stage: 'chai',
    bookConfigDir: chaiCfg.bookConfigDir ? resolveFromRoot(chaiCfg.bookConfigDir) : '',
  });
  if (fssync.existsSync(booksDir)) {
    const entries = await fs.readdir(booksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!settingsForBook(catalog, entry.name, 'chai', chaiCfg.chapterRange).enabled) continue;
      if (volumeMode) {
        // 卷模式：扫描 书名/卷名/原文/
        const bookDir = path.join(booksDir, entry.name);
        const volumes = (await fs.readdir(bookDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
          .sort(sortVolumeNames);
        if (volumes.length === 0) {
          checks.push({ name: `${entry.name} 卷目录`, ok: false, detail: '没有卷目录（需创建如 第一卷/）' });
          continue;
        }
        for (const volName of volumes) {
          const sourceDir = path.join(bookDir, volName, inputSubdir);
          const result = await checkInputFiles(sourceDir, `${entry.name}/${volName}`);
          checks.push(result);
        }
      } else {
        const sourceDir = inputSubdir ? path.join(booksDir, entry.name, inputSubdir) : path.join(booksDir, entry.name);
        const result = await checkInputFiles(sourceDir, entry.name);
        checks.push(result);
      }
    }
  }

  // 6. 锁状态
  const lock = await readQueueLock(projectRoot);
  checks.push({ name: '队列锁', ok: !lock.active, detail: lock.active ? `占用中 PID ${lock.info?.pid}` : '空闲' });

  // 7. 番茄仅做本地预检；不启动或访问番茄浏览器。
  try {
    const fanqie = await runFanqieControl(['local-status'], projectRoot);
    checks.push({
      name: '番茄账号绑定隔离', ok: fanqie.assignments.ok,
      detail: fanqie.assignments.ok ? `${fanqie.assignments.assignments.length} 个绑定无端口/Profile 冲突` : fanqie.assignments.errors.map((item) => item.detail).join('；'),
    });
    checks.push({
      name: '番茄发布锁', ok: !fanqie.lock.active,
      detail: fanqie.lock.active ? `占用中 PID ${fanqie.lock.info?.pid || '未知'}` : fanqie.lock.stale ? '存在陈旧锁，请核对进程' : '空闲',
    });
    for (const item of fanqie.books) {
      checks.push({
        name: `${item.book} 番茄正文质量`, ok: Boolean(item.quality?.ok) && !item.error,
        detail: item.error || (item.quality?.ok
          ? `${item.localChapterCount} 章，${item.quality.stats.minBodyChars}-${item.quality.stats.maxBodyChars} 字`
          : item.quality?.errors?.map((issue) => `第${issue.chapterNumber}章 ${issue.detail}`).join('；') || '质量检查失败'),
      });
    }
  } catch (error) {
    checks.push({ name: '番茄本地配置', ok: false, detail: error.message });
  }

  // 8. 月度投放只做本地完整性检查，不推进队列或访问番茄远端。
  try {
    const campaign = await runCampaignControl(['status'], projectRoot);
    const blockingPhases = new Set(['source_incomplete', 'awaiting_fanqie_binding', 'account_binding_mismatch', 'publish_attention']);
    const blocked = (campaign.lanes || []).filter((lane) => blockingPhases.has(lane.phase));
    checks.push({
      name: '月度投放六线完整性',
      ok: campaign.initialized === true && (campaign.lanes || []).length === 6 && blocked.length === 0,
      detail: campaign.initialized !== true
        ? '尚未初始化 campaign'
        : blocked.length
          ? blocked.map((lane) => `线${lane.lane}:${lane.phase}`).join('，')
          : `${campaign.activeCycle.id}，6 条投放线无本地阻塞`,
    });
  } catch (error) {
    checks.push({ name: '月度投放六线完整性', ok: false, detail: error.message });
  }

  const allOk = checks.every((c) => c.ok);
  return { ok: allOk, command: 'preflight', checks, summary: `${checks.filter((c) => c.ok).length}/${checks.length} 通过` };
}

// 章节编号自动补零：把任意文件名重命名为 0001.txt / 0002.txt ...
// 卷模式下：normalize 书名 卷名
// 非卷模式：normalize 书名
async function normalizeBook(bookName, volumeName, apply = false) {
  if (!bookName) throw new Error('请指定书名，例如: node control.mjs normalize 测试书 第一卷');
  const safeBookName = assertSafePathSegment(bookName, '书名');
  const chaiCfg = await readJson(path.join(projectRoot, STAGES.chai));
  const booksDir = resolveFromRoot(chaiCfg.inputDir || '书籍');
  const inputSubdir = chaiCfg.inputSubdir || '';
  const volumeMode = chaiCfg.volumeMode || false;
  const bookDir = resolveInside(booksDir, safeBookName);

  if (volumeMode && !volumeName) {
    // 卷模式下未指定卷名，列出所有卷供用户选择
    if (!fssync.existsSync(bookDir)) throw new Error(`书目录不存在: ${bookName}`);
    const volumes = (await fs.readdir(bookDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(sortVolumeNames);
    if (volumes.length === 0) throw new Error(`${bookName} 下没有卷目录，请先创建卷目录（如 第一卷/）`);
    throw new Error(`卷模式请在书名后指定卷名，例如: node control.mjs normalize ${bookName} ${volumes[0]}\n可用卷: ${volumes.join(', ')}`);
  }

  const safeVolumeName = volumeMode ? assertSafePathSegment(volumeName, '卷名') : '';

  const sourceDir = volumeMode
    ? resolveInside(bookDir, safeVolumeName, inputSubdir)
    : (inputSubdir ? resolveInside(bookDir, inputSubdir) : bookDir);

  if (!fssync.existsSync(sourceDir)) throw new Error(`源目录不存在: ${path.relative(projectRoot, sourceDir)}`);

  const files = (await fs.readdir(sourceDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && ['.txt', '.md'].includes(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => {
      const oa = extractFileOrder(a);
      const ob = extractFileOrder(b);
      if (oa !== ob) return oa - ob;
      return a.localeCompare(b, 'zh-Hans-CN', { numeric: true });
    });

  if (files.length === 0) throw new Error(`${path.relative(projectRoot, sourceDir)} 下没有 .txt/.md 文件`);

  const width = Math.max(4, String(files.length).length);
  const details = [];
  const skipped = [];
  for (let i = 0; i < files.length; i++) {
    const oldName = files[i];
    const ext = path.extname(oldName);
    const newName = `${String(i + 1).padStart(width, '0')}${ext}`;
    if (oldName === newName) { skipped.push(oldName); continue; }
    details.push({ from: oldName, to: newName });
  }

  const sourceNames = new Set(files.map((name) => name.toLocaleLowerCase('en-US')));
  for (const item of details) {
    const targetPath = path.join(sourceDir, item.to);
    if (fssync.existsSync(targetPath) && !sourceNames.has(item.to.toLocaleLowerCase('en-US'))) {
      throw new Error(`目标文件已存在且不在本次改名源集中: ${item.to}`);
    }
  }

  const result = {
    ok: true,
    command: 'normalize',
    applied: false,
    readOnly: !apply,
    book: safeBookName,
    volume: safeVolumeName,
    dir: path.relative(projectRoot, sourceDir),
    renamed: details.length,
    skipped: skipped.length,
    details,
  };
  if (!apply || details.length === 0) return result;

  const status = await buildStatus('all');
  ensureIdle(status);
  const handle = await acquireQueueLock(projectRoot, { command: 'control-normalize', book: safeBookName, volume: safeVolumeName });
  const staged = [];
  const completed = [];
  try {
    for (const [index, item] of details.entries()) {
      const oldPath = path.join(sourceDir, item.from);
      if (!fssync.existsSync(oldPath)) throw new Error(`源文件在预览后发生变化: ${item.from}`);
      const tempPath = path.join(sourceDir, `.normalize-${randomUUID()}-${index}.tmp`);
      await fs.rename(oldPath, tempPath);
      staged.push({ ...item, oldPath, tempPath, newPath: path.join(sourceDir, item.to) });
    }
    for (const item of staged) {
      await fs.rename(item.tempPath, item.newPath);
      completed.push(item);
    }
    result.applied = true;
    result.readOnly = false;
    return result;
  } catch (error) {
    // 尽最大可能回滚到原文件名，不留半套编号。
    for (const item of completed.reverse()) {
      if (fssync.existsSync(item.newPath)) await fs.rename(item.newPath, item.tempPath).catch(() => {});
    }
    for (const item of staged.reverse()) {
      if (fssync.existsSync(item.tempPath)) await fs.rename(item.tempPath, item.oldPath).catch(() => {});
    }
    throw error;
  } finally {
    await releaseQueueLock(handle);
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'fanqie') {
    const result = await runFanqieControl(rawArgs.slice(1), projectRoot);
    if (result.help) console.log(result.help);
    else printResult(result, rawArgs.includes('--json'));
    process.exit(0);
  }
  if (rawArgs[0] === 'material') {
    const result = await runMaterialControl(rawArgs.slice(1), projectRoot);
    if (result.help) console.log(result.help);
    else printResult(result, rawArgs.includes('--json'));
    return;
  }
  if (rawArgs[0] === 'resources') {
    if (rawArgs[1] !== 'import' && !rawArgs.includes('--help') && !rawArgs.includes('-h')) {
      throw new Error('resources 当前仅支持 import。');
    }
    const result = await runExternalResourceImport(rawArgs[1] === 'import' ? rawArgs.slice(2) : rawArgs.slice(1), projectRoot);
    if (result.help) console.log(result.help);
    else printResult(result, rawArgs.includes('--json'));
    return;
  }
  if (rawArgs[0] === 'campaign') {
    const result = await runCampaignControl(rawArgs.slice(1), projectRoot);
    if (result.help) console.log(result.help);
    else printResult(result, rawArgs.includes('--json'));
    return;
  }
  const { positional, options } = parseArgs(rawArgs);
  const command = positional[0] || 'help';
  if (options.help || command === 'help') {
    console.log(usage());
    return;
  }

  let result;
  if (command === 'status') {
    const stage = requireStage(positional[1] || 'all', true);
    result = await buildStatus(stage);
  } else if (command === 'start' || command === 'resume') {
    const stage = requireStage(positional[1]);
    if (command === 'resume' && options.force) throw new Error('resume does not accept --force.');
    result = await launch(command, stage, options);
  } else if (command === 'stop') {
    result = await stopQueue();
  } else if (command === 'reconcile') {
    const stage = requireStage(positional[1] || 'all', true);
    result = await reconcile(stage, options.apply);
  } else if (command === 'preflight') {
    result = await preflight();
  } else if (command === 'progress') {
    result = await generateProgressFiles();
  } else if (command === 'normalize') {
    result = await normalizeBook(positional[1], positional[2], options.apply);
  } else {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
  printResult(result, options.json);
  if (command === 'preflight' && !result.ok) process.exitCode = 1;
}

main().catch((err) => {
  const json = process.argv.includes('--json');
  const message = err instanceof Error ? err.message : String(err);
  if (json) console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`ERROR: ${message}`);
  if (process.argv[2] === 'fanqie') process.exit(1);
  process.exitCode = 1;
});
