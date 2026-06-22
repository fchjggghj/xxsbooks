/**
 * 队列管理
 *
 * 任务队列持久化、状态机、事件日志。
 * 保留基本 CRUD + 状态机（简化版：不实际驱动 Chrome 执行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  ApiResult,
  PublicQueueItem,
  PublicQueueStore,
  QueueErrorType,
  QueueEvent,
  QueueHealth,
  QueueItem,
  QueueItemDetails,
  QueueItemStatus,
  QueuePhase,
  QueuePlanDetails,
  QueueProfile,
  QueueRuntime,
  QueueStore,
  QueueSummary,
} from './types.js';
import {
  DEFAULT_MAX_ITEM_ATTEMPTS,
  EVENT_LOG_MAX_BYTES,
  PATHS,
  QUEUE_IMPORT_LIMIT,
  atomicWriteJson,
  atomicWriteText,
  contentHash,
  ensureDir,
  getConfig,
  nowIso,
  readJsonWithBackup,
  readText,
  safeName,
  safeSize,
  uid,
} from './config.js';
import { tailFile } from './logs.js';

// ---------- 运行时状态 ----------

export const queueRuntime: QueueRuntime = {
  runId: '',
  running: false,
  paused: false,
  stopRequested: false,
  phase: 'idle',
  activeId: null,
  activeTitle: '',
  activeProfileId: '',
  activeProfileName: '',
  startedAt: null,
  heartbeatAt: null,
  lastTransitionAt: null,
  processed: 0,
  succeeded: 0,
  failed: 0,
  consecutiveFailures: 0,
  autoPaused: false,
  resumeAt: '',
  pauseReason: '',
  limitHint: '',
  message: '队列空闲',
  lastError: '',
};

/** 设置队列阶段（保留以备未来扩展使用） */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function setQueuePhase(
  phase: QueuePhase,
  message?: string,
  extra: {
    activeId?: string | null;
    activeTitle?: string;
    activeProfileId?: string;
    activeProfileName?: string;
  } = {},
): void {
  queueRuntime.phase = phase;
  queueRuntime.message = message || queueRuntime.message;
  queueRuntime.heartbeatAt = nowIso();
  queueRuntime.lastTransitionAt = queueRuntime.heartbeatAt;
  if (extra.activeId !== undefined) queueRuntime.activeId = extra.activeId;
  if (extra.activeTitle !== undefined) queueRuntime.activeTitle = extra.activeTitle;
  if (extra.activeProfileId !== undefined) queueRuntime.activeProfileId = extra.activeProfileId;
  if (extra.activeProfileName !== undefined)
    queueRuntime.activeProfileName = extra.activeProfileName;
}

// ---------- 事件日志 ----------

/** 裁剪事件 payload */
function trimEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v == null) continue;
    if (typeof v === 'string') out[k] = v.length > 500 ? v.slice(0, 500) + '...' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = JSON.parse(JSON.stringify(v));
  }
  return out;
}

/** 事件日志轮转 */
function rotateEventLogIfNeeded(): void {
  try {
    if (
      fs.existsSync(PATHS.queueEventLog) &&
      fs.statSync(PATHS.queueEventLog).size > EVENT_LOG_MAX_BYTES
    ) {
      const bak = PATHS.queueEventLog.replace(/\.jsonl$/, '.1.jsonl');
      try {
        if (fs.existsSync(bak)) fs.unlinkSync(bak);
      } catch {
        /* ignore */
      }
      fs.renameSync(PATHS.queueEventLog, bak);
    }
  } catch {
    /* ignore */
  }
}

/** 追加队列事件 */
export function appendQueueEvent(type: string, payload: Record<string, unknown> = {}): void {
  try {
    rotateEventLogIfNeeded();
    const ev: QueueEvent = {
      ts: nowIso(),
      type,
      runId: queueRuntime.runId || '',
      phase: queueRuntime.phase,
      activeId: queueRuntime.activeId || '',
      ...trimEventPayload(payload),
    };
    fs.appendFileSync(PATHS.queueEventLog, JSON.stringify(ev) + '\n', 'utf8');
  } catch {
    // 事件日志不能反过来拖垮队列运行
  }
}

