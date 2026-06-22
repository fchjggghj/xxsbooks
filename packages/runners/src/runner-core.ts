/**
 * Runner 核心共享模块
 *
 * 统一 3 个步骤（拆大纲/改编大纲/生成正文）的共享功能：
 * - 路径管理：根据 stage 获取 runner 目录
 * - 文件日志：同时输出到控制台和 run.log（格式兼容后端 parseRunLine）
 * - 进程锁：.run.lock 统一管理
 * - 进程检测：processAlive
 *
 * 每个 runner 只需关心自己的配置和提示词逻辑，进度记录/锁/状态检测全部复用此模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log as consoleLog, timestamp } from '@novel-pipeline/shared';

// ---------- 路径管理 ----------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/runners/src/ → 项目根目录
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Runner 阶段类型 */
export type RunnerStage = 'outline' | 'adapt' | 'generate';

/** 阶段对应的 scripts 子目录名 */
const RUNNER_DIR_MAP: Record<RunnerStage, string> = {
  outline: 'gpt-outline-runner',
  adapt: 'gpt-adapt-runner',
  generate: 'gpt-generate-runner',
};

/** 获取 runner 目录的绝对路径 */
export function getRunnerDir(stage: RunnerStage): string {
  return path.join(PROJECT_ROOT, '程序', 'scripts', RUNNER_DIR_MAP[stage]);
}

/** 获取 runner 目录下的文件路径 */
export function runnerPath(stage: RunnerStage, filename: string): string {
  return path.join(getRunnerDir(stage), filename);
}

// ---------- 进程检测 ----------

/** 检测进程是否存活（跨平台） */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

// ---------- 进程锁 ----------

interface RunLockInfo {
  pid?: number;
  startedAt?: string;
}

/** 读取运行锁 */
function readRunLock(lockPath: string): RunLockInfo {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) as RunLockInfo;
  } catch {
    return {};
  }
}

/**
 * 获取运行锁。如果锁已被活跃进程持有，抛出错误。
 * @param stage  阶段
 * @param staleMs 锁过期时间（默认 24 小时）
 */
export function acquireLock(stage: RunnerStage, staleMs = 24 * 60 * 60 * 1000): { lockPath: string } | null {
  const lockPath = runnerPath(stage, '.run.lock');

  for (let i = 0; i < 2; i++) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
      return { lockPath };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code !== 'EEXIST') throw err;

      const info = readRunLock(lockPath);
      if (info.pid && processAlive(info.pid)) {
        throw new Error(
          `已有 ${stage}-runner 正在运行（pid=${info.pid}），本次退出以避免重复生成。`,
        );
      }

      try {
        const st = fs.statSync(lockPath);
        if (!info.pid && Date.now() - st.mtimeMs < staleMs) {
          throw new Error(`发现较新的运行锁 ${lockPath}，本次退出以避免重复生成。`);
        }
        fs.unlinkSync(lockPath);
        continue;
      } catch (staleErr) {
        const se = staleErr as NodeJS.ErrnoException;
        if (se?.code !== 'ENOENT') throw staleErr;
        continue;
      }
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* 忽略关闭错误 */
        }
      }
    }
  }

  throw new Error(`无法创建运行锁 ${lockPath}`);
}

/** 释放运行锁（仅当锁属于当前进程时删除） */
export function releaseLock(lock: { lockPath: string } | null): void {
  if (!lock?.lockPath) return;
  try {
    const info = readRunLock(lock.lockPath);
    if (Number(info.pid) === process.pid) fs.unlinkSync(lock.lockPath);
  } catch {
    // 退出清理失败不影响已生成文件。
  }
}

// ---------- 文件日志 ----------

/** ANSI 颜色码正则（写入文件时去除） */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * 创建文件日志函数。
 *
 * 同时输出到：
 * 1. 控制台（带 ANSI 颜色，通过 shared.log）
 * 2. run.log 文件（纯文本，格式 `[HH:MM:SS] 消息`，兼容后端 parseRunLine）
 *
 * @param stage  阶段（决定 run.log 路径）
 * @returns 与 shared.log 签名相同的函数
 */
export function createFileLogger(stage: RunnerStage): (msg: string, color?: string) => void {
  const logPath = runnerPath(stage, 'run.log');

  return (msg: string, color?: string) => {
    // 1. 控制台输出（带颜色）
    consoleLog(msg, color as never);

    // 2. 文件追加（纯文本，去 ANSI 色）
    try {
      const line = `[${timestamp()}] ${msg.replace(ANSI_RE, '')}\n`;
      fs.appendFileSync(logPath, line, 'utf8');
    } catch {
      // 文件写入失败不影响运行
    }
  };
}

// ---------- STOP 文件检测 ----------

/** 检查是否有 STOP 标记（runner 跑完当前章后退出） */
export function isStopRequested(stage: RunnerStage): boolean {
  return fs.existsSync(runnerPath(stage, 'STOP'));
}

/** 清除 STOP 标记 */
export function clearStopFile(stage: RunnerStage): void {
  try {
    if (fs.existsSync(runnerPath(stage, 'STOP'))) {
      fs.unlinkSync(runnerPath(stage, 'STOP'));
    }
  } catch {
    /* ignore */
  }
}
