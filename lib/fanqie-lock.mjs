import fs from 'node:fs/promises';
import path from 'node:path';

function lockScope(value) {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (!normalized) throw new Error('番茄发布锁缺少账号作用域');
  return normalized;
}

async function readLockOwner(lockFile) {
  try {
    return JSON.parse(await fs.readFile(lockFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function acquireFanqieLock(projectRoot, bookName, accountRef = '') {
  const stateDir = path.join(projectRoot, '书籍', '.state', 'fanqie');
  const scope = lockScope(accountRef || bookName);
  const lockFile = path.join(stateDir, `.publish.${scope}.lock.json`);
  const legacyLockFile = path.join(stateDir, '.publish.lock.json');
  await fs.mkdir(stateDir, { recursive: true });
  const owner = {
    pid: process.pid,
    book: bookName,
    accountRef: accountRef || null,
    scope,
    startedAt: new Date().toISOString(),
  };
  const legacyOwner = await readLockOwner(legacyLockFile);
  if (legacyOwner && (!accountRef || legacyOwner.book === bookName || legacyOwner.accountRef === accountRef)) {
    throw new Error(`已有番茄发布任务占用锁 ${legacyLockFile}。请先核对进程，不要直接删除锁。\n${JSON.stringify(legacyOwner, null, 2)}`);
  }
  try {
    const handle = await fs.open(lockFile, 'wx');
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    await handle.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await fs.readFile(lockFile, 'utf8').catch(() => '(无法读取锁内容)');
    throw new Error(`已有番茄发布任务占用锁 ${lockFile}。请先核对进程，不要直接删除锁。\n${existing}`);
  }
  let released = false;
  return {
    lockFile,
    async release() {
      if (released) return;
      const current = JSON.parse(await fs.readFile(lockFile, 'utf8'));
      if (current.pid !== owner.pid || current.startedAt !== owner.startedAt) {
        throw new Error(`番茄发布锁所有者已变化，拒绝删除: ${lockFile}`);
      }
      await fs.unlink(lockFile);
      released = true;
    },
  };
}

export async function inspectFanqieLock(projectRoot) {
  const stateDir = path.join(projectRoot, '书籍', '.state', 'fanqie');
  const names = await fs.readdir(stateDir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const lockFiles = names
    .filter((name) => name === '.publish.lock.json' || /^\.publish\..+\.lock\.json$/.test(name))
    .map((name) => path.join(stateDir, name));
  const locks = [];
  for (const lockFile of lockFiles) {
    try {
      const info = JSON.parse(await fs.readFile(lockFile, 'utf8'));
      let active = false;
      try {
        process.kill(Number(info.pid), 0);
        active = true;
      } catch (error) {
        if (error.code === 'EPERM') active = true;
      }
      locks.push({ path: lockFile, exists: true, active, stale: !active, info });
    } catch (error) {
      locks.push({ path: lockFile, exists: true, active: null, info: null, error: error.message });
    }
  }
  return {
    path: stateDir,
    exists: locks.length > 0,
    active: locks.some((item) => item.active === true),
    stale: locks.length > 0 && locks.every((item) => item.active === false),
    info: locks.length === 1 ? locks[0].info : null,
    locks,
  };
}

async function rotateFanqieLog(file, maxBytes, rotations) {
  const stat = await fs.stat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat || stat.size < maxBytes) return;
  for (let index = rotations; index >= 1; index--) {
    const source = index === 1 ? file : `${file}.${index - 1}`;
    const target = `${file}.${index}`;
    await fs.rm(target, { force: true });
    await fs.rename(source, target).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function appendFanqieLog(projectRoot, entry, options = {}) {
  const stateDir = path.join(projectRoot, '书籍', '.state', 'fanqie');
  await fs.mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, 'run.log');
  await rotateFanqieLog(file, Number(options.maxBytes || 5 * 1024 * 1024), Number(options.rotations || 3));
  await fs.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}
