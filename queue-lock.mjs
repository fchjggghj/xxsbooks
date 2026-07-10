import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withReclaimGuard(lockPath, action) {
  const guardPath = `${lockPath}.reclaim`;
  let guard = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      guard = await fs.open(guardPath, 'wx');
      await guard.writeFile(`${process.pid} ${new Date().toISOString()}\n`, 'utf8');
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const stat = await fs.stat(guardPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 15000) await fs.rm(guardPath, { force: true });
      else await delay(25);
    }
  }
  if (!guard) throw new Error(`Timed out reclaiming stale queue lock ${lockPath}.`);

  try {
    return await action();
  } finally {
    await guard.close().catch(() => {});
    await fs.rm(guardPath, { force: true });
  }
}

export function lockPathFor(projectRoot) {
  return path.join(path.resolve(projectRoot), 'output', '.gpts-queue.lock.json');
}

export function isProcessAlive(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;

  try {
    process.kill(parsed, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but this user cannot signal it.
    return err?.code === 'EPERM';
  }
}

export async function readQueueLock(projectRoot) {
  const lockPath = lockPathFor(projectRoot);
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    let info = null;
    try {
      info = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      // A truncated or invalid lock is stale and may be reclaimed.
    }

    const active = Boolean(info && isProcessAlive(info.pid));
    return {
      path: lockPath,
      exists: true,
      active,
      stale: !active,
      info,
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        path: lockPath,
        exists: false,
        active: false,
        stale: false,
        info: null,
      };
    }
    throw err;
  }
}

export async function acquireQueueLock(projectRoot, metadata = {}) {
  const lockPath = lockPathFor(projectRoot);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (;;) {
    const ownerId = randomUUID();
    const info = {
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
      pid: process.pid,
      createdAt: new Date().toISOString(),
      ownerId,
    };

    let file;
    try {
      file = await fs.open(lockPath, 'wx');
      try {
        await file.writeFile(`${JSON.stringify(info, null, 2)}\n`, 'utf8');
      } finally {
        await file.close();
      }
      return { path: lockPath, info, ownerId, released: false };
    } catch (err) {
      if (file) await file.close().catch(() => {});
      if (err?.code !== 'EEXIST') throw err;

      const existing = await readQueueLock(projectRoot);
      if (!existing.exists) continue;
      if (existing.active) {
        const lockError = new Error(
          `GPTS queue is already running (PID ${existing.info.pid}, lock ${existing.path}).`,
        );
        lockError.code = 'QUEUE_LOCKED';
        lockError.lock = existing;
        throw lockError;
      }

      // Serialize stale-lock cleanup so two starters cannot remove each other's new lock.
      await withReclaimGuard(lockPath, async () => {
        const latest = await readQueueLock(projectRoot);
        if (!latest.exists) return;
        if (latest.active) {
          const lockError = new Error(
            `GPTS queue is already running (PID ${latest.info.pid}, lock ${latest.path}).`,
          );
          lockError.code = 'QUEUE_LOCKED';
          lockError.lock = latest;
          throw lockError;
        }
        await fs.rm(lockPath, { force: true });
      });
    }
  }
}

export async function releaseQueueLock(handle) {
  if (!handle || handle.released) return;

  try {
    const raw = await fs.readFile(handle.path, 'utf8');
    const current = JSON.parse(raw.replace(/^\uFEFF/, ''));
    // Never remove a lock that another owner acquired after this handle.
    if (current.ownerId !== handle.ownerId) return;
    await fs.rm(handle.path, { force: true });
  } catch (err) {
    if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  } finally {
    handle.released = true;
  }
}
