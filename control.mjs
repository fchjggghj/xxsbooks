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

status and reconcile without --apply are read-only. start/resume run in the background.`;
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

  const logPath = path.join(projectRoot, 'output', `control-${stage}.log`);
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

function applyChanges(loaded, changes) {
  for (const change of changes) {
    if (change.field === 'currentTaskId') {
      loaded.state.currentTaskId = null;
      loaded.state.currentNovelKey = null;
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
      console.log(
        `${stage.stage}: done=${stage.counts.done} failed=${stage.counts.failed} pending=${stage.counts.pending} running=${stage.counts.running} missing=${stage.missingOutputs.length}`,
      );
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
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
  } else if (command === 'start' || command === 'resume') {
    const stage = requireStage(positional[1]);
    if (command === 'resume' && options.force) throw new Error('resume does not accept --force.');
    result = await launch(command, stage, options);
  } else if (command === 'stop') {
    result = await stopQueue();
  } else if (command === 'reconcile') {
    const stage = requireStage(positional[1] || 'all', true);
    result = await reconcile(stage, options.apply);
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
