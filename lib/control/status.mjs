import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readQueueLock } from '../../queue-lock.mjs';

export function createControlStatusRuntime(projectRoot, stages) {
  const resolveFromRoot = (value) => path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
  const readJson = async (file) => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));

  async function loadStage(stage) {
    const configPath = path.join(projectRoot, stages[stage]);
    const cfg = await readJson(configPath);
    const statePath = resolveFromRoot(cfg.stateFile || path.join(cfg.outputDir, 'state.json'));
    const logPath = resolveFromRoot(cfg.logFile || path.join(cfg.outputDir, 'run.log'));
    let state = null;
    try { state = await readJson(statePath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return { stage, cfg, configPath, statePath, logPath, state };
  }

  function taskOutputPath(task) {
    return task?.outputFile ? resolveFromRoot(task.outputFile) : null;
  }

  function summarizeStage(loaded) {
    const tasks = Object.values(loaded.state?.tasks || {});
    const counts = { done: 0, failed: 0, pending: 0, running: 0, other: 0 };
    const missingOutputs = [];
    const outputsNotMarkedDone = [];
    for (const task of tasks) {
      counts[Object.hasOwn(counts, task.status) ? task.status : 'other']++;
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
      stateExists: Boolean(loaded.state), taskCount: tasks.length, counts,
      currentTaskId: loaded.state?.currentTaskId || null,
      currentNovelKey: loaded.state?.currentNovelKey || null,
      lastError: tasks.find((task) => task.id === loaded.state?.currentTaskId)?.lastError || tasks.find((task) => task.status === 'failed')?.lastError || '',
      missingOutputs, outputsNotMarkedDone,
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
        const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        if (result.status !== 0 || !result.stdout.trim()) return [];
        const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
        return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({ pid: Number(item.pid), commandLine: String(item.commandLine || '') }));
      }
      const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 5000 });
      if (result.status !== 0) return [];
      return result.stdout.split(/\r?\n/).filter((line) => line.includes('gpts-queue.mjs')).map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        return match ? { pid: Number(match[1]), commandLine: match[2] } : null;
      }).filter(Boolean);
    } catch { return []; }
  }

  async function cdpStatus() {
    const cfg = await readJson(path.join(projectRoot, stages.chai));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await fetch(`${String(cfg.cdpUrl).replace(/\/$/, '')}/json/version`, { signal: controller.signal });
      return { url: cfg.cdpUrl, ready: response.ok };
    } catch { return { url: cfg.cdpUrl, ready: false }; }
    finally { clearTimeout(timer); }
  }

  async function buildStatus(stage = 'all') {
    const selected = stage === 'all' ? Object.keys(stages) : [stage];
    const loaded = await Promise.all(selected.map(loadStage));
    const lock = await readQueueLock(projectRoot);
    return {
      ok: true, command: 'status', checkedAt: new Date().toISOString(), readOnly: true,
      cdp: await cdpStatus(),
      lock: { path: path.relative(projectRoot, lock.path), exists: lock.exists, active: lock.active, stale: lock.stale, info: lock.info },
      processes: listQueueProcesses(),
      stages: Object.fromEntries(loaded.map((item) => [item.stage, summarizeStage(item)])),
    };
  }

  return { resolveFromRoot, readJson, loadStage, taskOutputPath, summarizeStage, listQueueProcesses, cdpStatus, buildStatus };
}
