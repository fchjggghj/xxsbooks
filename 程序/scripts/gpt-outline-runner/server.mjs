// 本项目控制中心 · 后端（零依赖：只用 node 内置模块 + 复用本项目 lib/）。
// 启动：node server.mjs   或   npm run web   然后浏览器开 http://localhost:8787
//
// 能力：
//   监控   —— 进度/速度/ETA、守护&Runner&Chrome 在线状态、run.log/daemon.log 时间线、每本进度、失败列表。
//   队列   —— 队列预览（dry-run 计划）：接下来要发哪些章、每本待处理。
//   配置   —— 在线读写 config.json（执行端入口、输入/输出文件夹、选择规则、执行行为、超时重试…全部）。
//   控制   —— 启动调试 Chrome、启动/停止守护任务、优雅停止(STOP)/恢复、重新扫描、重试失败、打开文件夹、干跑。
//
// 只绑 127.0.0.1，仅本机可访问。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { listNovels, listChapters, isDone, isSkipped, skipMarkerPath, readSkipMarker, isSoftFail, buildPlan } from './lib/files.mjs';
import { selectForNovel } from './lib/select.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(__dirname, 'config.json');
let cfg = loadConfig();
const PORT = Number(process.env.WEB_PORT || cfg.webPort || 8787); // 改 webPort 需重启服务

const RUN_LOG = path.join(__dirname, 'run.log');
const DAEMON_LOG = path.join(__dirname, 'daemon.log');
const RUN_LOCK = path.join(__dirname, '.run.lock');
const DAEMON_LOCK = path.join(__dirname, '.daemon.lock');
const STOP_FILE = path.join(__dirname, 'STOP');
const QUEUE_PATH = path.join(__dirname, 'prompt-queue.json');
const QUEUE_OUTPUT_ROOT = path.join(__dirname, 'prompt-queue-output');
const QUEUE_EVENT_LOG = path.join(__dirname, 'prompt-queue-events.jsonl');
const REQUEST_BODY_LIMIT = 4 * 1024 * 1024;
const EVENT_LOG_MAX_BYTES = 2 * 1024 * 1024;
const QUEUE_IMPORT_LIMIT = 5000;
const DEFAULT_MAX_ITEM_ATTEMPTS = 3;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_FAILURE_PAUSE_MS = 5 * 60 * 1000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 2 * 60 * 60 * 1000;

let queueLoopPromise = null;
const queueRuntime = {
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

function loadConfig() { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8').replace(/^﻿/, '')); }
function taskName() { return cfg.scheduledTaskName || 'GptOutlineRunner'; }
function cdpPort() { const m = String(cfg.cdpUrl || '').match(/:(\d+)/); return m ? m[1] : '9222'; }

// ---------- 小工具 ----------
function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}
function readText(file, fallback = '') { try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; } }
function readJson(file) { try { return JSON.parse(readText(file).replace(/^﻿/, '')); } catch { return null; } }
function nowIso() { return new Date().toISOString(); }
function uid(prefix = 'q') { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function atomicWriteText(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch {
    // 备份失败不阻止主写入；原子替换仍能保证文件不半截。
  }
  fs.renameSync(tmp, file);
}
function atomicWriteJson(file, obj) { atomicWriteText(file, JSON.stringify(obj, null, 2)); }
function readJsonWithBackup(file) {
  const main = readJson(file);
  if (main) return main;
  const backup = readJson(`${file}.bak`);
  if (backup) return backup;
  return null;
}
function safeName(s, fallback = 'item') {
  const v = String(s || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  return (v || fallback).slice(0, 96);
}
function contentHash(s) { return crypto.createHash('sha1').update(String(s || ''), 'utf8').digest('hex'); }
function isDuplicateItem(store, item) {
  return store.items.some((x) => x.id !== item.id && x.profileId === item.profileId && x.contentHash === item.contentHash && x.status !== 'failed');
}
function trimEventPayload(payload = {}) {
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v == null) continue;
    if (typeof v === 'string') out[k] = v.length > 500 ? v.slice(0, 500) + '...' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = JSON.parse(JSON.stringify(v));
  }
  return out;
}
function rotateEventLogIfNeeded() {
  try {
    if (fs.existsSync(QUEUE_EVENT_LOG) && fs.statSync(QUEUE_EVENT_LOG).size > EVENT_LOG_MAX_BYTES) {
      const bak = QUEUE_EVENT_LOG.replace(/\.jsonl$/, '.1.jsonl');
      try { fs.existsSync(bak) && fs.unlinkSync(bak); } catch {}
      fs.renameSync(QUEUE_EVENT_LOG, bak);
    }
  } catch {}
}
function appendQueueEvent(type, payload = {}) {
  try {
    rotateEventLogIfNeeded();
    const ev = {
      ts: nowIso(),
      type,
      runId: queueRuntime.runId || '',
      phase: queueRuntime.phase,
      activeId: queueRuntime.activeId || '',
      ...trimEventPayload(payload),
    };
    fs.appendFileSync(QUEUE_EVENT_LOG, JSON.stringify(ev) + '\n', 'utf8');
  } catch {
    // 事件日志不能反过来拖垮队列运行。
  }
}
function readQueueEvents(n = 120) {
  const raw = tailFile(QUEUE_EVENT_LOG, 256 * 1024).split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of raw.slice(-n)) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}
function setQueuePhase(phase, message, extra = {}) {
  queueRuntime.phase = phase;
  queueRuntime.message = message || queueRuntime.message;
  queueRuntime.heartbeatAt = nowIso();
  queueRuntime.lastTransitionAt = queueRuntime.heartbeatAt;
  if (extra.activeId !== undefined) queueRuntime.activeId = extra.activeId;
  if (extra.activeTitle !== undefined) queueRuntime.activeTitle = extra.activeTitle;
  if (extra.activeProfileId !== undefined) queueRuntime.activeProfileId = extra.activeProfileId;
  if (extra.activeProfileName !== undefined) queueRuntime.activeProfileName = extra.activeProfileName;
}

