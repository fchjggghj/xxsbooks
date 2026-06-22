/**
 * 服务端专用类型定义
 */

/** 队列项状态 */
export type QueueItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** 队列运行时阶段 */
export type QueuePhase =
  | 'idle'
  | 'starting'
  | 'connecting_browser'
  | 'opening_gpts'
  | 'sending'
  | 'saving_output'
  | 'item_done'
  | 'item_failed'
  | 'item_skipped'
  | 'deleting_conversation'
  | 'paused'
  | 'auto_paused'
  | 'rate_limited'
  | 'resuming'
  | 'stopped'
  | 'fatal_error';

/** 错误类型 */
export type QueueErrorType =
  | 'policy_refusal'
  | 'login_required'
  | 'captcha_required'
  | 'rate_limited'
  | 'timeout'
  | 'invalid_reply'
  | 'composer_unavailable'
  | 'browser_closed'
  | 'unknown';

/** 上下文范围 */
export type ContextScope = 'task' | 'novel';

/** 小说分档 */
export type NovelTier = 'big' | 'small' | 'nodata';

/** 队列执行档案 */
export interface QueueProfile {
  id: string;
  name: string;
  gptUrl: string;
  outputDir: string;
  promptTemplate: string;
  itemsPerConversation: number;
  minOutputChars: number;
  waitReplyTimeoutMs: number;
  replyStableMs: number;
  betweenItemsMs: number;
  deleteConversationAfterDone: boolean;
  maxItemAttempts: number;
  maxConsecutiveFailures: number;
  rateLimitWaitMs: number;
  maxRateLimitWaitMs: number;
  failurePauseMs: number;
  contextScope: ContextScope;
  stageId: string;
}

/** 队列项 */
export interface QueueItem {
  id: string;
  title: string;
  content: string;
  contentHash: string;
  profileId: string;
  status: QueueItemStatus;
  attempts: number;
  outputPath: string;
  outputChars: number;
  responsePreview: string;
  lastError: string;
  errorType: QueueErrorType | '';
  sourcePath: string;
  createdAt: string;
  updatedAt: string;
}

/** 队列存储 */
export interface QueueStore {
  version: 1;
  profiles: QueueProfile[];
  items: QueueItem[];
  updatedAt: string;
}

/** 队列运行时状态 */
export interface QueueRuntime {
  runId: string;
  running: boolean;
  paused: boolean;
  stopRequested: boolean;
  phase: QueuePhase;
  activeId: string | null;
  activeTitle: string;
  activeProfileId: string;
  activeProfileName: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  lastTransitionAt: string | null;
  processed: number;
  succeeded: number;
  failed: number;
  consecutiveFailures: number;
  autoPaused: boolean;
  resumeAt: string;
  pauseReason: string;
  limitHint: string;
  message: string;
  lastError: string;
}

/** 队列事件 */
export interface QueueEvent {
  ts: string;
  type: string;
  runId?: string;
  phase?: QueuePhase;
  activeId?: string;
  [key: string]: unknown;
}

/** 队列统计 */
export interface QueueSummary {
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
}

/** 公开的队列项（不含完整内容） */
export interface PublicQueueItem {
  id: string;
  index: number;
  queuePosition: number | null;
  title: string;
  profileId: string;
  profileName: string;
  status: QueueItemStatus;
  attempts: number;
  maxAttempts: number;
  sourcePath: string;
  outputPath: string;
  outputChars: number;
  lastError: string;
  errorType: QueueErrorType | '';
  responsePreview: string;
  contentPreview: string;
  contentChars: number;
  createdAt: string;
  updatedAt: string;
}

/** 公开的队列存储 */
export interface PublicQueueStore {
  profiles: QueueProfile[];
  items: PublicQueueItem[];
  summary: QueueSummary;
  runtime: QueueRuntime;
  updatedAt: string;
}

/** 队列健康状态 */
export interface QueueHealth {
  ok: boolean;
  issues: string[];
  summary: QueueSummary;
  eventLog: { path: string; exists: boolean; bytes: number };
  store: { path: string; bytes: number; updatedAt: string };
}

/** 队列计划项 */
export interface QueuePlanItem {
  id: string;
  queuePosition: number | null;
  title: string;
  profileId: string;
  profileName: string;
  status: QueueItemStatus;
  attempts: number;
  maxAttempts: number;
  contentChars: number;
  sourcePath: string;
  outputPath: string;
  errorType: QueueErrorType | '';
  lastError: string;
  contentPreview: string;
}

/** 队列失败项 */
export interface QueueFailedItem {
  id: string;
  title: string;
  profileName: string;
  attempts: number;
  maxAttempts: number;
  errorType: QueueErrorType | '';
  lastError: string;
  updatedAt: string;
}

/** 队列计划详情 */
export interface QueuePlanDetails {
  builtAt: string;
  counts: {
    running: number;
    pending: number;
    failed: number;
    capped: number;
  };
  next: QueuePlanItem[];
  failed: QueueFailedItem[];
}

/** 队列项详情 */
export interface QueueItemDetails {
  item: QueueItem;
  outputText: string;
}

