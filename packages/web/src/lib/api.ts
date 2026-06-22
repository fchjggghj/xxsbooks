const API_BASE = '/api';

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json();
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json();
}

// ---------- 类型定义（基于现有 vanilla JS API） ----------

export interface PipelineStage {
  id?: string;
  name?: string;
  inputDir?: string;
  outputDir?: string;
  input?: string;
  output?: string;
  contextScope?: string;
}

export interface AppConfig {
  gptUrl?: string;
  cdpUrl?: string;
  libraryRoot?: string;
  chaptersDir?: string;
  outputDir?: string;
  outputExt?: string;
  // adapt/generate 任务通用字段
  inputRoot?: string;
  inputExt?: string;
  outputRoot?: string;
  skipFiles?: string[];
  novels?: string[];
  selection?: {
    firstNPerNovel?: number;
    roundToArc?: boolean;
    bigThreshold?: number;
    firstNForSmall?: number;
    firstNForNoData?: number;
  };
  concurrency?: number;
  chaptersPerRequest?: number;
  chaptersPerConversation?: number;
  maxChapters?: number;
  betweenChaptersMs?: number;
  deleteConversationAfterDone?: boolean;
  promptTemplate?: string;
  waitReplyTimeoutMs?: number;
  replyStableMs?: number;
  rateLimitWaitMs?: number;
  maxRateLimitWaitMs?: number;
  failurePauseMs?: number;
  maxConsecutiveFailures?: number;
  maxItemAttempts?: number;
  softRetryCap?: number;
  stuckRetries?: number;
  minOutputChars?: number;
  webPort?: number;
  scheduledTaskName?: string;
  pipelineStages?: PipelineStage[];
  [key: string]: unknown;
}

export interface Totals {
  done: number;
  pending: number;
  failed: number;
  selected: number;
  chapters: number;
  novels: number;
}

export interface StatusInfo {
  daemonAlive: boolean;
  runnerAlive: boolean;
  stop: boolean;
  rateLimited: boolean;
  activeBook?: string;
}

export interface SpeedInfo {
  avgSecPerChapter: number | null;
}

export interface StateResponse {
  status: StatusInfo;
  totals: Totals;
  speed: SpeedInfo;
  scanAgeSec: number;
  config: AppConfig;
  /** 后端返回的任务 ID（用于校验数据归属，防止切换任务时显示旧数据） */
  taskId?: string;
}

export interface ChromeResponse {
  up: boolean;
}

export interface LogEvent {
  time: string;
  kind: 'ok' | 'fail' | 'book' | 'info' | 'warn' | 'retry' | 'rotate' | string;
  chapter?: string;
  chars?: number;
  note?: string;
  reason?: string;
  book?: string;
  pending?: number;
  text?: string;
}

export interface DaemonLogLine {
  time: string;
  text: string;
}

export interface RunLogResponse {
  events: LogEvent[];
}

export interface DaemonLogResponse {
  daemon: DaemonLogLine[];
}

export interface BookProgress {
  name: string;
  readers: number | null;
  tier: 'big' | 'small' | 'nodata' | string;
  selected: number;
  done: number;
  pending: number;
  failed: number;
  total: number;
}

export interface BooksResponse {
  books: BookProgress[];
}

export interface FailureItem {
  book: string;
  chapter: string;
  reason: string;
  outputPath: string;
  createdAt?: string;
}

export interface FailuresResponse {
  failures: FailureItem[];
}

export interface ControlResponse {
  ok: boolean;
  msg?: string;
  [key: string]: unknown;
}

export interface ConfigResponse {
  config: AppConfig;
  path: string;
  port: number;
}

export interface BrowseItem {
  name: string;
}

export interface BrowseResponse {
  path: string;
  parent?: string;
  dirs: string[];
}

export interface BookChapter {
  name: string;
  status: 'done' | 'pending' | 'retry' | 'failed' | 'unselected';
  hasOutput: boolean;
  outputPath?: string;
}

export interface BookDetail {
  tier: string;
  readers: number | null;
  selected: number;
  total: number;
  chapters: BookChapter[];
  error?: string;
}

export interface OutlineResponse {
  text?: string;
  error?: string;
}

// ---------- 队列相关类型 ----------

export type QueueItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'retry' | 'skipped';

export interface QueueProfile {
  id: string;
  name: string;
  gptUrl?: string;
  outputDir?: string;
  promptTemplate?: string;
  itemsPerConversation?: number;
  minOutputChars?: number;
  contextScope?: 'task' | 'novel';
  stageId?: string;
  deleteConversationAfterDone?: boolean;
  maxItemAttempts?: number;
  maxConsecutiveFailures?: number;
  rateLimitWaitMs?: number;
  failurePauseMs?: number;
}

export interface QueueItem {
  id: string;
  index: number;
  title: string;
  content?: string;
  contentPreview?: string;
  contentChars?: number;
  responsePreview?: string;
  outputChars?: number;
  outputText?: string;
  status: QueueItemStatus;
  profileId: string;
  profileName?: string;
  queuePosition?: number;
  attempts?: number;
  maxAttempts?: number;
  lastError?: string;
  sourcePath?: string;
}

export interface QueueSummary {
  total?: number;
  pending?: number;
  running?: number;
  done?: number;
  failed?: number;
  skipped?: number;
  retry?: number;
}

export interface QueueRuntime {
  running?: boolean;
  paused?: boolean;
  message?: string;
}

export interface PromptQueueResponse {
  ok?: boolean;
  msg?: string;
  summary?: QueueSummary;
  runtime?: QueueRuntime;
  profiles?: QueueProfile[];
  items?: QueueItem[];
  savedProfileId?: string;
  [key: string]: unknown;
}

export type QueuePlanItem = QueueItem;

export interface QueuePlanResponse {
  counts?: {
    running?: number;
    pending?: number;
    failed?: number;
    capped?: number;
  };
  next?: QueuePlanItem[];
  failed?: QueuePlanItem[];
}

export interface QueueEvent {
  ts?: string;
  type?: string;
  title?: string;
  message?: string;
  error?: string;
  outputPath?: string;
  profileName?: string;
  folder?: string;
  itemId?: string;
}

export interface QueueEventsResponse {
  events: QueueEvent[];
}

export interface QueueItemResponse {
  item: QueueItem;
  outputText?: string;
}

export interface HealthRuntime {
  running?: boolean;
  paused?: boolean;
  message?: string;
  processed?: number;
  failed?: number;
  phase?: string;
  heartbeatAgeSec?: number | null;
  activeTitle?: string;
  succeeded?: number;
  consecutiveFailures?: number;
  resumeAt?: string | null;
  autoPaused?: boolean;
  pauseReason?: string;
  limitHint?: string;
}

export interface HealthQueue {
  ok?: boolean;
  issues?: string[];
  store?: { bytes?: number };
}

export interface HealthChrome {
  up?: boolean;
}

export interface HealthResponse {
  ok: boolean;
  uptimeSec?: number;
  runtime?: HealthRuntime;
  queue?: HealthQueue;
  chrome?: HealthChrome;
}

// ---------- 多任务类型 ----------

export interface TaskStatus {
  taskId: string;
  status: StatusInfo & {
    runnerPid?: number | null;
    daemonAlive?: boolean;
    daemonPid?: number | null;
    lastOkTime?: string | null;
    lastEvent?: LogEvent | null;
    runLogMtime?: number | null;
  };
  speed: SpeedInfo & { samples?: number };
  eventCount: number;
}

export interface TasksResponse {
  tasks: TaskStatus[];
  taskIds: string[];
}