// ---------- 脚本任务队列 ----------
function defaultProfile() {
  return {
    id: 'default',
    name: '默认执行档案',
    gptUrl: cfg.gptUrl || '',
    outputDir: QUEUE_OUTPUT_ROOT,
    promptTemplate: cfg.promptTemplate || '{content}',
    itemsPerConversation: Number(cfg.chaptersPerConversation || 20),
    minOutputChars: Number(cfg.minOutputChars || 100),
    waitReplyTimeoutMs: Number(cfg.waitReplyTimeoutMs || 180000),
    replyStableMs: Number(cfg.replyStableMs || 2000),
    betweenItemsMs: Number(cfg.betweenChaptersMs || 1500),
    deleteConversationAfterDone: !!cfg.deleteConversationAfterDone,
    maxItemAttempts: Number(cfg.maxItemAttempts || DEFAULT_MAX_ITEM_ATTEMPTS),
    maxConsecutiveFailures: Number(cfg.maxConsecutiveFailures || DEFAULT_MAX_CONSECUTIVE_FAILURES),
    rateLimitWaitMs: Number(cfg.rateLimitWaitMs || DEFAULT_RATE_LIMIT_WAIT_MS),
    maxRateLimitWaitMs: Number(cfg.maxRateLimitWaitMs || DEFAULT_MAX_RATE_LIMIT_WAIT_MS),
    failurePauseMs: Number(cfg.failurePauseMs || DEFAULT_FAILURE_PAUSE_MS),
    contextScope: 'task',
  };
}
function normalizeQueueStore(raw) {
  const now = nowIso();
  const store = raw && typeof raw === 'object' ? raw : {};
  const profiles = Array.isArray(store.profiles) ? store.profiles : [];
  if (!profiles.length) profiles.push(defaultProfile());
  const haveDefault = profiles.some((p) => p.id === 'default');
  if (!haveDefault) profiles.unshift(defaultProfile());
  for (const p of profiles) {
    p.id = String(p.id || uid('gpts'));
    p.name = String(p.name || '未命名执行档案');
    p.gptUrl = String(p.gptUrl || '');
    p.outputDir = String(p.outputDir || QUEUE_OUTPUT_ROOT);
    p.promptTemplate = String(p.promptTemplate || '{content}');
    p.itemsPerConversation = Number(p.itemsPerConversation || p.chaptersPerConversation || cfg.chaptersPerConversation || 20);
    p.minOutputChars = Number(p.minOutputChars || cfg.minOutputChars || 100);
    p.waitReplyTimeoutMs = Number(p.waitReplyTimeoutMs || cfg.waitReplyTimeoutMs || 180000);
    p.replyStableMs = Number(p.replyStableMs || cfg.replyStableMs || 2000);
    p.betweenItemsMs = Number(p.betweenItemsMs || cfg.betweenChaptersMs || 1500);
    p.deleteConversationAfterDone = !!p.deleteConversationAfterDone;
    p.maxItemAttempts = Number(p.maxItemAttempts || cfg.maxItemAttempts || DEFAULT_MAX_ITEM_ATTEMPTS);
    p.maxConsecutiveFailures = Number(p.maxConsecutiveFailures || cfg.maxConsecutiveFailures || DEFAULT_MAX_CONSECUTIVE_FAILURES);
    p.rateLimitWaitMs = Number(p.rateLimitWaitMs || cfg.rateLimitWaitMs || DEFAULT_RATE_LIMIT_WAIT_MS);
    p.maxRateLimitWaitMs = Number(p.maxRateLimitWaitMs || cfg.maxRateLimitWaitMs || DEFAULT_MAX_RATE_LIMIT_WAIT_MS);
    p.failurePauseMs = Number(p.failurePauseMs || cfg.failurePauseMs || DEFAULT_FAILURE_PAUSE_MS);
    p.contextScope = ['task', 'novel'].includes(p.contextScope) ? p.contextScope : 'task';
    p.stageId = String(p.stageId || '');
  }
  const profileIds = new Set(profiles.map((p) => p.id));
  const items = Array.isArray(store.items) ? store.items : [];
  for (const item of items) {
    item.id = String(item.id || uid('item'));
    item.title = String(item.title || '未命名任务');
    item.content = String(item.content || '');
    item.contentHash = item.contentHash || contentHash(item.content);
    item.profileId = profileIds.has(item.profileId) ? item.profileId : profiles[0].id;
    item.status = ['pending', 'running', 'done', 'failed', 'skipped'].includes(item.status) ? item.status : 'pending';
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
function loadQueueStore() {
  const store = normalizeQueueStore(readJsonWithBackup(QUEUE_PATH));
  if (!fs.existsSync(QUEUE_PATH)) saveQueueStore(store);
  return store;
}
function saveQueueStore(store) {
  store.updatedAt = nowIso();
  atomicWriteJson(QUEUE_PATH, store);
}
function queueSummary(items) {
  const out = { total: items.length, pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const item of items) out[item.status] = (out[item.status] || 0) + 1;
  return out;
}
function publicQueueStore(store = loadQueueStore()) {
  const profileMap = new Map(store.profiles.map((p) => [p.id, p]));
  let pendingRank = 0;
  return {
    profiles: store.profiles,
    items: store.items.map((item, index) => {
      const profile = profileMap.get(item.profileId) || store.profiles[0] || defaultProfile();
      const queuePosition = item.status === 'running' ? 0 : (item.status === 'pending' ? ++pendingRank : null);
      return {
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
    }),
    summary: queueSummary(store.items),
    runtime: { ...queueRuntime },
    updatedAt: store.updatedAt,
  };
}
function queueHealth(store = loadQueueStore()) {
  const summary = queueSummary(store.items);
  const staleRunning = store.items.filter((x) => x.status === 'running' && !queueRuntime.running).length;
  const missingOutputs = store.items.filter((x) => x.status === 'done' && x.outputPath && !fs.existsSync(x.outputPath)).length;
  const invalidProfiles = store.items.filter((x) => !store.profiles.some((p) => p.id === x.profileId)).length;
  const emptyProfileUrls = store.profiles.filter((p) => !String(p.gptUrl || cfg.gptUrl || '').trim()).length;
  const cappedFailures = store.items.filter((x) => {
    if (x.status !== 'failed') return false;
    const p = getQueueProfile(store, x.profileId);
    return Number(x.attempts || 0) >= Number(p.maxItemAttempts || DEFAULT_MAX_ITEM_ATTEMPTS);
  }).length;
  const issues = [];
  if (staleRunning) issues.push(`${staleRunning} 个运行中任务需要恢复`);
  if (missingOutputs) issues.push(`${missingOutputs} 个完成任务缺少输出文件`);
  if (invalidProfiles) issues.push(`${invalidProfiles} 个任务引用了不存在的执行档案`);
  if (emptyProfileUrls) issues.push(`${emptyProfileUrls} 个执行档案缺少入口链接`);
  if (cappedFailures) issues.push(`${cappedFailures} 个失败任务已达到尝试上限`);
  if (queueRuntime.autoPaused && queueRuntime.resumeAt) issues.push(`已智能暂停，预计 ${queueRuntime.resumeAt} 自动恢复`);
  if (queueRuntime.lastError) issues.push(queueRuntime.lastError);
  return {
    ok: issues.length === 0,
    issues,
    summary,
    eventLog: { path: QUEUE_EVENT_LOG, exists: fs.existsSync(QUEUE_EVENT_LOG), bytes: safeSize(QUEUE_EVENT_LOG) },
    store: { path: QUEUE_PATH, bytes: safeSize(QUEUE_PATH), updatedAt: store.updatedAt },
  };
}
function queuePlanDetails(store = loadQueueStore(), n = 120) {
  const publicStore = publicQueueStore(store);
  const runnable = publicStore.items
    .filter((x) => ['running', 'pending'].includes(x.status))
    .slice(0, n);
  const failed = publicStore.items
    .filter((x) => x.status === 'failed')
    .slice(0, Math.min(n, 80));
  const capped = failed.filter((x) => Number(x.attempts || 0) >= Number(x.maxAttempts || DEFAULT_MAX_ITEM_ATTEMPTS));
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
function queueItemDetails(id) {
  const store = loadQueueStore();
  const item = store.items.find((x) => x.id === id);
  if (!item) return null;
  const outputText = item.outputPath ? readText(item.outputPath, '') : '';
  return { item, outputText };
}
function getQueueProfile(store, id) {
  return store.profiles.find((p) => p.id === id) || store.profiles[0] || defaultProfile();
}
function absoluteOutputDir(profile) {
  const out = String(profile.outputDir || QUEUE_OUTPUT_ROOT);
  return path.isAbsolute(out) ? out : path.join(__dirname, out);
}
function itemNovelKey(item) {
  const source = String(item?.sourcePath || '');
  if (source && cfg.libraryRoot) {
    try {
      const rel = path.relative(cfg.libraryRoot, source);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        const first = rel.split(/[\\/]+/).filter(Boolean)[0];
        if (first) return first;
      }
    } catch {}
  }
  if (source) {
    const parent = path.basename(path.dirname(source));
    if (parent) return parent;
  }
  return String(item?.title || item?.id || 'manual');
}
function makeQueueItem({ title, content, profileId, sourcePath = '' }) {
  const now = nowIso();
  const text = String(content || '');
  return {
    id: uid('item'),
    title: String(title || '未命名任务').trim() || '未命名任务',
    content: text,
    contentHash: contentHash(text),
    profileId: String(profileId || 'default'),
    status: 'pending',
    attempts: 0,
    outputPath: '',
    outputChars: 0,
    responsePreview: '',
    lastError: '',
    sourcePath,
    createdAt: now,
    updatedAt: now,
  };
}
function splitBatchText(text, separator) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const sep = String(separator || '').trim();
  let parts;
  if (sep && raw.includes(sep)) parts = raw.split(sep);
  else if (/^\s*---+\s*$/m.test(raw)) parts = raw.split(/^\s*---+\s*$/m);
  else if (/\n\s*\n/.test(raw)) parts = raw.split(/\n\s*\n+/);
  else parts = raw.split(/\n+/);
  return parts.map((x) => x.trim()).filter(Boolean);
}
function importQueueFiles(folder, profileId, recursive = false) {
  const out = [];
  const exts = new Set(['.txt', '.md']);
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const ent of entries) {
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (recursive) walk(fp); continue; }
      if (!ent.isFile() || !exts.has(path.extname(ent.name).toLowerCase())) continue;
      const content = readText(fp, '');
      if (!content.trim()) continue;
      out.push(makeQueueItem({ title: path.basename(ent.name, path.extname(ent.name)), content, profileId, sourcePath: fp }));
      if (out.length >= QUEUE_IMPORT_LIMIT) return;
    }
  };
  walk(folder);
  return out;
}
function updateQueueItem(id, mutator) {
  const store = loadQueueStore();
  const item = store.items.find((x) => x.id === id);
  if (!item) return null;
  mutator(item, store);
  item.updatedAt = nowIso();
  saveQueueStore(store);
  return item;
}
function writeQueueOutput(item, profile, text) {
  const dir = absoluteOutputDir(profile);
  ensureDir(dir);
  const base = `${safeName(item.title)}_${item.id.slice(-8)}.md`;
  const fp = path.join(dir, base);
  atomicWriteText(fp, text);
  return fp;
}
function classifyQueueError(err) {
  const msg = String(err?.message || err || '');
  if (/政策|使用政策|内容政策|policy|refus|无法协助|不能协助|不能提供|can't assist|cannot assist/i.test(msg)) return 'policy_refusal';
  if (/登录|log.?in|sign.?in|unauthorized/i.test(msg)) return 'login_required';
  if (/captcha|验证|真人/i.test(msg)) return 'captcha_required';
  if (/配额|rate|usage limit|limit|上限|too many|429/i.test(msg)) return 'rate_limited';
  if (/超时|timeout/i.test(msg)) return 'timeout';
  if (/回复过短|too short/i.test(msg)) return 'invalid_reply';
  if (/输入框|composer|selector/i.test(msg)) return 'composer_unavailable';
  if (/closed|Target page|browser/i.test(msg)) return 'browser_closed';
  return 'unknown';
}
function isPolicyRefusalText(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return s.length < 1200 && /政策|使用政策|内容政策|无法协助|不能协助|不能提供|can't assist|cannot assist|not able to help|policy/i.test(s);
}
function boundedMs(value, fallback, maxValue = 24 * 60 * 60 * 1000) {
  const n = Number(value);
  const ms = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.max(1000, Math.min(ms, maxValue));
}
function smartRateLimitWaitMs(info, runCfg) {
  const fallback = boundedMs(runCfg.rateLimitWaitMs, DEFAULT_RATE_LIMIT_WAIT_MS);
  const maxWait = boundedMs(runCfg.maxRateLimitWaitMs, DEFAULT_MAX_RATE_LIMIT_WAIT_MS, 24 * 60 * 60 * 1000);
  return boundedMs(info?.resetMs, fallback, maxWait);
}
function handleQueueAction(body) {
  const action = String(body?.action || '');
  const store = loadQueueStore();
  const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
  const touch = (item) => { item.updatedAt = nowIso(); };
  switch (action) {
    case 'addItem': {
      const item = makeQueueItem({ title: body.title, content: body.content, profileId: body.profileId });
      if (!item.content.trim()) return { ok: false, msg: '内容不能为空' };
      if (isDuplicateItem(store, item)) return { ok: false, msg: '同一执行档案里已存在相同内容，已阻止重复加入' };
      store.items.push(item);
      appendQueueEvent('item_added', { itemId: item.id, title: item.title, chars: item.content.length });
      break;
    }
    case 'addBatch': {
      const parts = splitBatchText(body.text, body.separator);
      const prefix = String(body.titlePrefix || '批量任务').trim() || '批量任务';
      const added = [];
      let skipped = 0;
      for (const [i, content] of parts.entries()) {
        const item = makeQueueItem({ title: `${prefix} ${String(i + 1).padStart(3, '0')}`, content, profileId: body.profileId });
        if (isDuplicateItem({ ...store, items: [...store.items, ...added] }, item)) { skipped++; continue; }
        added.push(item);
      }
      store.items.push(...added);
      saveQueueStore(store);
      appendQueueEvent('batch_added', { count: added.length, skipped, prefix });
      return { ok: true, msg: `已加入 ${added.length} 条任务${skipped ? `，跳过重复 ${skipped} 条` : ''}`, ...publicQueueStore(store) };
    }
    case 'importFolder': {
      const folder = String(body.folder || '');
      if (!folder || !fs.existsSync(folder)) return { ok: false, msg: '文件夹不存在' };
      const imported = importQueueFiles(folder, body.profileId, !!body.recursive);
      const added = [];
      let skipped = 0;
      for (const item of imported) {
        if (isDuplicateItem({ ...store, items: [...store.items, ...added] }, item)) { skipped++; continue; }
        added.push(item);
      }
      store.items.push(...added);
      saveQueueStore(store);
      appendQueueEvent('folder_imported', { count: added.length, skipped, folder, recursive: !!body.recursive });
      return { ok: true, msg: `已从文件夹导入 ${added.length} 条任务${skipped ? `，跳过重复 ${skipped} 条` : ''}`, ...publicQueueStore(store) };
    }
    case 'updateItem': {
      const item = store.items.find((x) => x.id === String(body.id || ''));
      if (!item) return { ok: false, msg: '任务不存在' };
      const patch = body.patch && typeof body.patch === 'object' ? body.patch : {};
      if ('title' in patch) item.title = String(patch.title || '').trim() || item.title;
      if ('content' in patch) { item.content = String(patch.content || ''); item.contentHash = contentHash(item.content); }
      if ('profileId' in patch && store.profiles.some((p) => p.id === patch.profileId)) item.profileId = patch.profileId;
      if (isDuplicateItem(store, item)) return { ok: false, msg: '同一执行档案里已存在相同内容，未保存重复任务' };
      touch(item);
      appendQueueEvent('item_updated', { itemId: item.id, title: item.title });
      break;
    }
    case 'deleteItems':
      store.items = store.items.filter((x) => !ids.includes(x.id) || x.status === 'running');
      appendQueueEvent('items_deleted', { count: ids.length });
      break;
    case 'resetItems':
      for (const item of store.items) if (ids.includes(item.id) && item.status !== 'running') { item.status = 'pending'; item.lastError = ''; touch(item); }
      store.items.sort((a, b) => {
        const ap = ids.includes(a.id) && a.status === 'pending' ? 1 : 0;
        const bp = ids.includes(b.id) && b.status === 'pending' ? 1 : 0;
        return bp - ap;
      });
      appendQueueEvent('items_reset', { count: ids.length });
      break;
    case 'retryFailed':
      {
        const retry = [];
        const rest = [];
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
      }
      break;
    case 'skipItems':
      for (const item of store.items) if (ids.includes(item.id) && item.status !== 'running') { item.status = 'skipped'; touch(item); }
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
      const p = body.profile && typeof body.profile === 'object' ? body.profile : {};
      const id = String(p.id || uid('gpts'));
      const next = {
        id,
        name: String(p.name || '未命名执行档案'),
        gptUrl: String(p.gptUrl || ''),
        outputDir: String(p.outputDir || QUEUE_OUTPUT_ROOT),
        promptTemplate: String(p.promptTemplate || '{content}'),
        itemsPerConversation: Number(p.itemsPerConversation || 20),
        minOutputChars: Number(p.minOutputChars || 100),
        waitReplyTimeoutMs: Number(p.waitReplyTimeoutMs || cfg.waitReplyTimeoutMs || 180000),
        replyStableMs: Number(p.replyStableMs || cfg.replyStableMs || 2000),
        betweenItemsMs: Number(p.betweenItemsMs || cfg.betweenChaptersMs || 1500),
        deleteConversationAfterDone: !!p.deleteConversationAfterDone,
        maxItemAttempts: Number(p.maxItemAttempts || cfg.maxItemAttempts || DEFAULT_MAX_ITEM_ATTEMPTS),
        maxConsecutiveFailures: Number(p.maxConsecutiveFailures || cfg.maxConsecutiveFailures || DEFAULT_MAX_CONSECUTIVE_FAILURES),
        rateLimitWaitMs: Number(p.rateLimitWaitMs || cfg.rateLimitWaitMs || DEFAULT_RATE_LIMIT_WAIT_MS),
        maxRateLimitWaitMs: Number(p.maxRateLimitWaitMs || cfg.maxRateLimitWaitMs || DEFAULT_MAX_RATE_LIMIT_WAIT_MS),
        failurePauseMs: Number(p.failurePauseMs || cfg.failurePauseMs || DEFAULT_FAILURE_PAUSE_MS),
        contextScope: ['task', 'novel'].includes(p.contextScope) ? p.contextScope : 'task',
        stageId: String(p.stageId || ''),
      };
      const idx = store.profiles.findIndex((x) => x.id === id);
      if (idx >= 0) store.profiles[idx] = next; else store.profiles.push(next);
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
function queueRunConfig(profile) {
  return {
    ...cfg,
    gptUrl: profile.gptUrl || cfg.gptUrl,
    promptTemplate: profile.promptTemplate || '{content}',
    chaptersPerConversation: Number(profile.itemsPerConversation || cfg.chaptersPerConversation || 20),
    minOutputChars: Number(profile.minOutputChars || cfg.minOutputChars || 100),
    waitReplyTimeoutMs: Number(profile.waitReplyTimeoutMs || cfg.waitReplyTimeoutMs || 180000),
    replyStableMs: Number(profile.replyStableMs || cfg.replyStableMs || 2000),
    betweenChaptersMs: Number(profile.betweenItemsMs || cfg.betweenChaptersMs || 1500),
    deleteConversationAfterDone: !!profile.deleteConversationAfterDone,
    maxItemAttempts: Number(profile.maxItemAttempts || cfg.maxItemAttempts || DEFAULT_MAX_ITEM_ATTEMPTS),
    maxConsecutiveFailures: Number(profile.maxConsecutiveFailures || cfg.maxConsecutiveFailures || DEFAULT_MAX_CONSECUTIVE_FAILURES),
    rateLimitWaitMs: Number(profile.rateLimitWaitMs || cfg.rateLimitWaitMs || DEFAULT_RATE_LIMIT_WAIT_MS),
    maxRateLimitWaitMs: Number(profile.maxRateLimitWaitMs || cfg.maxRateLimitWaitMs || DEFAULT_MAX_RATE_LIMIT_WAIT_MS),
    failurePauseMs: Number(profile.failurePauseMs || cfg.failurePauseMs || DEFAULT_FAILURE_PAUSE_MS),
    contextScope: ['task', 'novel'].includes(profile.contextScope) ? profile.contextScope : 'task',
  };
}
async function autoPauseQueue(cg, waitMs, reason, payload = {}) {
  const ms = boundedMs(waitMs, DEFAULT_FAILURE_PAUSE_MS, 24 * 60 * 60 * 1000);
  const resumeAt = new Date(Date.now() + ms).toISOString();
  queueRuntime.paused = true;
  queueRuntime.autoPaused = true;
  queueRuntime.resumeAt = resumeAt;
  queueRuntime.pauseReason = reason;
  queueRuntime.limitHint = payload.hint || '';
  appendQueueEvent('auto_paused', { reason, waitMs: ms, resumeAt, ...payload });
  const end = Date.now() + ms;
  while (!queueRuntime.stopRequested && queueRuntime.autoPaused && queueRuntime.paused && Date.now() < end) {
    const left = Math.max(0, end - Date.now());
    const mins = Math.max(1, Math.ceil(left / 60000));
    setQueuePhase('auto_paused', `${reason}，约 ${mins} 分钟后自动继续`);
    await cg.sleep(Math.min(5000, Math.max(1000, left)));
  }
  if (!queueRuntime.stopRequested) {
    queueRuntime.paused = false;
    queueRuntime.autoPaused = false;
    queueRuntime.resumeAt = '';
    queueRuntime.pauseReason = '';
    queueRuntime.limitHint = '';
    appendQueueEvent('auto_resumed', { reason });
    setQueuePhase('resuming', '自动恢复队列');
  }
}
async function runPromptQueue() {
  const cg = await import('./lib/chatgpt.mjs');
  const runId = uid('run');
  queueRuntime.runId = runId;
  queueRuntime.running = true;
  queueRuntime.paused = false;
  queueRuntime.stopRequested = false;
  queueRuntime.phase = 'starting';
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
  queueRuntime.message = '连接 Chrome...';
  queueRuntime.lastError = '';
  appendQueueEvent('run_started', { runId });
  let page = null;
  let currentProfileId = '';
  let currentConversationKey = '';
  let countInConversation = 0;
  try {
    setQueuePhase('connecting_browser', '连接 Chrome...');
    ({ page } = await cg.connect(cfg));
    appendQueueEvent('browser_connected', { url: page.url?.() || '' });
    while (!queueRuntime.stopRequested) {
      while (queueRuntime.paused && !queueRuntime.stopRequested) {
        setQueuePhase('paused', '已暂停');
        await cg.sleep(600);
      }
      if (queueRuntime.stopRequested) break;
      const store = loadQueueStore();
      let item = null;
      if (currentProfileId && currentConversationKey) {
        const currentProfile = getQueueProfile(store, currentProfileId);
        const currentCfg = queueRunConfig(currentProfile);
        if (currentCfg.contextScope === 'novel') {
          item = store.items.find((x) => x.status === 'pending' && x.profileId === currentProfileId && itemNovelKey(x) === currentConversationKey);
        }
      }
      if (!item) item = store.items.find((x) => x.status === 'pending');
      if (!item) {
        setQueuePhase('idle', '没有待执行任务', { activeId: '', activeTitle: '', activeProfileId: '', activeProfileName: '' });
        break;
      }
      const profile = getQueueProfile(store, item.profileId);
      const runCfg = queueRunConfig(profile);
      const conversationKey = runCfg.contextScope === 'novel' ? itemNovelKey(item) : '';
      const conversationLimit = runCfg.contextScope === 'novel' ? Number.MAX_SAFE_INTEGER : runCfg.chaptersPerConversation;
      if (!runCfg.gptUrl) throw new Error(`执行档案「${profile.name}」没有入口链接`);
      if (currentProfileId !== profile.id || currentConversationKey !== conversationKey || countInConversation >= conversationLimit) {
        const suffix = conversationKey ? ` / ${conversationKey}` : '';
        setQueuePhase('opening_gpts', `打开执行端：${profile.name}${suffix}`, { activeProfileId: profile.id, activeProfileName: profile.name });
        await cg.newConversation(page, runCfg);
        currentProfileId = profile.id;
        currentConversationKey = conversationKey;
        countInConversation = 0;
      }
      updateQueueItem(item.id, (x) => {
        x.status = 'running';
        x.attempts = Number(x.attempts || 0) + 1;
        x.lastError = '';
      });
      setQueuePhase('sending', `提交：${item.title}`, { activeId: item.id, activeTitle: item.title, activeProfileId: profile.id, activeProfileName: profile.name });
      appendQueueEvent('item_started', { itemId: item.id, title: item.title, profileId: profile.id, profileName: profile.name, attempt: item.attempts + 1 });
      try {
        const prompt = String(runCfg.promptTemplate || '{content}').replaceAll('{content}', item.content);
        runCfg.onStatus = (st = {}) => setQueuePhase(st.phase || queueRuntime.phase, st.message || queueRuntime.message, {
          activeId: item.id,
          activeTitle: item.title,
          activeProfileId: profile.id,
          activeProfileName: profile.name,
        });
        const { text, timedOut } = await cg.sendAndCollect(page, prompt, runCfg);
        const minChars = Number(runCfg.minOutputChars || 100);
        if (timedOut) throw new Error('等待输出超时');
        if (isPolicyRefusalText(text)) throw new Error('policy_refusal: 执行端返回内容政策拒绝');
        if (!text || text.trim().length < minChars) throw new Error(`输出过短（${(text || '').trim().length}/${minChars} 字）`);
        setQueuePhase('saving_output', `保存输出：${item.title}`);
        const outputPath = writeQueueOutput(item, profile, text.trim());
        updateQueueItem(item.id, (x) => {
          x.status = 'done';
          x.outputPath = outputPath;
          x.outputChars = text.trim().length;
          x.responsePreview = text.trim().slice(0, 220);
          x.lastError = '';
        });
        countInConversation++;
        queueRuntime.processed++;
        queueRuntime.succeeded++;
        queueRuntime.consecutiveFailures = 0;
        setQueuePhase('item_done', `完成：${item.title}`);
        appendQueueEvent('item_done', { itemId: item.id, title: item.title, outputPath, outputChars: text.trim().length });
        if (runCfg.deleteConversationAfterDone && runCfg.contextScope !== 'novel') {
          setQueuePhase('deleting_conversation', `清理执行记录：${item.title}`);
          try {
            const del = await cg.deleteCurrentConversation(page);
            appendQueueEvent(del.ok ? 'conversation_deleted' : 'conversation_delete_failed', {
              itemId: item.id,
              title: item.title,
              step: del.step || '',
              message: del.message || '',
              beforeUrl: del.beforeUrl || '',
              afterUrl: del.afterUrl || '',
            });
          } catch (cleanupErr) {
            appendQueueEvent('conversation_delete_failed', { itemId: item.id, title: item.title, error: String(cleanupErr?.message || cleanupErr) });
          }
          currentProfileId = '';
          countInConversation = 0;
        }
        await cg.sleep(Number(runCfg.betweenChaptersMs || 1000));
      } catch (err) {
        const errorType = classifyQueueError(err);
        const attempts = Number(item.attempts || 0) + 1;
        const maxAttempts = Number(runCfg.maxItemAttempts || DEFAULT_MAX_ITEM_ATTEMPTS);
        const errMsg = String(err?.message || err);
        if (errorType === 'policy_refusal') {
          updateQueueItem(item.id, (x) => {
            x.status = 'skipped';
            x.lastError = '政策拒绝，已备注放弃';
            x.errorType = errorType;
          });
        } else if (errorType === 'rate_limited') {
          let info = { limited: true, resetMs: null, hint: '' };
          try { info = await cg.rateLimitInfo(page); } catch {}
          const waitMs = smartRateLimitWaitMs(info, runCfg);
          const resumeAt = new Date(Date.now() + waitMs).toISOString();
          updateQueueItem(item.id, (x) => {
            x.status = 'pending';
            x.lastError = `触发上限，预计 ${resumeAt} 后自动重试`;
            x.errorType = errorType;
          });
          queueRuntime.lastError = info?.hint || errMsg;
          queueRuntime.consecutiveFailures++;
          setQueuePhase('rate_limited', `触发上限：${item.title}`);
          appendQueueEvent('item_deferred_rate_limit', { itemId: item.id, title: item.title, waitMs, resumeAt, hint: info?.hint || errMsg });
          currentProfileId = '';
          countInConversation = 0;
          await autoPauseQueue(cg, waitMs, '触发执行端/账号上限，智能等待恢复', { itemId: item.id, title: item.title, hint: info?.hint || errMsg });
          continue;
        } else {
          updateQueueItem(item.id, (x) => {
            x.status = 'failed';
            x.lastError = attempts >= maxAttempts ? `${errMsg}；已达到尝试上限 ${maxAttempts}` : errMsg;
            x.errorType = errorType;
          });
        }
        queueRuntime.processed++;
        if (errorType !== 'policy_refusal') queueRuntime.failed++;
        if (errorType !== 'policy_refusal') queueRuntime.consecutiveFailures++;
        else queueRuntime.consecutiveFailures = 0;
        queueRuntime.lastError = errMsg;
        setQueuePhase(errorType === 'policy_refusal' ? 'item_skipped' : 'item_failed', `${errorType === 'policy_refusal' ? '放弃' : '失败'}：${item.title}`);
        appendQueueEvent(errorType === 'policy_refusal' ? 'item_skipped_policy' : 'item_failed', { itemId: item.id, title: item.title, errorType, attempts, maxAttempts, error: queueRuntime.lastError });
        countInConversation = 0;
        const maxFailures = Number(runCfg.maxConsecutiveFailures || DEFAULT_MAX_CONSECUTIVE_FAILURES);
        if (errorType !== 'policy_refusal' && maxFailures > 0 && queueRuntime.consecutiveFailures >= maxFailures) {
          const waitMs = boundedMs(runCfg.failurePauseMs, DEFAULT_FAILURE_PAUSE_MS);
          await autoPauseQueue(cg, waitMs, `连续失败 ${queueRuntime.consecutiveFailures} 次，智能暂停`, { title: item.title, errorType });
          queueRuntime.consecutiveFailures = 0;
        }
      }
    }
  } catch (err) {
    queueRuntime.lastError = String(err?.message || err);
    setQueuePhase('fatal_error', '队列运行出错');
    appendQueueEvent('run_failed', { errorType: classifyQueueError(err), error: queueRuntime.lastError });
  } finally {
    queueRuntime.running = false;
    queueRuntime.paused = false;
    queueRuntime.stopRequested = false;
    queueRuntime.autoPaused = false;
    queueRuntime.resumeAt = '';
    queueRuntime.pauseReason = '';
    queueRuntime.limitHint = '';
    queueRuntime.activeId = null;
    queueRuntime.activeTitle = '';
    queueRuntime.activeProfileId = '';
    queueRuntime.activeProfileName = '';
    if (!queueRuntime.lastError && queueRuntime.message !== '没有待执行任务') setQueuePhase('stopped', '队列已停止');
    appendQueueEvent('run_stopped', { runId, processed: queueRuntime.processed, succeeded: queueRuntime.succeeded, failed: queueRuntime.failed, message: queueRuntime.message });
  }
}
function handleQueueControl(body) {
  const action = String(body?.action || '');
  if (action === 'start') {
    if (!loadQueueStore().items.some((x) => x.status === 'pending')) return { ok: false, msg: '没有待执行任务', ...publicQueueStore() };
    if (!queueLoopPromise) queueLoopPromise = runPromptQueue().finally(() => { queueLoopPromise = null; });
    appendQueueEvent('control_start', {});
    return { ok: true, msg: '队列已开始运行', ...publicQueueStore() };
  }
  if (action === 'pause') {
    queueRuntime.paused = true;
    appendQueueEvent('control_pause', {});
    return { ok: true, msg: '已暂停：当前条完成后停在下一条前', ...publicQueueStore() };
  }
  if (action === 'resume') {
    if (!queueRuntime.running && !loadQueueStore().items.some((x) => x.status === 'pending')) return { ok: false, msg: '没有待执行任务', ...publicQueueStore() };
    queueRuntime.paused = false;
    queueRuntime.autoPaused = false;
    queueRuntime.resumeAt = '';
    queueRuntime.pauseReason = '';
    queueRuntime.limitHint = '';
    if (!queueLoopPromise) queueLoopPromise = runPromptQueue().finally(() => { queueLoopPromise = null; });
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

function tailFile(file, maxBytes = 96 * 1024) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    let s = buf.toString('utf8');
    if (start > 0) { const i = s.indexOf('\n'); if (i >= 0) s = s.slice(i + 1); }
    return s;
  } catch { return ''; }
}

// ---------- 日志解析 ----------
const RE_TS = /^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/;
function parseRunLine(raw) {
  const m = raw.match(RE_TS);
  if (!m) return null;
  const [, time, body] = m;
  const ev = { time, kind: 'info', text: body };
  let mm;
  if ((mm = body.match(/^✓\s*(\S+?\.txt)\s*->\s*(\S+?\.md)（(\d+)\s*字）(.*)$/))) {
    ev.kind = 'ok'; ev.chapter = mm[1]; ev.out = mm[2]; ev.chars = Number(mm[3]); ev.note = mm[4]?.trim() || '';
  } else if ((mm = body.match(/^✗\s*(\S+?\.txt)?\s*[:：]?\s*(.*)$/))) {
    ev.kind = 'fail'; ev.chapter = mm[1] || ''; ev.reason = mm[2] || body;
  } else if (body.startsWith('↻')) { ev.kind = 'retry'; }
  else if (body.startsWith('⚠')) { ev.kind = 'warn'; }
  else if ((mm = body.match(/开始小说[:：]\s*(.+?)（待处理\s*(\d+)/))) { ev.kind = 'book'; ev.book = mm[1]; ev.pending = Number(mm[2]); }
  else if (/换新对话续发本书剩余/.test(body)) { ev.kind = 'rotate'; }
  return ev;
}
function parseRunLog(n = 300) {
  const lines = tailFile(RUN_LOG).split(/\r?\n/).filter(Boolean);
  const events = [];
  for (const ln of lines) { const ev = parseRunLine(ln); if (ev) events.push(ev); }
  return events.slice(-n);
}
function parseDaemonLog(n = 120) {
  const lines = tailFile(DAEMON_LOG).split(/\r?\n/).filter(Boolean);
  return lines.slice(-n).map((ln) => {
    const m = ln.match(/^\[([\d-]+ [\d:]+)\]\s*(.*)$/);
    return m ? { time: m[1], text: m[2] } : { time: '', text: ln };
  });
}
function speedFromEvents(events) {
  const secs = [];
  for (const ev of events) {
    if (ev.kind !== 'ok') continue;
    const [h, m, s] = ev.time.split(':').map(Number);
    secs.push(h * 3600 + m * 60 + s);
  }
  const deltas = [];
  for (let i = 1; i < secs.length; i++) {
    let d = secs[i] - secs[i - 1];
    if (d < 0) d += 86400;
    if (d > 0 && d <= 300) deltas.push(d);
  }
  const recent = deltas.slice(-30);
  const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
  return { avgSecPerChapter: avg, samples: recent.length };
}

// ---------- 全库扫描（带缓存）----------
function blankTier() { return { books: 0, selected: 0, done: 0, failed: 0, pending: 0 }; }
let scanCache = null, scanInFlight = null;
const SCAN_TTL = 60_000;
async function doScan() {
  const novels = listNovels(cfg.libraryRoot, cfg.novels);
  const books = [], failures = [];
  const tiers = { big: blankTier(), small: blankTier(), nodata: blankTier() };
  let totalChapters = 0, selectedTotal = 0, doneTotal = 0, failedTotal = 0, pendingTotal = 0;
  for (let i = 0; i < novels.length; i++) {
    const novel = novels[i];
    const chapters = listChapters(novel, cfg);
    const { tier, selected } = selectForNovel(novel, chapters, cfg);
    let done = 0, failed = 0, pending = 0, firstPending = null;
    for (const ch of selected) {
      if (isSoftFail(ch, cfg)) {
        pending++;
        if (!firstPending) firstPending = ch.name;
        const mk = readSkipMarker(ch);
        failures.push({ book: novel.name, chapter: ch.name, reason: mk?.reason || 'soft_fail', attempts: mk?.attempts || 0, retryable: true, createdAt: mk?.createdAt || null, outputPath: ch.outputPath });
      } else if (isSkipped(ch)) {
        failed++;
        const mk = readJson(skipMarkerPath(ch));
        failures.push({ book: novel.name, chapter: ch.name, reason: mk?.reason || 'unknown', attempts: mk?.attempts || 0, retryable: false, createdAt: mk?.createdAt || null, outputPath: ch.outputPath });
      } else if (isDone(ch, cfg)) { done++; }
      else { pending++; if (!firstPending) firstPending = ch.name; }
    }
    totalChapters += chapters.length; selectedTotal += selected.length;
    doneTotal += done; failedTotal += failed; pendingTotal += pending;
    const t = tiers[tier];
    t.books++; t.selected += selected.length; t.done += done; t.failed += failed; t.pending += pending;
    books.push({ name: novel.name, tier, readers: novel.readers, total: chapters.length, selected: selected.length, done, failed, pending, firstPending });
    if (i % 5 === 4) await new Promise((r) => setImmediate(r));
  }
  return { scannedAt: Date.now(), totals: { novels: novels.length, chapters: totalChapters, selected: selectedTotal, done: doneTotal, failed: failedTotal, pending: pendingTotal }, tiers, books, failures };
}
async function getScan(force = false) {
  const fresh = scanCache && Date.now() - scanCache.scannedAt < SCAN_TTL;
  if (fresh && !force) return scanCache;
  if (!scanInFlight) scanInFlight = doScan().then((s) => { scanCache = s; scanInFlight = null; return s; }, (e) => { scanInFlight = null; throw e; });
  if (scanCache && !force) { scanInFlight.catch(() => {}); return scanCache; }
  return scanInFlight;
}

// ---------- 队列预览（dry-run 计划，含待发章节名）----------
let planCache = null, planInFlight = null;
const PLAN_TTL = 60_000;
async function doPlan() {
  const { plan, totalNovels, totalChapters, selectedChapters, pendingChapters, retryPending } = buildPlan(cfg);
  const perBook = [];
  const queue = [];
  for (const p of plan) {
    if (!p.selected.length) continue;
    perBook.push({
      name: p.novel.name, tier: p.tier, readers: p.novel.readers,
      selected: p.selected.length, pending: p.pending.length, done: p.selected.length - p.pending.length,
      retryPending: p.softCount || 0,
      next: p.pending.slice(0, 12).map((c) => c.name),
    });
    if (queue.length < 500) {
      for (const c of p.pending) {
        const mk = readSkipMarker(c);
        queue.push({
          book: p.novel.name,
          chapter: c.name,
          tier: p.tier,
          input: c.inputPath,
          priority: isSoftFail(c, cfg) ? 'retry' : 'normal',
          attempts: mk?.attempts || 0,
          reason: mk?.reason || '',
        });
        if (queue.length >= 500) break;
      }
    }
    await new Promise((r) => setImmediate(r));
  }
  return { builtAt: Date.now(), totals: { novels: totalNovels, chapters: totalChapters, selected: selectedChapters, pending: pendingChapters, retryPending }, perBook, queue };
}
async function getPlan(force = false) {
  const fresh = planCache && Date.now() - planCache.builtAt < PLAN_TTL;
  if (fresh && !force) return planCache;
  if (!planInFlight) planInFlight = doPlan().then((p) => { planCache = p; planInFlight = null; return p; }, (e) => { planInFlight = null; throw e; });
  if (planCache && !force) { planInFlight.catch(() => {}); return planCache; }
  return planInFlight;
}
function invalidateCaches() { scanCache = null; planCache = null; }

// ---------- 状态 ----------
function safeMtime(file) { try { return fs.statSync(file).mtimeMs; } catch { return null; } }
function safeSize(file) { try { return fs.statSync(file).size; } catch { return 0; } }
function statusSnapshot(events) {
  const runLock = readJson(RUN_LOCK);
  const runnerAlive = !!(runLock && processAlive(runLock.pid));
  const daemonPid = readText(DAEMON_LOCK).match(/pid=(\d+)/)?.[1];
  const daemonAlive = !!(daemonPid && processAlive(daemonPid));
  const stop = fs.existsSync(STOP_FILE);
  let lastOkTime = null, activeBook = null, lastEvent = null, rateLimited = false;
  for (const ev of events) {
    if (ev.kind === 'book') activeBook = ev.book;
    if (ev.kind === 'ok') { lastOkTime = ev.time; rateLimited = false; }
    if (ev.kind === 'warn' && /配额墙/.test(ev.text)) rateLimited = true;
    lastEvent = ev;
  }
  return { runnerAlive, runnerPid: runLock?.pid || null, daemonAlive, daemonPid: daemonPid ? Number(daemonPid) : null, stop, activeBook, lastOkTime, lastEvent, rateLimited, runLogMtime: safeMtime(RUN_LOG) };
}
function chromeStatus() {
  return new Promise((resolve) => {
    const url = (cfg.cdpUrl || 'http://localhost:9222').replace(/\/$/, '') + '/json/version';
    const req = http.get(url, { timeout: 2500 }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { try { const j = JSON.parse(d); resolve({ up: true, browser: j.Browser || '' }); } catch { resolve({ up: res.statusCode === 200 }); } });
    });
    req.on('error', () => resolve({ up: false }));
    req.on('timeout', () => { req.destroy(); resolve({ up: false }); });
  });
}

function isAllowedChatGptUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    const host = u.hostname.toLowerCase();
    return (u.protocol === 'https:' || u.protocol === 'http:') && (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com');
  } catch {
    return false;
  }
}