/** 读取队列事件 */
export function readQueueEvents(n = 120): QueueEvent[] {
  const raw = tailFile(PATHS.queueEventLog, 256 * 1024)
    .split(/\r?\n/)
    .filter(Boolean);
  const out: QueueEvent[] = [];
  for (const line of raw.slice(-n)) {
    try {
      out.push(JSON.parse(line) as QueueEvent);
    } catch {
      /* ignore */
    }
  }
  return out;
}

// ---------- 默认执行档案 ----------

function defaultProfile(): QueueProfile {
  const cfg = getConfig();
  return {
    id: 'default',
    name: '默认执行档案',
    gptUrl: cfg.gptUrl || '',
    outputDir: PATHS.queueOutputRoot,
    promptTemplate: cfg.promptTemplate || '{content}',
    itemsPerConversation: Number(cfg.chaptersPerConversation || 20),
    minOutputChars: Number(cfg.minOutputChars || 100),
    waitReplyTimeoutMs: Number(cfg.waitReplyTimeoutMs || 180000),
    replyStableMs: Number(cfg.replyStableMs || 2000),
    betweenItemsMs: Number(cfg.betweenChaptersMs || 1500),
    deleteConversationAfterDone: !!cfg.deleteConversationAfterDone,
    maxItemAttempts: Number(cfg.maxItemAttempts || DEFAULT_MAX_ITEM_ATTEMPTS),
    maxConsecutiveFailures: Number(cfg.maxConsecutiveFailures || 3),
    rateLimitWaitMs: Number(cfg.rateLimitWaitMs || 30 * 60 * 1000),
    maxRateLimitWaitMs: Number(cfg.maxRateLimitWaitMs || 2 * 60 * 60 * 1000),
    failurePauseMs: Number(cfg.failurePauseMs || 5 * 60 * 1000),
    contextScope: 'task',
    stageId: '',
  };
}

// ---------- 队列存储 ----------

/** 规范化队列存储 */
function normalizeQueueStore(raw: unknown): QueueStore {
  const now = nowIso();
  const store = raw && typeof raw === 'object' ? (raw as Partial<QueueStore>) : {};
  const profiles: QueueProfile[] = Array.isArray(store.profiles) ? store.profiles : [];
  if (!profiles.length) profiles.push(defaultProfile());
  const haveDefault = profiles.some((p) => p.id === 'default');
  if (!haveDefault) profiles.unshift(defaultProfile());

  for (const p of profiles) {
    p.id = String(p.id || uid('gpts'));
    p.name = String(p.name || '未命名执行档案');
    p.gptUrl = String(p.gptUrl || '');
    p.outputDir = String(p.outputDir || PATHS.queueOutputRoot);
    p.promptTemplate = String(p.promptTemplate || '{content}');
    p.itemsPerConversation = Number(p.itemsPerConversation || 20);
    p.minOutputChars = Number(p.minOutputChars || 100);
    p.waitReplyTimeoutMs = Number(p.waitReplyTimeoutMs || 180000);
    p.replyStableMs = Number(p.replyStableMs || 2000);
    p.betweenItemsMs = Number(p.betweenItemsMs || 1500);
    p.deleteConversationAfterDone = !!p.deleteConversationAfterDone;
    p.maxItemAttempts = Number(p.maxItemAttempts || DEFAULT_MAX_ITEM_ATTEMPTS);
    p.maxConsecutiveFailures = Number(p.maxConsecutiveFailures || 3);
    p.rateLimitWaitMs = Number(p.rateLimitWaitMs || 30 * 60 * 1000);
    p.maxRateLimitWaitMs = Number(p.maxRateLimitWaitMs || 2 * 60 * 60 * 1000);
    p.failurePauseMs = Number(p.failurePauseMs || 5 * 60 * 1000);
    p.contextScope = ['task', 'novel'].includes(p.contextScope) ? p.contextScope : 'task';
    p.stageId = String(p.stageId || '');
  }

  const profileIds = new Set(profiles.map((p) => p.id));
  const items: QueueItem[] = Array.isArray(store.items) ? store.items : [];
  for (const item of items) {
    item.id = String(item.id || uid('item'));
    item.title = String(item.title || '未命名任务');
    item.content = String(item.content || '');
    item.contentHash = item.contentHash || contentHash(item.content);
    item.profileId = profileIds.has(item.profileId) ? item.profileId : profiles[0].id;
    item.status = (
      ['pending', 'running', 'done', 'failed', 'skipped'].includes(item.status)
        ? item.status
        : 'pending'
    ) as QueueItemStatus;
    if (item.status === 'running' && !queueRuntime.running) {
      item.status = 'pending';
      item.lastError = '上次运行中断，已恢复为待执行';
    }
    item.attempts = Number(item.attempts || 0);
    item.createdAt = item.createdAt || now;
    item.updatedAt = item.updatedAt || now;
    item.sourcePath = item.sourcePath || '';
    item.outputPath = item.outputPath || '';
    item.outputChars = Number(item.outputChars || 0);
    item.lastError = item.lastError || '';
    item.errorType = item.errorType || '';
    item.responsePreview = item.responsePreview || '';
  }

  return { version: 1, profiles, items, updatedAt: store.updatedAt || now };
}

