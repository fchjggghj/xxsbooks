/**
 * 配置管理 + 文件 I/O 工具
 *
 * 加载/保存 config.json，支持热更新。
 * 提供原子写入、安全读取等文件工具函数。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from './types.js';

// ---------- 路径常量 ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 从 packages/server/src/ 或 packages/server/dist/ 到项目根目录都是 ../../../
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPTS_DIR = path.join(PROJECT_ROOT, '程序', 'scripts');

/** 任务 ID → runner 目录名映射（内置 3 个任务，可扩展） */
export const TASK_DIRS: Record<string, string> = {
  outline: 'gpt-outline-runner',
  adapt: 'gpt-adapt-runner',
  generate: 'gpt-generate-runner',
};

/** 任务显示名 */
export const TASK_NAMES: Record<string, string> = {
  outline: '拆大纲',
  adapt: '改编大纲',
  generate: '写正文',
};

/** 获取任务目录路径 */
export function getTaskDir(taskId: string): string {
  const dir = TASK_DIRS[taskId];
  if (!dir) throw new Error(`未知任务: ${taskId}`);
  return path.join(SCRIPTS_DIR, dir);
}

/** 获取任务的所有关键文件路径 */
export function getTaskPaths(taskId: string) {
  const dir = getTaskDir(taskId);
  return {
    taskDir: dir,
    config: path.join(dir, 'config.json'),
    configBak: path.join(dir, 'config.bak.json'),
    runLog: path.join(dir, 'run.log'),
    daemonLog: path.join(dir, 'daemon.log'),
    runLock: path.join(dir, '.run.lock'),
    daemonLock: path.join(dir, '.daemon.lock'),
    stopFile: path.join(dir, 'STOP'),
  };
}

/** 默认任务目录（向后兼容：outline） */
const RUNNER_DIR = getTaskDir('outline');

/** 关键文件路径（默认 outline，向后兼容） */
export const PATHS = {
  projectRoot: PROJECT_ROOT,
  runnerDir: RUNNER_DIR,
  config: path.join(RUNNER_DIR, 'config.json'),
  configBak: path.join(RUNNER_DIR, 'config.bak.json'),
  runLog: path.join(RUNNER_DIR, 'run.log'),
  daemonLog: path.join(RUNNER_DIR, 'daemon.log'),
  runLock: path.join(RUNNER_DIR, '.run.lock'),
  daemonLock: path.join(RUNNER_DIR, '.daemon.lock'),
  stopFile: path.join(RUNNER_DIR, 'STOP'),
  queuePath: path.join(RUNNER_DIR, 'prompt-queue.json'),
  queueOutputRoot: path.join(RUNNER_DIR, 'prompt-queue-output'),
  queueEventLog: path.join(RUNNER_DIR, 'prompt-queue-events.jsonl'),
  webDist: path.join(PROJECT_ROOT, 'packages', 'web', 'dist'),
} as const;

// ---------- 多任务配置加载 ----------

/** 任务配置缓存（taskId → config） */
const taskConfigCache = new Map<string, unknown>();

/** 加载指定任务的 config.json */
export function loadTaskConfig<T = unknown>(taskId: string): T {
  if (taskConfigCache.has(taskId)) {
    return taskConfigCache.get(taskId) as T;
  }
  const paths = getTaskPaths(taskId);
  try {
    const raw = fs.readFileSync(paths.config, 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(raw) as T;
    taskConfigCache.set(taskId, cfg);
    return cfg;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`任务 ${taskId} 配置文件 ${paths.config} 解析失败: ${msg}`);
  }
}

/** 获取指定任务的配置（带缓存） */
export function getTaskConfig<T = unknown>(taskId: string): T {
  return loadTaskConfig<T>(taskId);
}

/** 重新从磁盘加载任务配置（清除缓存） */
export function reloadTaskConfig(taskId: string): unknown {
  taskConfigCache.delete(taskId);
  return loadTaskConfig(taskId);
}