async function withChatGptPage(fn) {
  const cg = await import('./lib/chatgpt.mjs');
  const { page } = await cg.connect(cfg);
  return await fn(cg, page);
}

async function chatGptWorkbenchSnapshot() {
  return await withChatGptPage(async (cg, page) => {
    const state = await cg.inspectWorkbenchState(page);
    return { ok: true, state };
  });
}

async function handleChatGptAction(body = {}) {
  const action = String(body.action || '');
  return await withChatGptPage(async (cg, page) => {
    let result = { ok: true };
    if (action === 'refresh') {
      result = { ok: true };
    } else if (action === 'reloadPage') {
      result = { ok: true, state: await cg.reloadCurrentPage(page) };
    } else if (action === 'back') {
      result = { ok: true, state: await cg.goBack(page) };
    } else if (action === 'forward') {
      result = { ok: true, state: await cg.goForward(page) };
    } else if (action === 'openHome' || action === 'newChat') {
      result = { ok: true, state: await cg.openNewChat(page) };
    } else if (action === 'openCreateGpt') {
      result = { ok: true, state: await cg.openGptBuilder(page) };
    } else if (action === 'openExploreGpts') {
      result = { ok: true, state: await cg.openExploreGpts(page) };
    } else if (action === 'openLibrary') {
      result = { ok: true, state: await cg.openLibrary(page) };
    } else if (action === 'openSettings') {
      result = await cg.openSettings(page);
    } else if (action === 'openModelMenu') {
      result = await cg.openModelMenu(page);
    } else if (action === 'selectModel') {
      result = await cg.selectVisibleModel(page, body.modelName);
    } else if (action === 'openUrl' || action === 'openConversation' || action === 'openGpt') {
      const target = String(body.url || '');
      if (!isAllowedChatGptUrl(target)) return { ok: false, msg: '只允许打开 chatgpt.com / chat.openai.com 链接' };
      result = { ok: true, state: await cg.openUrl(page, target) };
    } else if (action === 'openProfile') {
      const store = loadQueueStore();
      const profile = getQueueProfile(store, body.profileId || 'default');
      const target = String(profile.gptUrl || cfg.gptUrl || '');
      if (!isAllowedChatGptUrl(target)) return { ok: false, msg: '该执行档案没有有效入口链接' };
      result = { ok: true, state: await cg.openUrl(page, target) };
    } else if (action === 'draft') {
      const ok = await cg.setComposerText(page, String(body.message || ''));
      result = { ok, msg: ok ? '已写入输入框，尚未提交' : '写入输入框失败' };
    } else if (action === 'clearComposer') {
      const ok = await cg.clearComposer(page);
      result = { ok, msg: ok ? '已清空网站聊天框' : '未找到可清空的聊天框' };
    } else if (action === 'stopGenerating') {
      result = await cg.stopGenerating(page);
    } else if (action === 'copyLastAssistant') {
      result = await cg.copyLastAssistant(page);
    } else if (action === 'send') {
      const message = String(body.message || '');
      if (!message.trim()) return { ok: false, msg: '消息不能为空' };
      const runCfg = { ...cfg, waitReplyTimeoutMs: Number(body.waitReplyTimeoutMs || cfg.waitReplyTimeoutMs || 180000), replyStableMs: Number(cfg.replyStableMs || 2000) };
      const reply = await cg.sendAndCollect(page, message, runCfg);
      result = { ok: !reply.timedOut, msg: reply.timedOut ? '输出等待超时，已返回当前抓到的内容' : '已提交并收到输出', reply };
    } else if (action === 'uploadFiles') {
      const files = Array.isArray(body.files) ? body.files.map(String).filter(Boolean) : [];
      const missing = files.filter((fp) => !fs.existsSync(fp));
      if (missing.length) return { ok: false, msg: `文件不存在: ${missing[0]}` };
      result = await cg.uploadFiles(page, files);
    } else if (action === 'deleteCurrentConversation') {
      result = await cg.deleteCurrentConversation(page);
    } else if (action === 'saveCurrentGptProfile') {
      const state = await cg.inspectWorkbenchState(page);
      if (!/\/g\//.test(state.url || '')) return { ok: false, msg: '当前页面不是可保存的执行端入口，无法保存为档案' };
      const store = loadQueueStore();
      const name = String(body.name || state.pageHeading || state.title || '当前执行端').slice(0, 80);
      let profile = store.profiles.find((p) => p.gptUrl === state.url);
      if (!profile) {
        profile = { ...defaultProfile(), id: uid('gpts'), name, gptUrl: state.url };
        store.profiles.push(profile);
      } else {
        profile.name = name;
        profile.gptUrl = state.url;
      }
      saveQueueStore(store);
      appendQueueEvent('profile_saved_from_site', { profileId: profile.id, name, url: state.url });
      result = { ok: true, msg: '已保存当前入口为队列执行档案', savedProfileId: profile.id };
    } else {
      return { ok: false, msg: '未知执行端动作: ' + action };
    }
    const state = result.state || await cg.inspectWorkbenchState(page).catch(() => null);
    return { ...result, state };
  });
}

// ---------- 文件夹浏览（只读，供配置里挑路径）----------
function listDrives() {
  const out = [];
  for (let c = 67; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { if (fs.existsSync(d)) out.push(d); } catch {} }
  return out;
}
function browseDir(p) {
  if (!p) return { path: '', parent: null, dirs: listDrives() };
  try {
    const dirs = fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort((a, b) => a.localeCompare(b, 'zh'));
    const parent = path.dirname(p) === p ? '' : path.dirname(p);
    return { path: p, parent, dirs };
  } catch (e) { return { path: p, parent: path.dirname(p), dirs: [], error: String(e?.message || e) }; }
}

// ---------- 控制动作 ----------
function runSchtasks(args) {
  return new Promise((resolve) => execFile('schtasks', args, { windowsHide: true }, (err, out, errout) => resolve({ ok: !err, out: (out || '') + (errout || '') })));
}
function spawnDetached(cmd, args, opts = {}) { try { const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts }); p.unref(); return true; } catch { return false; } }
function findChrome() {
  const cands = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
  return cands.find((c) => fs.existsSync(c)) || null;
}
function nodeRun(args) {
  return new Promise((resolve) => execFile(process.execPath, args, { cwd: __dirname, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 180000 }, (err, out, errout) => resolve({ ok: !err, out: (out || '') + (errout || ''), err: err?.message })));
}