/** 流水线阶段 */
export interface PipelineStageConfig {
  id: string;
  name: string;
  entryUrl: string;
  inputDir: string;
  outputDir: string;
  contextScope: ContextScope;
  itemsPerConversation: number;
  note?: string;
}

/** 服务器配置 */
export interface ServerConfig {
  cdpUrl: string;
  gptUrl: string;
  currentStage?: string;
  autoRunNextStage?: boolean;
  nextStageHoldReason?: string;
  pipelineRoot: string;
  movedDoneOutputDir?: string;
  pipelineStages?: PipelineStageConfig[];
  libraryRoot: string;
  novels: string[];
  chaptersDir: string;
  outputDir: string;
  outputExt: string;
  skipFiles: string[];
  chaptersPerConversation: number;
  maxChapters: number;
  concurrency: number;
  chaptersPerRequest: number;
  promptTemplate: string;
  selection: {
    firstNPerNovel: number;
    bigThreshold: number;
    firstNForSmall: number;
    firstNForNoData: number;
    roundToArc: boolean;
  };
  waitReplyTimeoutMs: number;
  replyStableMs: number;
  betweenChaptersMs: number;
  rateLimitWaitMs: number;
  maxRateLimitWaitMs: number;
  failurePauseMs: number;
  maxConsecutiveFailures: number;
  maxItemAttempts: number;
  softRetryCap: number;
  deleteConversationAfterDone: boolean;
  stuckRetries: number;
  minOutputChars: number;
  webPort: number;
  scheduledTaskName: string;
}

/** 章节信息 */
export interface ChapterInfo {
  name: string;
  base: string;
  inputPath: string;
  outputPath: string;
}

/** 小说信息（服务端用，含 dir 和 readers） */
export interface NovelInfo {
  name: string;
  dir: string;
  readers: number | null;
}

/** 分档统计 */
export interface TierStats {
  books: number;
  selected: number;
  done: number;
  failed: number;
  pending: number;
}

/** 单本小说统计 */
export interface BookStats {
  name: string;
  tier: NovelTier;
  readers: number | null;
  total: number;
  selected: number;
  done: number;
  failed: number;
  pending: number;
  firstPending: string | null;
}

/** 失败信息 */
export interface FailureInfo {
  book: string;
  chapter: string;
  reason: string;
  attempts: number;
  retryable: boolean;
  createdAt: string | null;
  outputPath: string;
}

/** 扫描结果 */
export interface ScanResult {
  scannedAt: number;
  totals: {
    novels: number;
    chapters: number;
    selected: number;
    done: number;
    failed: number;
    pending: number;
  };
  tiers: {
    big: TierStats;
    small: TierStats;
    nodata: TierStats;
  };
  books: BookStats[];
  failures: FailureInfo[];
}

/** 处理计划结果 */
export interface PlanResult {
  builtAt: number;
  totals: {
    novels: number;
    chapters: number;
    selected: number;
    pending: number;
    retryPending: number;
  };
  perBook: Array<{
    name: string;
    tier: NovelTier;
    readers: number | null;
    selected: number;
    pending: number;
    done: number;
    retryPending: number;
    next: string[];
  }>;
  queue: Array<{
    book: string;
    chapter: string;
    tier: NovelTier;
    input: string;
    priority: 'retry' | 'normal';
    attempts: number;
    reason: string;
  }>;
}

/** 日志事件 */
export interface LogEvent {
  time: string;
  kind: string;
  text: string;
  chapter?: string;
  out?: string;
  chars?: number;
  note?: string;
  reason?: string;
  book?: string;
  pending?: number;
  [key: string]: unknown;
}

/** 守护日志条目 */
export interface DaemonLogEntry {
  time: string;
  text: string;
}

/** 速度统计 */
export interface SpeedInfo {
  avgSecPerChapter: number | null;
  samples: number;
}

/** 状态快照 */
export interface StatusSnapshot {
  runnerAlive: boolean;
  runnerPid: number | null;
  daemonAlive: boolean;
  daemonPid: number | null;
  stop: boolean;
  activeBook: string | null;
  lastOkTime: string | null;
  lastEvent: LogEvent | null;
  rateLimited: boolean;
  runLogMtime: number | null;
}

/** Chrome 状态 */
export interface ChromeStatus {
  up: boolean;
  browser?: string;
  tabs?: number;
}

/** 健康快照 */
export interface HealthSnapshot {
  ok: boolean;
  uptimeSec: number;
  pid: number;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  chrome: ChromeStatus;
  queue: QueueHealth;
  runtime: QueueRuntime & { heartbeatAgeSec: number | null };
  recentEvents: QueueEvent[];
}

/** 浏览目录结果 */
export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: string[];
  error?: string;
}

/** 通用 API 响应 */
export interface ApiResult {
  ok: boolean;
  msg?: string;
  [key: string]: unknown;
}

/** 跳过标记内容 */
export interface SkipMarker {
  reason?: string;
  attempts?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** 章节状态详情（/api/book 返回） */
export interface ChapterStatus {
  name: string;
  status: 'unselected' | 'retry' | 'failed' | 'done' | 'pending';
  outputPath: string;
  hasOutput: boolean;
  attempts: number;
  reason: string;
}