/** 校验任务配置（基础校验，各任务类型可自行扩展） */
export function validateTaskConfig(taskId: string, c: unknown): string | null {
  if (!c || typeof c !== 'object') return '不是对象';
  const obj = c as Record<string, unknown>;
  if (typeof obj.gptUrl !== 'string') return 'gptUrl 必须是字符串';
  // outline 需要libraryRoot，adapt/generate 需要 inputRoot
  if (taskId === 'outline') {
    if (typeof obj.libraryRoot !== 'string' || !obj.libraryRoot.trim())
      return 'libraryRoot 不能为空';
  } else {
    if (typeof obj.inputRoot !== 'string' || !obj.inputRoot.trim())
      return 'inputRoot 不能为空';
  }
  return null;
}

/** 保存任务配置（原子写入 + 备份） */
export function saveTaskConfig(taskId: string, next: unknown): { ok: boolean; msg: string } {
  const err = validateTaskConfig(taskId, next);
  if (err) return { ok: false, msg: '配置无效：' + err };
  const paths = getTaskPaths(taskId);
  try {
    if (fs.existsSync(paths.config)) {
      fs.copyFileSync(paths.config, paths.configBak);
    }
    atomicWriteJson(paths.config, next);
    taskConfigCache.delete(taskId);
    return {
      ok: true,
      msg: `已保存 ${taskId} 任务配置（旧版本备份为 config.bak.json）。下一轮 runner 自动生效。`,
    };
  } catch (e) {
    return { ok: false, msg: '写入失败：' + errorMessage(e) };
  }
}

// ---------- 任务扫描配置（统一输入/输出路径逻辑） ----------

/** 任务扫描配置：描述如何扫描某任务的输入/输出 */
export interface TaskScanConfig {
  taskId: string;
  /** 输入根目录（包含小说子文件夹） */
  inputRoot: string;
  /** 输入子目录名（在小说文件夹内，空字符串表示直接在小说文件夹内） */
  inputSubDir: string;
  /** 输入文件扩展名 */
  inputExt: string;
  /** 输出根目录（包含小说子文件夹） */
  outputRoot: string;
  /** 输出子目录名（在小说文件夹内，空字符串表示直接在小说文件夹内） */
  outputSubDir: string;
  /** 输出文件扩展名 */
  outputExt: string;
  /** 跳过的文件名列表 */
  skipFiles: string[];
  /** 小说过滤（空=全部） */
  novels: string[];
  /** 是否有选择规则（仅 outline） */
  hasSelection: boolean;
  /** 原始配置（供 scanner 使用） */
  raw: Record<string, unknown>;
}

/** 获取任务的扫描配置（从任务 config.json 提取统一的路径信息） */
export function getTaskScanConfig(taskId: string): TaskScanConfig {
  const cfg = getTaskConfig<Record<string, unknown>>(taskId);
  if (taskId === 'outline') {
    return {
      taskId,
      inputRoot: String(cfg.libraryRoot || ''),
      inputSubDir: String(cfg.chaptersDir || ''),
      inputExt: '.txt',
      outputRoot: String(cfg.libraryRoot || ''),
      outputSubDir: String(cfg.outputDir || ''),
      outputExt: String(cfg.outputExt || '.md'),
      skipFiles: Array.isArray(cfg.skipFiles) ? (cfg.skipFiles as string[]) : [],
      novels: Array.isArray(cfg.novels) ? (cfg.novels as string[]) : [],
      hasSelection: true,
      raw: cfg,
    };
  }
  // adapt / generate: inputRoot/outputRoot 模式
  return {
    taskId,
    inputRoot: String(cfg.inputRoot || ''),
    inputSubDir: '',
    inputExt: String(cfg.inputExt || '.md'),
    outputRoot: String(cfg.outputRoot || ''),
    outputSubDir: '',
    outputExt: String(cfg.outputExt || '.md'),
    skipFiles: [],
    novels: Array.isArray(cfg.novels) ? (cfg.novels as string[]) : [],
    hasSelection: false,
    raw: cfg,
  };
}

// ---------- 常量 ----------
export const REQUEST_BODY_LIMIT = 4 * 1024 * 1024;
export const EVENT_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const QUEUE_IMPORT_LIMIT = 5000;
export const DEFAULT_MAX_ITEM_ATTEMPTS = 3;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_FAILURE_PAUSE_MS = 5 * 60 * 1000;
export const DEFAULT_RATE_LIMIT_WAIT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 2 * 60 * 60 * 1000;
export const MIN_DONE_BYTES = 800;
export const SCAN_TTL = 60_000;
export const PLAN_TTL = 60_000;