/** 加载队列存储 */
export function loadQueueStore(): QueueStore {
  const store = normalizeQueueStore(readJsonWithBackup<QueueStore>(PATHS.queuePath));
  if (!fs.existsSync(PATHS.queuePath)) saveQueueStore(store);
  return store;
}

/** 保存队列存储 */
export function saveQueueStore(store: QueueStore): void {
  store.updatedAt = nowIso();
  atomicWriteJson(PATHS.queuePath, store);
}

/** 获取执行档案 */
export function getQueueProfile(store: QueueStore, id: string): QueueProfile {
  return store.profiles.find((p) => p.id === id) || store.profiles[0] || defaultProfile();
}

/** 队列统计 */
function queueSummary(items: QueueItem[]): QueueSummary {
  const out: QueueSummary = {
    total: items.length,
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    skipped: 0,
  };
  for (const item of items) {
    out[item.status] = (out[item.status] || 0) + 1;
  }
  return out;
}

/** 判断是否重复项 */
function isDuplicateItem(store: QueueStore, item: QueueItem): boolean {
  return store.items.some(
    (x) =>
      x.id !== item.id &&
      x.profileId === item.profileId &&
      x.contentHash === item.contentHash &&
      x.status !== 'failed',
  );
}

/** 创建队列项 */
function makeQueueItem(opts: {
  title: string;
  content: string;
  profileId: string;
  sourcePath?: string;
}): QueueItem {
  const now = nowIso();
  const text = String(opts.content || '');
  return {
    id: uid('item'),
    title: String(opts.title || '未命名任务').trim() || '未命名任务',
    content: text,
    contentHash: contentHash(text),
    profileId: String(opts.profileId || 'default'),
    status: 'pending',
    attempts: 0,
    outputPath: '',
    outputChars: 0,
    responsePreview: '',
    lastError: '',
    errorType: '',
    sourcePath: opts.sourcePath || '',
    createdAt: now,
    updatedAt: now,
  };
}

