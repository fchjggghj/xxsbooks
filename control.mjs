import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  acquireQueueLock,
  isProcessAlive,
  readQueueLock,
  releaseQueueLock,
} from './queue-lock.mjs';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const STAGES = {
  chai: 'config-chai.json',
  xie: 'config-xie.json',
};

function usage() {
  return `XXSBooks control

Usage:
  node control.mjs status [chai|xie|all] [--json]
  node control.mjs start <chai|xie> [--limit N] [--force] [--json]
  node control.mjs resume <chai|xie> [--limit N] [--json]
  node control.mjs stop [--json]
  node control.mjs reconcile <chai|xie|all> [--apply] [--json]
  node control.mjs preflight [--json]
  node control.mjs normalize <书名> [--json]

status and reconcile without --apply are read-only. start/resume run in the background.
preflight: 跑前预检（Chrome/CDP/登录态/输入文件齐全/编号连续）。
normalize: 把指定书的原文文件自动补零重命名。`;
}

function parseArgs(argv) {
  const positional = [];
  const options = { json: false, apply: false, force: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error('--limit must be a positive integer.');
      options.limit = value;
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
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function loadStage(stage) {
  const configPath = path.join(projectRoot, STAGES[stage]);
  const cfg = await readJson(configPath);
  const statePath = resolveFromRoot(cfg.stateFile || path.join(cfg.outputDir, 'state.json'));
  const logPath = resolveFromRoot(cfg.logFile || path.join(cfg.outputDir, 'run.log'));
  let state = null;
  try {
    state = await readJson(statePath);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return { stage, cfg, configPath, statePath, logPath, state };
}

function taskOutputPath(task) {
  if (!task?.outputFile) return null;
  return resolveFromRoot(task.outputFile);
}

function summarizeStage(loaded) {
  const tasks = Object.values(loaded.state?.tasks || {});
  const counts = { done: 0, failed: 0, pending: 0, running: 0, other: 0 };
  const missingOutputs = [];
  const outputsNotMarkedDone = [];

  for (const task of tasks) {
    const key = Object.hasOwn(counts, task.status) ? task.status : 'other';
    counts[key]++;
    const outputPath = taskOutputPath(task);
    const outputExists = Boolean(outputPath && fssync.existsSync(outputPath));
    if (task.status === 'done' && !outputExists) missingOutputs.push(task.id);
    if (task.status !== 'done' && outputExists) outputsNotMarkedDone.push(task.id);
  }

  const unfinished = counts.failed + counts.pending + counts.running + counts.other + missingOutputs.length;
  return {
    stage: loaded.stage,
    stateFile: path.relative(projectRoot, loaded.statePath),
    logFile: path.relative(projectRoot, loaded.logPath),
    stateExists: Boolean(loaded.state),
    taskCount: tasks.length,
    counts,
    currentTaskId: loaded.state?.currentTaskId || null,
    currentNovelKey: loaded.state?.currentNovelKey || null,
    lastError:
      tasks.find((task) => task.id === loaded.state?.currentTaskId)?.lastError ||
      tasks.find((task) => task.status === 'failed')?.lastError ||
      '',
    missingOutputs,
    outputsNotMarkedDone,
    complete: tasks.length > 0 && unfinished === 0,
  };
}

function listQueueProcesses() {
  try {
    if (process.platform === 'win32') {
      const script = [
        "$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'gpts-queue\\.mjs' } | Select-Object @{n='pid';e={$_.ProcessId}}, @{n='commandLine';e={$_.CommandLine}}",
        'if ($items) { $items | ConvertTo-Json -Compress }',
      ].join('; ');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      if (result.status !== 0 || !result.stdout.trim()) return [];
      const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
      return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
        pid: Number(item.pid),
        commandLine: String(item.commandLine || ''),
      }));
    }

    const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .filter((line) => line.includes('gpts-queue.mjs'))
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        return match ? { pid: Number(match[1]), commandLine: match[2] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function cdpStatus() {
  const cfg = await readJson(path.join(projectRoot, STAGES.chai));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`${String(cfg.cdpUrl).replace(/\/$/, '')}/json/version`, {
      signal: controller.signal,
    });
    return { url: cfg.cdpUrl, ready: response.ok };
  } catch {
    return { url: cfg.cdpUrl, ready: false };
  } finally {
    clearTimeout(timer);
  }
}

async function buildStatus(stage = 'all') {
  const selected = stage === 'all' ? Object.keys(STAGES) : [stage];
  const loaded = await Promise.all(selected.map(loadStage));
  const lock = await readQueueLock(projectRoot);
  const processes = listQueueProcesses();
  return {
    ok: true,
    command: 'status',
    checkedAt: new Date().toISOString(),
    readOnly: true,
    cdp: await cdpStatus(),
    lock: {
      path: path.relative(projectRoot, lock.path),
      exists: lock.exists,
      active: lock.active,
      stale: lock.stale,
      info: lock.info,
    },
    processes,
    stages: Object.fromEntries(loaded.map((item) => [item.stage, summarizeStage(item)])),
  };
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
  if (!chai?.complete) {
    throw new Error('Cannot start xie until chai is complete and all chai outputs exist.');
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
    `\n${new Date().toISOString()} CONTROL ${command} stage=${stage} limit=${options.limit || ''} force=${options.force}\n`,
    'utf8',
  );
  const logFd = fssync.openSync(logPath, 'a');
  const args = ['gpts-queue.mjs', '--config', STAGES[stage]];
  if (options.limit) args.push('--limit', String(options.limit));
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

// 为每本书目录生成 进度.md，资源管理器里打开书目录就能看到进度
async function writeBookProgressFiles(statusResult) {
  const chaiStage = statusResult.stages.chai;
  const xieStage = statusResult.stages.xie;
  if (!chaiStage && !xieStage) return;

  // 从 state.tasks 收集每本书的进度
  const bookProgress = new Map();
  for (const stageInfo of [chaiStage, xieStage].filter(Boolean)) {
    const loaded = await loadStage(stageInfo.stage);
    if (!loaded.state?.tasks) continue;
    for (const task of Object.values(loaded.state.tasks)) {
      const key = task.novelKey;
      if (!bookProgress.has(key)) {
        bookProgress.set(key, { book: task.novelName || key, chai: { done: 0, total: 0 }, xie: { done: 0, total: 0 } });
      }
      const bp = bookProgress.get(key);
      bp[stageInfo.stage].total++;
      if (task.status === 'done') bp[stageInfo.stage].done++;
    }
  }

  const booksDir = resolveFromRoot('书籍');
  for (const [key, bp] of bookProgress) {
    const bookDir = path.join(booksDir, key);
    if (!fssync.existsSync(bookDir)) continue;
    const lines = [
      `# ${bp.book} 进度`,
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
    await atomicWriteText(path.join(bookDir, '进度.md'), lines.join('\n'));
  }
}

// 跑前预检：Chrome/CDP/登录态/输入文件齐全/编号连续
async function preflight() {
  const checks = [];
  const chaiCfg = await readJson(path.join(projectRoot, STAGES.chai));

  // 1. CDP 可达性
  const cdp = await cdpStatus();
  checks.push({ name: 'Chrome CDP', ok: cdp.ready, detail: cdp.ready ? `ready (${cdp.url})` : `offline (${cdp.url})，请先运行 npm run chrome` });

  // 2. 登录态：访问 chatgpt.com 看是否跳转到登录页
  if (cdp.ready) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch('https://chatgpt.com/', { signal: ctrl.signal, redirect: 'manual' });
      clearTimeout(timer);
      const loggedIn = resp.status === 200 || (resp.status >= 300 && resp.status < 400 && (resp.headers.get('location') || '').includes('chatgpt.com'));
      checks.push({ name: 'ChatGPT 登录态', ok: loggedIn, detail: loggedIn ? '已登录' : `状态码 ${resp.status}，可能未登录或会话过期` });
    } catch (err) {
      checks.push({ name: 'ChatGPT 登录态', ok: false, detail: `检查失败: ${err.message}` });
    }
  } else {
    checks.push({ name: 'ChatGPT 登录态', ok: false, detail: '跳过（CDP 不可达）' });
  }

  // 3. GPTS 地址格式
  for (const [stageName, configFile] of Object.entries(STAGES)) {
    const cfg = await readJson(path.join(projectRoot, configFile));
    const valid = String(cfg.gptUrl || '').startsWith('https://chatgpt.com/g/');
    checks.push({ name: `${stageName} GPTS 地址`, ok: valid, detail: valid ? cfg.gptUrl : `无效: ${cfg.gptUrl}` });
  }

  // 4. 每本书输入文件齐全 + 编号连续
  const booksDir = resolveFromRoot(chaiCfg.inputDir || '书籍');
  const inputSubdir = chaiCfg.inputSubdir || '';
  if (fssync.existsSync(booksDir)) {
    const entries = await fs.readdir(booksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const sourceDir = inputSubdir ? path.join(booksDir, entry.name, inputSubdir) : path.join(booksDir, entry.name);
      if (!fssync.existsSync(sourceDir)) {
        checks.push({ name: `${entry.name} 输入目录`, ok: false, detail: `目录不存在: ${path.relative(projectRoot, sourceDir)}` });
        continue;
      }
      const files = (await fs.readdir(sourceDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && ['.txt', '.md'].includes(path.extname(e.name).toLowerCase()))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
      if (files.length === 0) {
        checks.push({ name: `${entry.name} 输入文件`, ok: false, detail: '没有 .txt/.md 文件' });
        continue;
      }
      // 检查编号连续性
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
      checks.push({ name: `${entry.name} 输入文件`, ok: issues.length === 0, detail: `${files.length} 个文件${issues.length ? '，问题: ' + issues.join(', ') : '，编号连续'}` });
    }
  }

  // 5. 锁状态
  const lock = await readQueueLock(projectRoot);
  checks.push({ name: '队列锁', ok: !lock.active, detail: lock.active ? `占用中 PID ${lock.info?.pid}` : '空闲' });

  const allOk = checks.every((c) => c.ok);
  return { ok: allOk, command: 'preflight', checks, summary: `${checks.filter((c) => c.ok).length}/${checks.length} 通过` };
}

// 中文数字转阿拉伯数字，用于正确排序"第一章/第二章"等文件名
const CN_NUM_MAP = { '一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10 };
function chineseNumToArabic(str) {
  // 匹配 十X、X十、X十X、X百X十X 等常见形式
  const match = str.match(/[一二两三四五六七八九十百千]+/);
  if (!match) return null;
  const s = match[0];
  if (s === '十') return 10;
  if (s.startsWith('十')) return 10 + (CN_NUM_MAP[s[1]] || 0);
  if (s.endsWith('十') && s.length === 2) return CN_NUM_MAP[s[0]] * 10;
  if (s.includes('十') && s.length === 3) return (CN_NUM_MAP[s[0]] || 0) * 10 + (CN_NUM_MAP[s[2]] || 0);
  // 纯个位
  if (s.length === 1) return CN_NUM_MAP[s] || null;
  return null;
}

// 提取文件名中的序号（阿拉伯数字优先，其次中文数字），用于正确排序
function extractFileOrder(name) {
  const base = path.parse(name).name;
  // 先试阿拉伯数字
  const arabic = base.match(/\d+/);
  if (arabic) return Number(arabic[0]);
  // 再试中文数字
  const cn = chineseNumToArabic(base);
  return cn !== null ? cn : 0;
}

// 章节编号自动补零：把任意文件名重命名为 0001.txt / 0002.txt ...
async function normalizeBook(bookName) {
  if (!bookName) throw new Error('请指定书名，例如: node control.mjs normalize 测试书');
  const chaiCfg = await readJson(path.join(projectRoot, STAGES.chai));
  const booksDir = resolveFromRoot(chaiCfg.inputDir || '书籍');
  const inputSubdir = chaiCfg.inputSubdir || '';
  const bookDir = path.join(booksDir, bookName);
  const sourceDir = inputSubdir ? path.join(bookDir, inputSubdir) : bookDir;

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
  const renamed = [];
  const skipped = [];
  for (let i = 0; i < files.length; i++) {
    const oldName = files[i];
    const ext = path.extname(oldName);
    const newName = `${String(i + 1).padStart(width, '0')}${ext}`;
    if (oldName === newName) { skipped.push(oldName); continue; }
    const oldPath = path.join(sourceDir, oldName);
    const newPath = path.join(sourceDir, newName);
    if (fssync.existsSync(newPath)) throw new Error(`目标文件已存在: ${newName}，请先处理冲突`);
    fssync.renameSync(oldPath, newPath);
    renamed.push({ from: oldName, to: newName });
  }

  return { ok: true, command: 'normalize', book: bookName, dir: path.relative(projectRoot, sourceDir), renamed: renamed.length, skipped: skipped.length, details: renamed };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'help';
  if (options.help || command === 'help') {
    console.log(usage());
    return;
  }

  let result;
  if (command === 'status') {
    const stage = requireStage(positional[1] || 'all', true);
    result = await buildStatus(stage);
    // 生成每本书的 进度.md
    await writeBookProgressFiles(result).catch(() => {});
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
  } else if (command === 'normalize') {
    result = await normalizeBook(positional[1]);
  } else {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
  printResult(result, options.json);
}

main().catch((err) => {
  const json = process.argv.includes('--json');
  const message = err instanceof Error ? err.message : String(err);
  if (json) console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`ERROR: ${message}`);
  process.exitCode = 1;
});