// ---------- 配置管理 ----------
let cfg: ServerConfig = loadConfig();

/** 获取当前配置（热更新：每次读取磁盘最新内容） */
export function getConfig(): ServerConfig {
  return cfg;
}

/** 重新从磁盘加载配置 */
export function reloadConfig(): ServerConfig {
  cfg = loadConfig();
  return cfg;
}

/** 加载 config.json（带 BOM 处理） */
function loadConfig(): ServerConfig {
  try {
    const raw = fs.readFileSync(PATHS.config, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) as ServerConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`配置文件 ${PATHS.config} 解析失败: ${msg}`);
  }
}

/** 校验配置 */
export function validateConfig(c: unknown): string | null {
  if (!c || typeof c !== 'object') return '不是对象';
  const obj = c as Record<string, unknown>;
  if (typeof obj.libraryRoot !== 'string' || !obj.libraryRoot.trim()) return 'libraryRoot 不能为空';
  if (typeof obj.gptUrl !== 'string') return 'gptUrl 必须是字符串';
  if (!Array.isArray(obj.novels)) return 'novels 必须是数组';
  return null;
}

/** 保存配置（原子写入 + 备份） */
export function saveConfig(next: unknown): { ok: boolean; msg: string } {
  const err = validateConfig(next);
  if (err) return { ok: false, msg: '配置无效：' + err };
  try {
    if (fs.existsSync(PATHS.config)) {
      fs.copyFileSync(PATHS.config, PATHS.configBak);
    }
    atomicWriteJson(PATHS.config, next);
    cfg = loadConfig();
    return {
      ok: true,
      msg: '已保存 config.json（旧版本备份为 config.bak.json）。下一轮 runner 自动生效。',
    };
  } catch (e) {
    return { ok: false, msg: '写入失败：' + errorMessage(e) };
  }
}

/** 获取计划任务名 */
export function taskName(): string {
  return cfg.scheduledTaskName || 'GptOutlineRunner';
}

/** 从 cdpUrl 提取端口 */
export function cdpPort(): string {
  const m = String(cfg.cdpUrl || '').match(/:(\d+)/);
  return m ? m[1] : '9222';
}

/** 获取监听端口 */
export function getPort(): number {
  return Number(process.env.WEB_PORT || cfg.webPort || 8787);
}

// ---------- 文件 I/O 工具 ----------

/** 安全读取文本文件 */
export function readText(file: string, fallback = ''): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

/** 安全读取 JSON 文件（带 BOM 处理） */
export function readJson<T = unknown>(file: string): T | null {
  try {
    const raw = readText(file).replace(/^\uFEFF/, '');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 带备份的 JSON 读取 */
export function readJsonWithBackup<T = unknown>(file: string): T | null {
  const main = readJson<T>(file);
  if (main) return main;
  return readJson<T>(`${file}.bak`);
}

/** 确保目录存在 */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** 原子写入文本（tmp + rename，先备份） */
export function atomicWriteText(file: string, text: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch {
    // 备份失败不阻止主写入
  }
  fs.renameSync(tmp, file);
}

/** 原子写入 JSON */
export function atomicWriteJson(file: string, obj: unknown): void {
  atomicWriteText(file, JSON.stringify(obj, null, 2));
}

/** 安全获取文件 mtime */
export function safeMtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** 安全获取文件大小 */
export function safeSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// ---------- 通用工具 ----------

/** 当前 ISO 时间 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 生成唯一 ID */
export function uid(prefix = 'q'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 内容哈希（SHA1） */
export function contentHash(s: string): string {
  return crypto
    .createHash('sha1')
    .update(String(s || ''), 'utf8')
    .digest('hex');
}

/** 安全文件名（去除非法字符） */
export function safeName(s: string, fallback = 'item'): string {
  const v = String(s || fallback)
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (v || fallback).slice(0, 96);
}

/** 检查进程是否存活 */
export function processAlive(pid: number | string | null | undefined): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err?.code === 'EPERM';
  }
}

/** 错误消息提取 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err ?? '');
}

/** 限制 ms 范围 */
export function boundedMs(
  value: unknown,
  fallback: number,
  maxValue = 24 * 60 * 60 * 1000,
): number {
  const n = Number(value);
  const ms = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.max(1000, Math.min(ms, maxValue));
}