/** 公开的队列存储（不含完整内容） */
export function publicQueueStore(store: QueueStore = loadQueueStore()): PublicQueueStore {
  const profileMap = new Map(store.profiles.map((p) => [p.id, p]));
  let pendingRank = 0;
  return {
    profiles: store.profiles,
    items: store.items.map((item, index) => {
      const profile = profileMap.get(item.profileId) || store.profiles[0] || defaultProfile();
      const queuePosition =
        item.status === 'running' ? 0 : item.status === 'pending' ? ++pendingRank : null;
      const publicItem: PublicQueueItem = {
        id: item.id,
        index,
        queuePosition,
        title: item.title,
        profileId: item.profileId,
        profileName: profile.name || '默认执行档案',
        status: item.status,
        attempts: item.attempts,
        maxAttempts: Number(profile.maxItemAttempts || DEFAULT_MAX_ITEM_ATTEMPTS),
        sourcePath: item.sourcePath,
        outputPath: item.outputPath,
        outputChars: item.outputChars,
        lastError: item.lastError,
        errorType: item.errorType || '',
        responsePreview: item.responsePreview,
        contentPreview: item.content.slice(0, 220),
        contentChars: item.content.length,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
      return publicItem;
    }),
    summary: queueSummary(store.items),
    runtime: { ...queueRuntime },
    updatedAt: store.updatedAt,
  };
}

/** 队列健康检查 */
export function queueHealth(store: QueueStore = loadQueueStore()): QueueHealth {
  const summary = queueSummary(store.items);
  const staleRunning = store.items.filter(
    (x) => x.status === 'running' && !queueRuntime.running,
  ).length;
  const missingOutputs = store.items.filter(
    (x) => x.status === 'done' && x.outputPath && !fs.existsSync(x.outputPath),
  ).length;
  const invalidProfiles = store.items.filter(
    (x) => !store.profiles.some((p) => p.id === x.profileId),
  ).length;
  const emptyProfileUrls = store.profiles.filter(
    (p) => !String(p.gptUrl || getConfig().gptUrl || '').trim(),
  ).length;
  const cappedFailures = store.items.filter((x) => {
    if (x.status !== 'failed') return false;
    const p = getQueueProfile(store, x.profileId);
    return Number(x.attempts || 0) >= Number(p.maxItemAttempts || DEFAULT_MAX_ITEM_ATTEMPTS);
  }).length;

  const issues: string[] = [];
  if (staleRunning) issues.push(`${staleRunning} 个运行中任务需要恢复`);
  if (missingOutputs) issues.push(`${missingOutputs} 个完成任务缺少输出文件`);
  if (invalidProfiles) issues.push(`${invalidProfiles} 个任务引用了不存在的执行档案`);
  if (emptyProfileUrls) issues.push(`${emptyProfileUrls} 个执行档案缺少入口链接`);
  if (cappedFailures) issues.push(`${cappedFailures} 个失败任务已达到尝试上限`);
  if (queueRuntime.autoPaused && queueRuntime.resumeAt)
    issues.push(`已智能暂停，预计 ${queueRuntime.resumeAt} 自动恢复`);
  if (queueRuntime.lastError) issues.push(queueRuntime.lastError);

  return {
    ok: issues.length === 0,
    issues,
    summary,
    eventLog: {
      path: PATHS.queueEventLog,
      exists: fs.existsSync(PATHS.queueEventLog),
      bytes: safeSize(PATHS.queueEventLog),
    },
    store: {
      path: PATHS.queuePath,
      bytes: safeSize(PATHS.queuePath),
      updatedAt: store.updatedAt,
    },
  };
}

/** 队列计划详情 */
export function queuePlanDetails(store: QueueStore = loadQueueStore(), n = 120): QueuePlanDetails {
  const publicStore = publicQueueStore(store);
  const runnable = publicStore.items
    .filter((x) => ['running', 'pending'].includes(x.status))
    .slice(0, n);
  const failed = publicStore.items.filter((x) => x.status === 'failed').slice(0, Math.min(n, 80));
  const capped = failed.filter(
    (x) => Number(x.attempts || 0) >= Number(x.maxAttempts || DEFAULT_MAX_ITEM_ATTEMPTS),
  );
  return {
    builtAt: nowIso(),
    counts: {
      running: publicStore.summary.running || 0,
      pending: publicStore.summary.pending || 0,
      failed: publicStore.summary.failed || 0,
      capped: capped.length,
    },
    next: runnable.map((x) => ({
      id: x.id,
      queuePosition: x.queuePosition,
      title: x.title,
      profileId: x.profileId,
      profileName: x.profileName,
      status: x.status,
      attempts: x.attempts,
      maxAttempts: x.maxAttempts,
      contentChars: x.contentChars,
      sourcePath: x.sourcePath,
      outputPath: x.outputPath,
      errorType: x.errorType,
      lastError: x.lastError,
      contentPreview: x.contentPreview,
    })),
    failed: failed.map((x) => ({
      id: x.id,
      title: x.title,
      profileName: x.profileName,
      attempts: x.attempts,
      maxAttempts: x.maxAttempts,
      errorType: x.errorType,
      lastError: x.lastError,
      updatedAt: x.updatedAt,
    })),
  };
}

/** 队列项详情 */
export function queueItemDetails(id: string): QueueItemDetails | null {
  const store = loadQueueStore();
  const item = store.items.find((x) => x.id === id);
  if (!item) return null;
  const outputText = item.outputPath ? readText(item.outputPath, '') : '';
  return { item, outputText };
}

/** 更新队列项（保留以备未来扩展使用） */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function updateQueueItem(
  id: string,
  mutator: (item: QueueItem, store: QueueStore) => void,
): QueueItem | null {
  const store = loadQueueStore();
  const item = store.items.find((x) => x.id === id);
  if (!item) return null;
  mutator(item, store);
  item.updatedAt = nowIso();
  saveQueueStore(store);
  return item;
}

/** 绝对输出目录 */
function absoluteOutputDir(profile: QueueProfile): string {
  const out = String(profile.outputDir || PATHS.queueOutputRoot);
  return path.isAbsolute(out) ? out : path.join(PATHS.runnerDir, out);
}

/** 写入队列输出（保留以备未来扩展使用） */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function writeQueueOutput(item: QueueItem, profile: QueueProfile, text: string): string {
  const dir = absoluteOutputDir(profile);
  ensureDir(dir);
  const base = `${safeName(item.title)}_${item.id.slice(-8)}.md`;
  const fp = path.join(dir, base);
  atomicWriteText(fp, text);
  return fp;
}

/** 批量文本拆分 */
function splitBatchText(text: string, separator: string): string[] {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const sep = String(separator || '').trim();
  let parts: string[];
  if (sep && raw.includes(sep)) parts = raw.split(sep);
  else if (/^\s*---+\s*$/m.test(raw)) parts = raw.split(/^\s*---+\s*$/m);
  else if (/\n\s*\n/.test(raw)) parts = raw.split(/\n\s*\n+/);
  else parts = raw.split(/\n+/);
  return parts.map((x) => x.trim()).filter(Boolean);
}

/** 从文件夹导入 */
function importQueueFiles(folder: string, profileId: string, recursive = false): QueueItem[] {
  const out: QueueItem[] = [];
  const exts = new Set(['.txt', '.md']);
  const walk = (dir: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const ent of entries) {
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (recursive) walk(fp);
        continue;
      }
      if (!ent.isFile() || !exts.has(path.extname(ent.name).toLowerCase())) continue;
      const content = readText(fp, '');
      if (!content.trim()) continue;
      out.push(
        makeQueueItem({
          title: path.basename(ent.name, path.extname(ent.name)),
          content,
          profileId,
          sourcePath: fp,
        }),
      );
      if (out.length >= QUEUE_IMPORT_LIMIT) return;
    }
  };
  walk(folder);
  return out;
}