async function doControl(action, body) {
  switch (action) {
    case 'stop':
      fs.writeFileSync(STOP_FILE, new Date().toISOString());
      return { ok: true, msg: '已写 STOP：runner 跑完当前章后退出。' };
    case 'resume': {
      try { fs.existsSync(STOP_FILE) && fs.unlinkSync(STOP_FILE); } catch {}
      const r = await runSchtasks(['/Run', '/TN', taskName()]);
      return { ok: true, msg: r.ok ? '已删 STOP 并启动计划任务。' : `已删 STOP；启动计划任务失败：${r.out.trim() || '未知'}` };
    }
    case 'startTask': { const r = await runSchtasks(['/Run', '/TN', taskName()]); return { ok: r.ok, msg: r.ok ? '已启动守护计划任务。' : (r.out.trim() || '启动失败') }; }
    case 'stopTask': { const r = await runSchtasks(['/End', '/TN', taskName()]); return { ok: r.ok, msg: r.ok ? '已停止守护计划任务的当前实例。' : (r.out.trim() || '停止失败') }; }
    case 'launchChrome': {
      const chrome = findChrome();
      if (!chrome) return { ok: false, msg: '未找到 chrome.exe（改 launch-chrome.ps1 里的路径）。' };
      // 已去掉 --disable-extensions：让油猴(Tampermonkey)等保活扩展正常加载。
      const ok = spawnDetached(chrome, [`--remote-debugging-port=${cdpPort()}`, '--user-data-dir=C:\\chrome-automation', cfg.gptUrl || 'https://chatgpt.com/'], { windowsHide: false });
      return { ok, msg: ok ? `已启动执行浏览器（端口 ${cdpPort()}）。首次需在该窗口完成目标页面登录。` : '启动 Chrome 失败。' };
    }
    case 'rescan': invalidateCaches(); await getScan(true); return { ok: true, msg: '已重新扫描素材库。' };
    case 'dryRun': { const r = await nodeRun(['run.mjs', '--dry-run']); return { ok: r.ok, msg: r.ok ? '干跑完成。' : ('干跑出错：' + (r.err || '')), out: r.out }; }
    case 'retry': {
      const p = String(body?.outputPath || '');
      if (!p || !p.startsWith(cfg.libraryRoot)) return { ok: false, msg: '路径不合法' };
      try { fs.existsSync(p + '.skip.json') && fs.unlinkSync(p + '.skip.json'); } catch (e) { return { ok: false, msg: String(e?.message || e) }; }
      invalidateCaches(); getScan(true).catch(() => {});
      return { ok: true, msg: '已删除失败标记，断点续传将重做该章。' };
    }
    case 'retryAll': {
      const scan = await getScan(true);
      let n = 0;
      for (const f of scan.failures) { try { fs.existsSync(f.outputPath + '.skip.json') && (fs.unlinkSync(f.outputPath + '.skip.json'), n++); } catch {} }
      invalidateCaches(); getScan(true).catch(() => {});
      return { ok: true, msg: `已清除 ${n} 个失败标记，断点续传将重做。` };
    }
    case 'openFolder': {
      let p = String(body?.path || cfg.libraryRoot || '');
      if (!p) return { ok: false, msg: '无路径' };
      spawnDetached('explorer.exe', [p]);
      return { ok: true, msg: '已在资源管理器打开。' };
    }
    default: return { ok: false, msg: '未知动作: ' + action };
  }
}

