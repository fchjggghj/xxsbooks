/**
 * 核心类型定义
 */

/** 流水线阶段 ID */
export type StageId = 'step1_break_outline' | 'step2_adapt' | 'step3_generate';

/** 流水线阶段定义 */
export interface PipelineStage {
  id: StageId;
  name: string;
  cn: string;
  entryUrl: string;
  inputDir: string;
  outputDir: string;
  contextScope: 'task' | 'novel';
  itemsPerConversation: number;
  note?: string;
}

/** 小说信息 */
export interface Novel {
  name: string;
  path: string;
  readerCount?: string;
  totalChapters: number;
  selectedChapters: number;
  doneChapters: number;
  failedChapters: number;
  pendingChapters: number;
}

/** 大纲/章节条目 */
export interface OutlineItem {
  name: string;
  base: string; // 去掉扩展名的文件名
  inputPath: string;
  outputPath: string;
  novel: Novel;
}

/** 处理计划 */
export interface Plan {
  novel: Novel;
  outlines: OutlineItem[];
  pending: OutlineItem[];
}

/** 批次定义（改编大纲用） */
export interface Batch {
  toSend: OutlineItem[];
  keepIndices: number[];
  isSingle: boolean;
}

/** 运行状态 */
export interface RunState {
  stage: StageId;
  done: number;
  failed: number;
  attempted: number;
  pending: number;
  total: number;
  novels: number;
  conversationUrl?: string | null;
  currentNovel?: string;
  currentBatch?: number;
  totalBatches?: number;
}

/** Chrome 连接状态 */
export interface ChromeState {
  online: boolean;
  url: string;
  tabs: number;
  cdpUrl: string;
}

/** 配额墙信息 */
export interface RateLimitInfo {
  hit: boolean;
  resetAt?: Date;
  waitMs?: number;
  message?: string;
}

/** 发送结果 */
export interface SendResult {
  text: string;
  timedOut: boolean;
  conversationUrl?: string | null;
  error?: string;
}

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 日志条目 */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  stage?: StageId;
  novel?: string;
}

/** API 响应 */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** 进度信息 */
export interface ProgressInfo {
  stage: StageId;
  stageName: string;
  pending: number;
  total: number;
  done: number;
  failed: number;
  percent: number;
  speed: number; // 章/小时
  eta?: string; // 预计完成时间
}

/** 配置基类 */
export interface BaseConfig {
  cdpUrl: string;
  gptUrl: string;
  pipelineRoot: string;
  maxChapters: number;
  concurrency: number;
  waitReplyTimeoutMs: number;
  replyStableMs: number;
  betweenChaptersMs: number;
  rateLimitWaitMs: number;
  maxRateLimitWaitMs: number;
  failurePauseMs: number;
  maxConsecutiveFailures: number;
  stuckRetries: number;
  minOutputChars: number;
  deleteConversationAfterDone: boolean;
}

/** 拆大纲配置 */
export interface OutlineConfig extends BaseConfig {
  libraryRoot: string;
  novels: string[];
  chaptersDir: string;
  outputDir: string;
  outputExt: string;
  skipFiles: string[];
  chaptersPerRequest: number;
  promptTemplate: string;
  selection: {
    firstNPerNovel: number;
    bigThreshold: number;
    firstNForSmall: number;
    firstNForNoData: number;
    roundToArc: boolean;
  };
  webPort: number;
  scheduledTaskName: string;
}

/** 改编配置 */
export interface AdaptConfig extends BaseConfig {
  inputRoot: string;
  outputRoot: string;
  novels: string[];
  inputExt: string;
  outputExt: string;
  overlapBatchSize: number;
  overlapBatchSizeNext: number;
  overlapKeepCount: number;
  promptPrefix: string;
  /** 参考原文根目录（生成正文时用于读取章节开头作为基调） */
  rawRoot?: string;
}