/** 错误分类 */
export function classifyQueueError(err: unknown): QueueErrorType {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /政策|使用政策|内容政策|policy|refus|无法协助|不能协助|不能提供|can't assist|cannot assist/i.test(
      msg,
    )
  )
    return 'policy_refusal';
  if (/登录|log.?in|sign.?in|unauthorized/i.test(msg)) return 'login_required';
  if (/captcha|验证|真人/i.test(msg)) return 'captcha_required';
  if (/配额|rate|usage limit|limit|上限|too many|429/i.test(msg)) return 'rate_limited';
  if (/超时|timeout/i.test(msg)) return 'timeout';
  if (/回复过短|too short/i.test(msg)) return 'invalid_reply';
  if (/输入框|composer|selector/i.test(msg)) return 'composer_unavailable';
  if (/closed|Target page|browser/i.test(msg)) return 'browser_closed';
  return 'unknown';
}

// ---------- 队列动作（CRUD） ----------

type Body = Record<string, unknown>;

/** 处理队列动作 */
export function handleQueueAction(body: Body): ApiResult & Partial<PublicQueueStore> {
  const action = String(body.action || '');
  const store = loadQueueStore();
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  const touch = (item: QueueItem): void => {
    item.updatedAt = nowIso();
  };

  switch (action) {
    case 'addItem': {
      const item = makeQueueItem({
        title: String(body.title || ''),
        content: String(body.content || ''),
        profileId: String(body.profileId || 'default'),
      });
      if (!item.content.trim()) return { ok: false, msg: '内容不能为空' };
      if (isDuplicateItem(store, item))
        return { ok: false, msg: '同一执行档案里已存在相同内容，已阻止重复加入' };
      store.items.push(item);
      appendQueueEvent('item_added', {
        itemId: item.id,
        title: item.title,
        chars: item.content.length,
      });
      break;
    }
    case 'addBatch': {
      const parts = splitBatchText(String(body.text || ''), String(body.separator || ''));
      const prefix = String(body.titlePrefix || '批量任务').trim() || '批量任务';
      const added: QueueItem[] = [];
      let skipped = 0;
      for (const [i, content] of parts.entries()) {
        const item = makeQueueItem({
          title: `${prefix} ${String(i + 1).padStart(3, '0')}`,
          content,
          profileId: String(body.profileId || 'default'),
        });
        if (isDuplicateItem({ ...store, items: [...store.items, ...added] }, item)) {
          skipped++;
          continue;
        }
        added.push(item);
      }
      store.items.push(...added);
      saveQueueStore(store);
      appendQueueEvent('batch_added', { count: added.length, skipped, prefix });
      return {
        ok: true,
        msg: `已加入 ${added.length} 条任务${skipped ? `，跳过重复 ${skipped} 条` : ''}`,
        ...publicQueueStore(store),
      };
    }
    case 'importFolder': {
      const folder = String(body.folder || '');
      if (!folder || !fs.existsSync(folder)) return { ok: false, msg: '文件夹不存在' };
      const imported = importQueueFiles(
        folder,
        String(body.profileId || 'default'),
        !!body.recursive,
      );
      const added: QueueItem[] = [];
      let skipped = 0;
      for (const item of imported) {
        if (isDuplicateItem({ ...store, items: [...store.items, ...added] }, item)) {
          skipped++;
          continue;
        }
        added.push(item);
      }
      store.items.push(...added);
      saveQueueStore(store);
      appendQueueEvent('folder_imported', {
        count: added.length,
        skipped,
        folder,
        recursive: !!body.recursive,
      });
      return {
        ok: true,
        msg: `已从文件夹导入 ${added.length} 条任务${skipped ? `，跳过重复 ${skipped} 条` : ''}`,
        ...publicQueueStore(store),
      };
    }
    case 'updateItem': {
      const item = store.items.find((x) => x.id === String(body.id || ''));
      if (!item) return { ok: false, msg: '任务不存在' };
      const patch = (body.patch && typeof body.patch === 'object' ? body.patch : {}) as Record<
        string,
        unknown
      >;
      if ('title' in patch) item.title = String(patch.title || '').trim() || item.title;
      if ('content' in patch) {
        item.content = String(patch.content || '');
        item.contentHash = contentHash(item.content);
      }
      if ('profileId' in patch && store.profiles.some((p) => p.id === patch.profileId))
        item.profileId = String(patch.profileId);
      if (isDuplicateItem(store, item))
        return { ok: false, msg: '同一执行档案里已存在相同内容，未保存重复任务' };
      touch(item);
      appendQueueEvent('item_updated', { itemId: item.id, title: item.title });
      break;
    }
    case 'deleteItems':
      store.items = store.items.filter((x) => !ids.includes(x.id) || x.status === 'running');
      appendQueueEvent('items_deleted', { count: ids.length });
      break;
    case 'resetItems':
      for (const item of store.items) {
        if (ids.includes(item.id) && item.status !== 'running') {
          item.status = 'pending';
          item.lastError = '';
          touch(item);
        }
      }
      store.items.sort((a, b) => {
        const ap = ids.includes(a.id) && a.status === 'pending' ? 1 : 0;
        const bp = ids.includes(b.id) && b.status === 'pending' ? 1 : 0;
        return bp - ap;
      });
      appendQueueEvent('items_reset', { count: ids.length });
      break;
    case 'retryFailed': {
      const retry: QueueItem[] = [];
      const rest: QueueItem[] = [];
      for (const item of store.items) {
        if (item.status === 'failed') {
          item.status = 'pending';
          item.lastError = '';
          touch(item);
          retry.push(item);
        } else {
          rest.push(item);
        }
      }
      store.items = [...retry, ...rest];
      appendQueueEvent('failed_retried', { count: retry.length, priority: 'front' });
      break;
    }
    case 'skipItems':
      for (const item of store.items) {
        if (ids.includes(item.id) && item.status !== 'running') {
          item.status = 'skipped';
          touch(item);
        }
      }
      appendQueueEvent('items_skipped', { count: ids.length });
      break;
    case 'clearDone':
      store.items = store.items.filter((x) => !['done', 'skipped'].includes(x.status));
      appendQueueEvent('done_cleared', {});
      break;
    case 'moveItem': {
      const idx = store.items.findIndex((x) => x.id === String(body.id || ''));
      if (idx < 0) return { ok: false, msg: '任务不存在' };
      const [item] = store.items.splice(idx, 1);
      const dir = String(body.dir || '');
      if (dir === 'top') store.items.unshift(item);
      else if (dir === 'bottom') store.items.push(item);
      else if (dir === 'up') store.items.splice(Math.max(0, idx - 1), 0, item);
      else if (dir === 'down') store.items.splice(Math.min(store.items.length, idx + 1), 0, item);
      else store.items.splice(idx, 0, item);
      appendQueueEvent('item_moved', { itemId: item.id, dir });
      break;
    }
    case 'saveProfile': {
      const p = (body.profile && typeof body.profile === 'object' ? body.profile : {}) as Record<
        string,
        unknown
      >;
      const id = String(p.id || uid('gpts'));
      const next: QueueProfile = {
        id,
        name: String(p.name || '未命名执行档案'),
        gptUrl: String(p.gptUrl || ''),
        outputDir: String(p.outputDir || PATHS.queueOutputRoot),
        promptTemplate: String(p.promptTemplate || '{content}'),
        itemsPerConversation: Number(p.itemsPerConversation || 20),
        minOutputChars: Number(p.minOutputChars || 100),
        waitReplyTimeoutMs: Number(p.waitReplyTimeoutMs || 180000),
        replyStableMs: Number(p.replyStableMs || 2000),
        betweenItemsMs: Number(p.betweenItemsMs || 1500),
        deleteConversationAfterDone: !!p.deleteConversationAfterDone,
        maxItemAttempts: Number(p.maxItemAttempts || DEFAULT_MAX_ITEM_ATTEMPTS),
        maxConsecutiveFailures: Number(p.maxConsecutiveFailures || 3),
        rateLimitWaitMs: Number(p.rateLimitWaitMs || 30 * 60 * 1000),
        maxRateLimitWaitMs: Number(p.maxRateLimitWaitMs || 2 * 60 * 60 * 1000),
        failurePauseMs: Number(p.failurePauseMs || 5 * 60 * 1000),
        contextScope: ['task', 'novel'].includes(p.contextScope as string)
          ? (p.contextScope as 'task' | 'novel')
          : 'task',
        stageId: String(p.stageId || ''),
      };
      const idx = store.profiles.findIndex((x) => x.id === id);
      if (idx >= 0) store.profiles[idx] = next;
      else store.profiles.push(next);
      saveQueueStore(store);
      appendQueueEvent('profile_saved', { profileId: id, name: next.name });
      return { ok: true, msg: '执行档案已保存', savedProfileId: id, ...publicQueueStore(store) };
    }
    case 'deleteProfile': {
      const id = String(body.id || '');
      if (id === 'default') return { ok: false, msg: '默认执行档案不能删除' };
      store.profiles = store.profiles.filter((p) => p.id !== id);
      for (const item of store.items) if (item.profileId === id) item.profileId = 'default';
      appendQueueEvent('profile_deleted', { profileId: id });
      break;
    }
    default:
      return { ok: false, msg: '未知队列动作: ' + action };
  }

  saveQueueStore(store);
  return { ok: true, msg: '队列已更新', ...publicQueueStore(store) };
}