// ---------- 配置保存 ----------
function validateConfig(c) {
  if (!c || typeof c !== 'object') return '不是对象';
  if (typeof c.libraryRoot !== 'string' || !c.libraryRoot.trim()) return 'libraryRoot 不能为空';
  if (typeof c.gptUrl !== 'string') return 'gptUrl 必须是字符串';
  if (!Array.isArray(c.novels)) return 'novels 必须是数组';
  return null;
}
function saveConfig(next) {
  const err = validateConfig(next);
  if (err) return { ok: false, msg: '配置无效：' + err };
  try {
    fs.copyFileSync(CFG_PATH, CFG_PATH.replace(/\.json$/, '.bak.json'));
    fs.writeFileSync(CFG_PATH, JSON.stringify(next, null, 2), 'utf8');
    cfg = loadConfig();
    invalidateCaches();
    getScan(true).catch(() => {});
    return { ok: true, msg: '已保存 config.json（旧版本备份为 config.bak.json）。下一轮 runner 自动生效。' };
  } catch (e) { return { ok: false, msg: '写入失败：' + String(e?.message || e) }; }
}

// ---------- HTTP ----------
function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    req.setEncoding('utf8'); // 按 UTF-8 解码，避免多字节中文跨分块被截断
    let d = ''; req.on('data', (c) => {
      d += c;
      if (d.length > REQUEST_BODY_LIMIT) {
        req.destroy();
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
async function healthSnapshot() {
  const store = loadQueueStore();
  const chrome = await chromeStatus();
  const health = queueHealth(store);
  const mem = process.memoryUsage();
  const heartbeatAgeSec = queueRuntime.heartbeatAt ? Math.round((Date.now() - Date.parse(queueRuntime.heartbeatAt)) / 1000) : null;
  return {
    ok: health.ok && (!queueRuntime.running || heartbeatAgeSec == null || heartbeatAgeSec < 120),
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    chrome,
    queue: health,
    runtime: { ...queueRuntime, heartbeatAgeSec },
    recentEvents: readQueueEvents(30),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') {
      const html = readText(path.join(__dirname, 'web', 'index.html'), '<h1>web/index.html 缺失</h1>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (p === '/api/state') {
      const events = parseRunLog(300);
      const scan = await getScan(false);
      return sendJson(res, 200, {
        status: statusSnapshot(events), totals: scan.totals, tiers: scan.tiers,
        speed: speedFromEvents(events), scanAgeSec: Math.round((Date.now() - scan.scannedAt) / 1000),
        config: { libraryRoot: cfg.libraryRoot, outputDir: cfg.outputDir, chaptersPerConversation: cfg.chaptersPerConversation, bigThreshold: cfg.selection?.bigThreshold, taskName: taskName(), gptUrl: cfg.gptUrl, pipelineStages: cfg.pipelineStages || [] },
      });
    }
    if (p === '/api/chrome') return sendJson(res, 200, await chromeStatus());
    if (p === '/api/health') return sendJson(res, 200, await healthSnapshot());
    if (p === '/api/chatgpt/workbench' && req.method === 'GET') return sendJson(res, 200, await chatGptWorkbenchSnapshot());
    if (p === '/api/log') {
      const which = url.searchParams.get('which') || 'run';
      const n = Math.min(1000, Number(url.searchParams.get('n')) || 250);
      if (which === 'daemon') return sendJson(res, 200, { daemon: parseDaemonLog(n) });
      const events = parseRunLog(n);
      return sendJson(res, 200, { events, speed: speedFromEvents(events) });
    }
    if (p === '/api/books') { const scan = await getScan(false); return sendJson(res, 200, { books: scan.books, scanAgeSec: Math.round((Date.now() - scan.scannedAt) / 1000) }); }
    if (p === '/api/failures') { const scan = await getScan(false); return sendJson(res, 200, { failures: scan.failures }); }
    if (p === '/api/plan') { const force = url.searchParams.get('force') === '1'; const plan = await getPlan(force); return sendJson(res, 200, { ...plan, ageSec: Math.round((Date.now() - plan.builtAt) / 1000) }); }
    if (p === '/api/prompt-queue' && req.method === 'GET') return sendJson(res, 200, publicQueueStore());
    if (p === '/api/prompt-queue/events' && req.method === 'GET') {
      const n = Math.min(500, Math.max(1, Number(url.searchParams.get('n')) || 120));
      return sendJson(res, 200, { events: readQueueEvents(n) });
    }
    if (p === '/api/prompt-queue/plan' && req.method === 'GET') {
      const n = Math.min(500, Math.max(1, Number(url.searchParams.get('n')) || 120));
      return sendJson(res, 200, queuePlanDetails(loadQueueStore(), n));
    }
    if (p === '/api/prompt-queue/item' && req.method === 'GET') {
      const item = queueItemDetails(url.searchParams.get('id') || '');
      if (!item) return sendJson(res, 404, { error: '任务不存在' });
      return sendJson(res, 200, item);
    }
    if (p === '/api/config' && req.method === 'GET') return sendJson(res, 200, { config: cfg, path: CFG_PATH, port: PORT });
    if (p === '/api/browse') return sendJson(res, 200, browseDir(url.searchParams.get('path') || ''));

    if (p === '/api/book') {
      const name = url.searchParams.get('name') || '';
      const novel = listNovels(cfg.libraryRoot, [name])[0];
      if (!novel) return sendJson(res, 404, { error: '未找到该书' });
      const chapters = listChapters(novel, cfg);
      const { tier, selected } = selectForNovel(novel, chapters, cfg);
      const sel = new Set(selected.map((c) => c.name));
      const list = chapters.map((ch) => {
        let st = 'unselected';
        let marker = null;
        if (sel.has(ch.name)) {
          marker = readSkipMarker(ch);
          st = isSoftFail(ch, cfg) ? 'retry' : (isSkipped(ch) ? 'failed' : (isDone(ch, cfg) ? 'done' : 'pending'));
        }
        return { name: ch.name, status: st, outputPath: ch.outputPath, hasOutput: st === 'done', attempts: marker?.attempts || 0, reason: marker?.reason || '' };
      });
      return sendJson(res, 200, { name, tier, readers: novel.readers, total: chapters.length, selected: selected.length, chapters: list });
    }
    if (p === '/api/outline') {
      const fp = url.searchParams.get('path') || '';
      if (!fp.startsWith(cfg.libraryRoot) || !fp.endsWith(cfg.outputExt || '.md')) return sendJson(res, 400, { error: '路径不合法' });
      const text = readText(fp, null);
      if (text == null) return sendJson(res, 404, { error: '文件不存在' });
      return sendJson(res, 200, { path: fp, text });
    }
    if (p === '/api/chapter') { // 查看输入章节正文（用于预览要发送的内容）
      const fp = url.searchParams.get('path') || '';
      if (!fp.startsWith(cfg.libraryRoot) || !fp.toLowerCase().endsWith('.txt')) return sendJson(res, 400, { error: '路径不合法' });
      const text = readText(fp, null);
      if (text == null) return sendJson(res, 404, { error: '文件不存在' });
      return sendJson(res, 200, { path: fp, text: text.slice(0, 20000), truncated: text.length > 20000 });
    }

    if (req.method === 'POST' && p === '/api/prompt-queue') { const body = await readBody(req); const r = handleQueueAction(body); return sendJson(res, r.ok ? 200 : 400, r); }
    if (req.method === 'POST' && p === '/api/prompt-queue/control') { const body = await readBody(req); const r = handleQueueControl(body); return sendJson(res, r.ok ? 200 : 400, r); }
    if (req.method === 'POST' && p === '/api/chatgpt/action') { const body = await readBody(req); const r = await handleChatGptAction(body); return sendJson(res, r.ok ? 200 : 400, r); }
    if (req.method === 'POST' && p === '/api/config') { const body = await readBody(req); const r = saveConfig(body.config); return sendJson(res, r.ok ? 200 : 400, r); }
    if (req.method === 'POST' && p === '/api/control') { const body = await readBody(req); const r = await doControl(body.action, body); return sendJson(res, r.ok ? 200 : 400, r); }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  } catch (err) {
    return sendJson(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`控制中心已启动: http://localhost:${PORT}`);
  console.log(`素材库: ${cfg.libraryRoot}`);
  getScan(true).catch((e) => console.error('首次扫描失败:', e?.message || e));
  setInterval(() => getScan(false).catch(() => {}), Math.round(SCAN_TTL * 0.8));
});