// ---------- 队列控制（状态机，简化版） ----------

/**
 * 处理队列控制动作。
 * 简化版：只更新运行时状态，不实际驱动 Chrome 执行。
 */
export function handleQueueControl(body: Body): ApiResult & Partial<PublicQueueStore> {
  const action = String(body.action || '');

  if (action === 'start') {
    if (!loadQueueStore().items.some((x) => x.status === 'pending'))
      return { ok: false, msg: '没有待执行任务', ...publicQueueStore() };
    // 简化版：标记为运行中，但不实际连接 Chrome
    queueRuntime.runId = uid('run');
    queueRuntime.running = true;
    queueRuntime.paused = false;
    queueRuntime.stopRequested = false;
    queueRuntime.phase = 'idle';
    queueRuntime.startedAt = nowIso();
    queueRuntime.heartbeatAt = queueRuntime.startedAt;
    queueRuntime.lastTransitionAt = queueRuntime.startedAt;
    queueRuntime.processed = 0;
    queueRuntime.succeeded = 0;
    queueRuntime.failed = 0;
    queueRuntime.consecutiveFailures = 0;
    queueRuntime.autoPaused = false;
    queueRuntime.resumeAt = '';
    queueRuntime.pauseReason = '';
    queueRuntime.limitHint = '';
    queueRuntime.message = '队列已开始（简化模式：需外部 runner 驱动执行）';
    queueRuntime.lastError = '';
    appendQueueEvent('control_start', {});
    return { ok: true, msg: '队列已开始运行', ...publicQueueStore() };
  }

  if (action === 'pause') {
    queueRuntime.paused = true;
    appendQueueEvent('control_pause', {});
    return { ok: true, msg: '已暂停：当前条完成后停在下一条前', ...publicQueueStore() };
  }

  if (action === 'resume') {
    if (!queueRuntime.running && !loadQueueStore().items.some((x) => x.status === 'pending'))
      return { ok: false, msg: '没有待执行任务', ...publicQueueStore() };
    queueRuntime.paused = false;
    queueRuntime.autoPaused = false;
    queueRuntime.resumeAt = '';
    queueRuntime.pauseReason = '';
    queueRuntime.limitHint = '';
    if (!queueRuntime.running) {
      queueRuntime.running = true;
      queueRuntime.runId = uid('run');
      queueRuntime.startedAt = nowIso();
      queueRuntime.heartbeatAt = queueRuntime.startedAt;
      queueRuntime.message = '队列已继续（简化模式）';
    }
    appendQueueEvent('control_resume', {});
    return { ok: true, msg: '队列已继续', ...publicQueueStore() };
  }

  if (action === 'stop') {
    queueRuntime.stopRequested = true;
    queueRuntime.paused = false;
    queueRuntime.autoPaused = false;
    appendQueueEvent('control_stop', {});
    return { ok: true, msg: '已请求停止：当前条完成后停止', ...publicQueueStore() };
  }

  return { ok: false, msg: '未知队列控制: ' + action };
}

/** 获取队列运行时状态（供健康检查用） */
export function getQueueRuntime(): QueueRuntime {
  return { ...queueRuntime };
}

/** 获取心跳年龄（秒） */
export function heartbeatAgeSec(): number | null {
  if (!queueRuntime.heartbeatAt) return null;
  return Math.round((Date.now() - Date.parse(queueRuntime.heartbeatAt)) / 1000);
}
