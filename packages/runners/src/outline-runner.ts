/**
 * 拆大纲主流程（TypeScript 版）
 *
 * 迁移自 程序/scripts/gpt-outline-runner/run.mjs（480行）。
 *
 * 核心功能：
 * - buildPlan：扫描素材库，按选择规则过滤
 * - 配置热更新：每批前 refreshLive()
 * - 工作池：N 个 worker 各占一个标签页
 * - 批量发送：chaptersPerRequest=5，用 =====CHAPTER-k===== 标记
 * - splitBatch：按标记切回 N 段，标记数≠N 整批作废
 * - 逐章兜底 sendSingle
 * - 运行锁 .run.lock
 * - 智能暂停：连续失败 maxConsecutiveFailures 次
 * - 支持 --dry-run 参数
 * - 打印 __PENDING__=N 标记
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import {
  // 类型
  type OutlineConfig,
  type OutlineItem,
  type Novel,
  type RateLimitInfo,
  // 工具
  errorMessage,
  isBrowserClosedError,
  isTransientPageError,
  boundedMs,
  sleep,
  isRefusal,
  isUsable,
  // 配置
  loadConfig as loadConfigFile,
  getConfigPath,
  // chatgpt
  getPages,
  newConversation,
  sendAndCollect,
  hitRateLimit,
  rateLimitInfo,
  deleteCurrentConversation,
} from '@novel-pipeline/shared';
import { buildBatchPrompt, splitBatch } from './batch-utils.js';
import { createFileLogger, acquireLock, releaseLock } from './runner-core.js';

// ---------- 路径常量 ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/runners/src/ → 项目根目录
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 运行结果 */
export interface RunResult {
  pending: number;
  total: number;
  novels: number;
  done: number;
  failed: number;
}

/** 安全读取配置上的可选字段（config.json 实际含一些类型定义里没有的字段）。 */
function cfgNum(cfg: OutlineConfig, key: string, fallback: number): number {
  const v = (cfg as unknown as Record<string, unknown>)[key];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------- 配置加载 ----------
function loadConfig(): OutlineConfig {
  const cfgPath = getConfigPath('outline', PROJECT_ROOT);
  return loadConfigFile<OutlineConfig>(cfgPath);
}

// ---------- 运行锁 ----------
// 锁逻辑已统一到 runner-core.ts（acquireLock / releaseLock / processAlive）

// ---------- 选择逻辑（从 select.mjs 迁移） ----------

/** 从小说文件夹名解析在读人数；无则返回 null。 */
function parseReaders(name: string): number | null {
  let m = String(name).match(/在读[:：]\s*([\d.]+)\s*万/);
  if (m) return Math.round(parseFloat(m[1]) * 10000);
  m = String(name).match(/在读[:：]\s*(\d+)\s*人/);
  if (m) return parseInt(m[1], 10);
  return null;
}

type Tier = 'big' | 'small' | 'nodata';

/** 分档：big=全书拆；small=在读<阈值取前N；nodata=无在读取前N。 */
function tierOf(readers: number | null, cfg: OutlineConfig): Tier {
  const big = cfg.selection?.bigThreshold ?? 50000;
  if (readers == null) return 'nodata';
  return readers >= big ? 'big' : 'small';
}

/** 从章节名提取「世界名」：去掉「第NNN章_」前缀和结尾的内部编号。 */
function arcNameOf(chapterName: string): string {
  let s = String(chapterName).replace(/\.[^.]+$/, '');
  s = s.replace(/^第?\s*\d+\s*章[_\s]*/, '');
  s = s.replace(/[\s_]*[（(]\s*\d+\s*[)）]\s*$/, '');
  s = s.replace(/[\s_]*\d+\s*$/, '');
  return s.trim();
}

interface Arc {
  name: string;
  chapters: OutlineItem[];
}

/** 按「世界名」把连续章节分组成弧。 */
function groupArcs(chapters: OutlineItem[]): Arc[] {
  const arcs: Arc[] = [];
  let cur: Arc | null = null;
  for (const ch of chapters) {
    const a = arcNameOf(ch.base || ch.name);
    if (!cur || cur.name !== a) {
      cur = { name: a, chapters: [] };
      arcs.push(cur);
    }
    cur.chapters.push(ch);
  }
  return arcs;
}

/** 取前 N 章：roundToArc=true 时按弧边界不切断世界。 */
function pickFirstN(chapters: OutlineItem[], N: number, roundToArc = true): OutlineItem[] {
  if (!(N > 0)) return [];
  if (!roundToArc) return chapters.slice(0, N);
  const arcs = groupArcs(chapters);
  const selected: OutlineItem[] = [];
  for (const arc of arcs) {
    if (selected.length === 0 || selected.length + arc.chapters.length <= N) {
      selected.push(...arc.chapters);
    } else {
      break;
    }
  }
  return selected;
}

interface SelectionResult {
  tier: Tier;
  selected: OutlineItem[];
}

/** 对一本书应用规则，返回 { tier, selected }。 */
function selectForNovel(
  novel: Novel,
  chapters: OutlineItem[],
  cfg: OutlineConfig,
): SelectionResult {
  const readers = parseReaders(novel.name);
  const tier = tierOf(readers, cfg);
  const roundToArc = cfg.selection?.roundToArc ?? true;

  // 统一规则：每本只取前 firstNPerNovel 章（>0 时对所有书生效，无视分档）。
  const uniform = Number(cfg.selection?.firstNPerNovel ?? 0);
  if (uniform > 0) {
    const selected = pickFirstN(chapters, uniform, roundToArc);
    return { tier, selected };
  }

  // 旧的分档规则：big=全书；small/nodata=前 N。
  if (tier === 'big') return { tier, selected: chapters };
  const N =
    tier === 'small'
      ? (cfg.selection?.firstNForSmall ?? 200)
      : (cfg.selection?.firstNForNoData ?? 200);
  const selected = pickFirstN(chapters, N, roundToArc);
  return { tier, selected };
}

// ---------- 文件操作（从 files.mjs 迁移） ----------

const MIN_DONE_BYTES = 800;

/** 列出某本小说「章节」文件夹里的章节文件，自然排序，跳过 skipFiles 和非 .txt。 */
function listChapters(novel: Novel, cfg: OutlineConfig): OutlineItem[] {
  const chDir = path.join(novel.path, cfg.chaptersDir);
  if (!fs.existsSync(chDir)) return [];
  const skip = new Set((cfg.skipFiles || []).map((s) => s.toLowerCase()));
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  const files = fs
    .readdirSync(chDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => name.toLowerCase().endsWith('.txt'))
    .filter((name) => !skip.has(name.toLowerCase()));
  files.sort(collator.compare);
  return files.map((name) => {
    const base = name.replace(/\.[^.]+$/, '');
    return {
      name,
      base,
      inputPath: path.join(chDir, name),
      outputPath: path.join(novel.path, cfg.outputDir, base + (cfg.outputExt || '.md')),
      novel,
    };
  });
}

function fileExists(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

function hasDoneOutput(chapter: OutlineItem, _cfg: OutlineConfig): boolean {
  try {
    const st = fs.statSync(chapter.outputPath);
    return st.isFile() && st.size >= MIN_DONE_BYTES;
  } catch {
    return false;
  }
}

function skipMarkerPath(chapter: OutlineItem): string {
  return `${chapter.outputPath}.skip.json`;
}

function lockMarkerPath(chapter: OutlineItem): string {
  return `${chapter.outputPath}.lock`;
}

function readSkipMarker(chapter: OutlineItem): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(skipMarkerPath(chapter), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function softCap(cfg: OutlineConfig): number {
  return cfgNum(cfg, 'softRetryCap', 5);
}

function isPermanentSkip(chapter: OutlineItem, cfg: OutlineConfig): boolean {
  const m = readSkipMarker(chapter);
  if (!m) return false;
  if (m.reason === 'policy_refusal') return true;
  return Number(m.attempts || 1) >= softCap(cfg);
}

function isSoftFail(chapter: OutlineItem, cfg: OutlineConfig): boolean {
  if (hasDoneOutput(chapter, cfg)) return false;
  const m = readSkipMarker(chapter);
  if (!m || m.reason === 'policy_refusal') return false;
  return Number(m.attempts || 1) < softCap(cfg);
}

function clearSkipMarker(chapter: OutlineItem): boolean {
  try {
    fs.unlinkSync(skipMarkerPath(chapter));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    return false;
  }
}

/** 已完成（跳过续传）＝ 有有效产出 或 永久放弃。软失败不算完成→会被重新尝试。 */
function isDone(chapter: OutlineItem, cfg: OutlineConfig): boolean {
  return hasDoneOutput(chapter, cfg) || isPermanentSkip(chapter, cfg);
}

function readChapter(chapter: OutlineItem): string {
  return fs.readFileSync(chapter.inputPath, 'utf8');
}

function readLockPid(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as { pid?: number };
    const pid = Number(parsed?.pid || 0);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ClaimResult {
  claimed: boolean;
  reason?: string;
  lockPath?: string;
}

function claimChapter(chapter: OutlineItem, cfg: OutlineConfig): ClaimResult {
  if (isDone(chapter, cfg)) return { claimed: false, reason: 'done' };

  const dir = path.dirname(chapter.outputPath);
  fs.mkdirSync(dir, { recursive: true });

  const lockPath = lockMarkerPath(chapter);
  const staleMs = cfgNum(cfg, 'chapterLockStaleMs', 6 * 60 * 60 * 1000);

  for (let i = 0; i < 2; i++) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(
        fd,
        JSON.stringify(
          {
            pid: process.pid,
            createdAt: new Date().toISOString(),
            inputPath: chapter.inputPath,
            outputPath: chapter.outputPath,
          },
          null,
          2,
        ),
        'utf8',
      );
      return { claimed: true, lockPath };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code !== 'EEXIST') throw err;
      if (isDone(chapter, cfg)) return { claimed: false, reason: 'done' };

      try {
        const pid = readLockPid(lockPath);
        if (pid && !isProcessAlive(pid)) {
          fs.unlinkSync(lockPath);
          continue;
        }

        const st = fs.statSync(lockPath);
        if (st.isFile() && Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (staleErr) {
        const se = staleErr as NodeJS.ErrnoException;
        if (se?.code !== 'ENOENT') throw staleErr;
        continue;
      }

      return { claimed: false, reason: 'locked', lockPath };
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

  return { claimed: false, reason: 'locked', lockPath };
}

function releaseChapterClaim(claim: ClaimResult): void {
  if (!claim?.claimed || !claim.lockPath) return;
  try {
    fs.unlinkSync(claim.lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
}

function writeOutput(chapter: OutlineItem, text: string): boolean {
  const dir = path.dirname(chapter.outputPath);
  fs.mkdirSync(dir, { recursive: true });

  // 重新检查是否已完成（多 worker 竞争）
  if (hasDoneOutput(chapter, {} as OutlineConfig)) return false;

  if (fileExists(chapter.outputPath)) {
    fs.unlinkSync(chapter.outputPath);
  }

  try {
    fs.writeFileSync(chapter.outputPath, text, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw err;
  }
}

function writeSkipMarker(
  chapter: OutlineItem,
  reason: string,
  details: Record<string, unknown> = {},
): boolean {
  const dir = path.dirname(chapter.outputPath);
  fs.mkdirSync(dir, { recursive: true });

  if (hasDoneOutput(chapter, {} as OutlineConfig)) return false;
  if (fileExists(chapter.outputPath)) fs.unlinkSync(chapter.outputPath);

  const prev = readSkipMarker(chapter);
  // 政策拒绝＝直接永久放弃；其它＝软失败，累计 attempts。
  const attempts = reason === 'policy_refusal' ? 1 : Number(prev?.attempts || 0) + 1;
  const markerPath = skipMarkerPath(chapter);
  const payload = {
    reason,
    attempts,
    createdAt: (prev?.createdAt as string) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    chapter: chapter.name,
    inputPath: chapter.inputPath,
    outputPath: chapter.outputPath,
    ...details,
  };

  fs.writeFileSync(markerPath, JSON.stringify(payload, null, 2), 'utf8');
  return true;
}

// ---------- 构建处理计划 ----------

interface OutlinePlanEntry {
  novel: Novel;
  tier: Tier;
  chapters: OutlineItem[];
  selected: OutlineItem[];
  pending: OutlineItem[];
  softCount: number;
}

interface OutlinePlan {
  plan: OutlinePlanEntry[];
  totalNovels: number;
  totalChapters: number;
  selectedChapters: number;
  pendingChapters: number;
  retryPending: number;
}

/** 列出要处理的小说文件夹。novelsFilter 为空数组时＝全库。 */
function listNovels(libraryRoot: string, novelsFilter: string[]): Novel[] {
  if (!fs.existsSync(libraryRoot)) {
    throw new Error(`素材库根目录不存在: ${libraryRoot}`);
  }
  let names: string[];
  if (Array.isArray(novelsFilter) && novelsFilter.length) {
    names = novelsFilter.slice();
  } else {
    names = fs
      .readdirSync(libraryRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  names.sort(collator.compare);
  return names
    .map((name) => ({
      name,
      path: path.join(libraryRoot, name),
      totalChapters: 0,
      selectedChapters: 0,
      doneChapters: 0,
      failedChapters: 0,
      pendingChapters: 0,
    }))
    .filter((n) => fs.existsSync(n.path));
}

function buildPlan(cfg: OutlineConfig): OutlinePlan {
  const novels = listNovels(cfg.libraryRoot, cfg.novels);
  const plan: OutlinePlanEntry[] = [];
  let totalChapters = 0;
  let selectedChapters = 0;
  let pendingChapters = 0;
  let retryPending = 0;

  for (const novel of novels) {
    const chapters = listChapters(novel, cfg);
    const { tier, selected } = selectForNovel(novel, chapters, cfg);
    const pendingAll = selected.filter((c) => !isDone(c, cfg));
    // 失败优先：软失败（可重试）排在本书待处理最前面。
    const soft = pendingAll.filter((c) => isSoftFail(c, cfg));
    const fresh = pendingAll.filter((c) => !isSoftFail(c, cfg));
    const pending = [...soft, ...fresh];
    totalChapters += chapters.length;
    selectedChapters += selected.length;
    pendingChapters += pending.length;
    retryPending += soft.length;
    plan.push({ novel, tier, chapters, selected, pending, softCount: soft.length });
  }
  // 有失败章的小说整本排到最前。
  plan.sort((a, b) => (b.softCount > 0 ? 1 : 0) - (a.softCount > 0 ? 1 : 0));

  return {
    plan,
    totalNovels: novels.length,
    totalChapters,
    selectedChapters,
    pendingChapters,
    retryPending,
  };
}

// ---------- 主流程 ----------

/** 配置结构签名：用于检测结构类配置是否变更。 */
function structSig(c: OutlineConfig): string {
  return JSON.stringify({
    libraryRoot: c.libraryRoot,
    novels: c.novels,
    chaptersDir: c.chaptersDir,
    outputDir: c.outputDir,
    outputExt: c.outputExt,
    skipFiles: c.skipFiles,
    selection: c.selection,
    concurrency: c.concurrency,
    gptUrl: c.gptUrl,
    cdpUrl: c.cdpUrl,
  });
}

async function run(cfg: OutlineConfig, dryRun: boolean): Promise<RunResult> {
  // 文件日志：同时输出到控制台和 gpt-outline-runner/run.log（兼容后端 parseRunLine）
  const log = createFileLogger('outline');

  const { plan, totalNovels, totalChapters, selectedChapters, pendingChapters } = buildPlan(cfg);

  // 机器可读标记（守护脚本靠它判断剩余/是否跑完，纯 ASCII）
  console.log('__PENDING__=' + pendingChapters);

  const concurrency = Math.max(1, Number(cfg.concurrency ?? 1));
  const batchSize = Math.max(1, Number(cfg.chaptersPerRequest ?? 1));

  console.log('==================== 处理计划 ====================');
  console.log(`素材库      : ${cfg.libraryRoot}`);
  console.log(
    `小说范围    : ${cfg.novels && cfg.novels.length ? cfg.novels.length + ' 本（指定）' : '全库'}`,
  );
  console.log(`小说总数    : ${totalNovels}`);
  console.log(`全部章节    : ${totalChapters}`);
  const roundToArc = cfg.selection?.roundToArc ?? true;
  const uniformN = Number(cfg.selection?.firstNPerNovel ?? 0);
  if (uniformN > 0) {
    console.log(
      `选取规则    : 每本前 ${uniformN} 章（${roundToArc ? '按弧边界·不切断世界' : '硬切到第' + uniformN + '章'}）`,
    );
  }
  console.log(`规则选中    : ${selectedChapters} 章`);
  console.log(`待处理      : ${pendingChapters}（选中里已有输出的自动跳过）`);
  console.log(`并发标签页  : ${concurrency}`);
  if (batchSize > 1) {
    console.log(`每请求章数  : ${batchSize}（多章合一个提示发送，减少请求次数=少撞限制）`);
  }
  console.log('--------------------------------------------------');
  for (const { novel, tier, chapters, selected, pending } of plan.slice(0, 10)) {
    const readers = parseReaders(novel.name);
    const r =
      readers == null ? '无在读' : readers >= 10000 ? readers / 10000 + '万' : readers + '人';
    console.log(`  ${novel.name}`);
    console.log(
      `     [${tier}/${r}] 全${chapters.length}章 → 选中${selected.length}，待处理${pending.length}`,
    );
    if (pending[0]) console.log(`     首个待处理: ${pending[0].name} → ${pending[0].outputPath}`);
  }
  if (plan.length > 10) console.log(`  …（其余 ${plan.length - 10} 本省略）`);
  console.log('==================================================');

  if (dryRun) {
    console.log('\n[dry-run] 仅规划，未开浏览器、未写任何文件。');
    if (!cfg.gptUrl || cfg.gptUrl.includes('在这里填')) {
      console.log('[dry-run] 提醒：config.json 里的 gptUrl 还没填你的自定义 GPT 链接。');
    }
    return {
      pending: pendingChapters,
      total: totalChapters,
      novels: totalNovels,
      done: 0,
      failed: 0,
    };
  }

  if (!cfg.gptUrl || cfg.gptUrl.includes('在这里填')) {
    throw new Error('请先在 config.json 填入你的自定义 GPT 链接 gptUrl');
  }
  if (!pendingChapters) {
    log('没有待处理章节，全部已完成。');
    return { pending: 0, total: totalChapters, novels: totalNovels, done: 0, failed: 0 };
  }

  // ===== 配置热更新 =====
  const baseSig = structSig(cfg);
  let live = cfg;
  let stale = false;

  function refreshLive(): OutlineConfig {
    try {
      const next = loadConfig();
      live = next;
      if (!stale && structSig(next) !== baseSig) {
        stale = true;
        log(
          '⟳ 检测到配置结构变更（并发/选取规则/素材库/GPT链接等），本轮处理完手头的批后优雅退出，守护会用新配置重启（约30秒内生效）。',
        );
      }
    } catch {
      // 读失败（可能面板正写一半）→ 沿用上次 live，下一批再读
    }
    return live;
  }

  // 扁平化待处理队列
  interface FlatItem {
    ch: OutlineItem;
    novelName: string;
  }
  const flat: FlatItem[] = [];
  for (const { novel, pending } of plan) {
    for (const ch of pending) flat.push({ ch, novelName: novel.name });
  }

  // 连接浏览器
  const workers = Math.min(concurrency, flat.length);
  log(
    `连接 Chrome（CDP），准备 ${workers} 个标签页…（每批 ${batchSize} 章合 1 个请求；配置支持热更新，改 config.json 随时生效）`,
  );
  const { pages } = await getPages(cfg, workers);
  log(`已就绪 ${pages.length} 个标签页`);

  // 配额墙恢复
  async function waitForRateLimitRecovery(
    page: Page,
    c: OutlineConfig,
    label = '',
  ): Promise<number> {
    let info: RateLimitInfo = { hit: true };
    try {
      info = await rateLimitInfo(page);
    } catch {
      /* 忽略 */
    }
    const fallback = boundedMs(c.rateLimitWaitMs, 30 * 60 * 1000);
    const maxWait = boundedMs(c.maxRateLimitWaitMs, 2 * 60 * 60 * 1000);
    const waitMs = boundedMs(info?.waitMs, fallback, maxWait);
    const mins = Math.max(1, Math.ceil(waitMs / 60000));
    log(
      `⚠ ${label || '疑似撞配额墙'}，智能暂停约 ${mins} 分钟后自动恢复${info?.message ? `（识别: ${info.message}）` : ''}`,
    );
    await sleep(waitMs);
    await newConversation(page, c);
    return waitMs;
  }

  // 清理对话
  async function cleanupConversation(page: Page, c: OutlineConfig, label = ''): Promise<boolean> {
    if (!c.deleteConversationAfterDone) return false;
    try {
      await deleteCurrentConversation(page);
      log(`✓ 已请求删除网站对话记录${label ? `（${label}）` : ''}`);
      return true;
    } catch (err) {
      log(`⚠ 删除网站对话记录失败${label ? `（${label}）` : ''}: ${errorMessage(err)}`);
      return false;
    }
  }

  let consecutiveSoftFailures = 0;

  // 连续失败智能暂停
  async function maybePauseAfterFailure(page: Page, c: OutlineConfig, label = ''): Promise<void> {
    const cap = Number(c.maxConsecutiveFailures ?? 3);
    if (!cap || cap <= 0 || consecutiveSoftFailures < cap) return;
    const waitMs = boundedMs(c.failurePauseMs, 5 * 60 * 1000);
    log(
      `⚠ 连续失败 ${consecutiveSoftFailures} 次，智能暂停 ${Math.ceil(waitMs / 60000)} 分钟后继续${label ? `（${label}）` : ''}`,
    );
    await sleep(waitMs);
    await newConversation(page, c);
    consecutiveSoftFailures = 0;
  }

  const limit = Number(cfg.maxChapters) > 0 ? Number(cfg.maxChapters) : Infinity;
  if (limit !== Infinity) log(`本次最多处理 ${limit} 章（maxChapters，用于试跑；设 0 = 不限）`);

  let cursor = 0;
  let done = 0;
  let failed = 0;
  let attempted = 0;
  let fatal: Error | null = null;

  const loggedBooks = new Set<string>();

  // 取下一批：从游标起，取最多 size 个「同一本书」的连续待处理章
  function nextBatch(size: number): { novelName: string; items: OutlineItem[] } | null {
    if (fatal || stale || attempted >= limit || cursor >= flat.length) return null;
    const first = flat[cursor];
    cursor++;
    const items: OutlineItem[] = [first.ch];
    while (
      cursor < flat.length &&
      flat[cursor].novelName === first.novelName &&
      items.length < size
    ) {
      items.push(flat[cursor].ch);
      cursor++;
    }
    return { novelName: first.novelName, items };
  }

  function saveOutput(ch: OutlineItem, text: string, suffix = ''): boolean {
    if (writeOutput(ch, text)) {
      clearSkipMarker(ch);
      done++;
      consecutiveSoftFailures = 0;
      log(`✓ ${ch.name} -> ${path.basename(ch.outputPath)}（${text.length} 字）${suffix}`);
      return true;
    }
    log(`跳过保存（输出或跳过标记已存在）: ${ch.name}`);
    return false;
  }

  function markSkipped(
    ch: OutlineItem,
    reason: string,
    details: Record<string, unknown>,
    message: string,
  ): void {
    failed++;
    writeSkipMarker(ch, reason, details);
    log(message);
  }

  // 单章发送（兜底用，最稳）
  async function sendSingle(
    page: Page,
    ch: OutlineItem,
    c: OutlineConfig,
  ): Promise<'done' | 'failed' | 'policy_refusal'> {
    const minChars = Number(c.minOutputChars ?? 300);
    const usable = (s: string) => isUsable(s, minChars);
    const prompt = (c.promptTemplate || '{content}').replace('{content}', readChapter(ch));
    const { text, timedOut } = await sendAndCollect(page, prompt, c);
    if (isRefusal(text)) {
      markSkipped(
        ch,
        'policy_refusal',
        { responsePreview: String(text || '').slice(0, 300) },
        `✗ ${ch.name}: 被内容政策拒绝，已写跳过标记`,
      );
      return 'policy_refusal';
    }
    if (usable(text)) {
      saveOutput(ch, text, '（单章兜底）');
      return 'done';
    }
    if (await hitRateLimit(page)) {
      await waitForRateLimitRecovery(page, c, `处理 ${ch.name} 时达到上限`);
      const r = await sendAndCollect(page, prompt, c);
      if (isRefusal(r.text)) {
        markSkipped(
          ch,
          'policy_refusal',
          { responsePreview: String(r.text || '').slice(0, 300) },
          `✗ ${ch.name}: 配额恢复后被内容政策拒绝，已写跳过标记`,
        );
        return 'policy_refusal';
      }
      if (usable(r.text)) {
        saveOutput(ch, r.text, '（配额恢复后单章）');
        return 'done';
      }
    }
    const maxStuck = Number(c.stuckRetries ?? 3);
    for (let s = 1; s <= maxStuck; s++) {
      await newConversation(page, c);
      const r = await sendAndCollect(page, prompt, c);
      if (isRefusal(r.text)) {
        markSkipped(
          ch,
          'policy_refusal',
          { retry: s },
          `✗ ${ch.name}: 重试仍被政策拒绝，已写跳过标记`,
        );
        return 'policy_refusal';
      }
      if (usable(r.text)) {
        saveOutput(ch, r.text, `（单章刷新重试第${s}次）`);
        return 'done';
      }
    }
    markSkipped(
      ch,
      'no_valid_reply',
      { timedOut, minChars },
      `✗ ${ch.name}: 没拿到有效回复${timedOut ? '（超时）' : ''}，已写跳过标记`,
    );
    consecutiveSoftFailures++;
    return 'failed';
  }

  // 工作线程：每批前热读配置 → 取一批 → 发送/切分落盘
  async function worker(wi: number, page: Page): Promise<void> {
    await sleep(wi * 1500); // 错峰启动
    let countInConv = 0;
    let convReady = false;

    while (true) {
      const c = refreshLive();
      if (stale) break;
      const size = Math.max(1, Number(c.chaptersPerRequest ?? 1));
      const batch = nextBatch(size);
      if (!batch) break;

      const minChars = Number(c.minOutputChars ?? 300);
      const usable = (s: string) => isUsable(s, minChars);

      // 逐章加锁，过滤掉已完成/被别的标签页占用的
      const claims: ClaimResult[] = [];
      const chs: OutlineItem[] = [];
      for (const ch of batch.items) {
        if (isDone(ch, c)) continue;
        const claim = claimChapter(ch, c);
        if (claim.claimed) {
          claims.push(claim);
          chs.push(ch);
        }
      }
      if (!chs.length) continue;

      try {
        if (!loggedBooks.has(batch.novelName)) {
          loggedBooks.add(batch.novelName);
          log(`========== 开始小说: ${batch.novelName} ==========`);
        }
        if (!convReady || countInConv >= cfgNum(c, 'chaptersPerConversation', 100)) {
          await newConversation(page, c);
          countInConv = 0;
          convReady = true;
        }

        let resetConversationAfterBatch = false;
        try {
          if (chs.length === 1) {
            const result = await sendSingle(page, chs[0], c);
            if (result === 'done') {
              resetConversationAfterBatch = await cleanupConversation(page, c, chs[0].name);
            }
            if (result === 'failed') await maybePauseAfterFailure(page, c, chs[0].name);
          } else {
            const prompt = buildBatchPrompt(chs, readChapter);
            const maxStuck = Number(c.stuckRetries ?? 3);
            let okBatch = false;
            for (let attempt = 1; attempt <= maxStuck && !okBatch; attempt++) {
              const { text } = await sendAndCollect(page, prompt, c);
              if (isRefusal(text)) {
                log(`↻ [W${wi}] 批量(${chs.length}章)被政策拒绝，转逐章兜底…`);
                break;
              }
              const segs = splitBatch(text, chs.length);
              if (segs && segs.every(usable)) {
                for (let i = 0; i < chs.length; i++) {
                  saveOutput(chs[i], segs[i], `（批量 ${chs.length} 章/请求）`);
                }
                okBatch = true;
                resetConversationAfterBatch = await cleanupConversation(
                  page,
                  c,
                  `${chs.length} 章批量`,
                );
              } else if (await hitRateLimit(page)) {
                await waitForRateLimitRecovery(page, c, `[W${wi}] 批量达到上限`);
                countInConv = 0;
              } else {
                log(
                  `↻ [W${wi}] 批量切分失败（标记数对不上或某段太短），刷新重试 ${attempt}/${maxStuck}…`,
                );
                await newConversation(page, c);
                countInConv = 0;
              }
            }
            if (!okBatch) {
              log(`[W${wi}] 批量多次不成，回退逐章处理这 ${chs.length} 章（保证不写错位）…`);
              await newConversation(page, c);
              countInConv = 0;
              for (let ci = 0; ci < chs.length; ci++) {
                const ch = chs[ci];
                if (!isDone(ch, c)) {
                  const result = await sendSingle(page, ch, c);
                  if (result === 'done') {
                    const cleaned = await cleanupConversation(page, c, ch.name);
                    resetConversationAfterBatch = cleaned || resetConversationAfterBatch;
                    if (cleaned && ci < chs.length - 1) {
                      await newConversation(page, c);
                      countInConv = 0;
                    }
                  }
                  if (result === 'failed') await maybePauseAfterFailure(page, c, ch.name);
                }
              }
            }
          }
        } catch (err) {
          if (isBrowserClosedError(err)) {
            log(`FATAL [W${wi}] browser/page closed; 中止本轮以便守护重启 Chrome 续跑。`);
            fatal = err as Error;
            break;
          }
          if (isTransientPageError(err)) {
            log(`Transient page error: ${errorMessage(err)}; 重开对话后回退逐章重试。`);
            try {
              await newConversation(page, c);
              countInConv = 0;
              for (let ci = 0; ci < chs.length; ci++) {
                const ch = chs[ci];
                if (!isDone(ch, c)) {
                  const result = await sendSingle(page, ch, c);
                  if (result === 'done') {
                    const cleaned = await cleanupConversation(page, c, ch.name);
                    resetConversationAfterBatch = cleaned || resetConversationAfterBatch;
                    if (cleaned && ci < chs.length - 1) {
                      await newConversation(page, c);
                      countInConv = 0;
                    }
                  }
                  if (result === 'failed') await maybePauseAfterFailure(page, c, ch.name);
                }
              }
            } catch (retryErr) {
              if (isBrowserClosedError(retryErr)) {
                log(`FATAL [W${wi}] browser/page closed while retrying; 中止。`);
                fatal = retryErr as Error;
                break;
              }
              failed += chs.length;
              consecutiveSoftFailures += chs.length;
              await maybePauseAfterFailure(page, c, `W${wi} 重试失败`);
              log(`✗ 批次失败: ${errorMessage(retryErr)}`);
            }
          } else {
            failed += chs.length;
            consecutiveSoftFailures += chs.length;
            await maybePauseAfterFailure(page, c, `W${wi} 批次失败`);
            log(`✗ 批次失败: ${errorMessage(err)}`);
          }
        }

        if (resetConversationAfterBatch) {
          convReady = false;
          countInConv = 0;
        } else {
          countInConv += chs.length;
        }
        attempted += chs.length;
        if (attempted >= limit) {
          log(`已达本次上限 ${limit} 章，停止（改 config.json 的 maxChapters 放开）。`);
          break;
        }
        await sleep(c.betweenChaptersMs);
      } finally {
        for (const cl of claims) releaseChapterClaim(cl);
      }
    }
  }

  await Promise.all(pages.map((p, i) => worker(i, p)));

  if (fatal) {
    log(`本轮中止。成功 ${done}，失败 ${failed}。`);
    throw fatal;
  }
  if (stale) {
    log(
      `配置已变更，本轮优雅退出（成功 ${done}，失败 ${failed}）。守护将用新配置重启（约30秒内）。`,
    );
    return {
      pending: pendingChapters - done,
      total: totalChapters,
      novels: totalNovels,
      done,
      failed,
    };
  }
  log(`全部结束。成功 ${done}，失败 ${failed}。`);
  return {
    pending: pendingChapters - done,
    total: totalChapters,
    novels: totalNovels,
    done,
    failed,
  };
}

/**
 * 运行拆大纲主流程。
 *
 * @param cfg    配置（OutlineConfig）
 * @param dryRun 只规划、不开浏览器
 */
export async function runOutline(cfg: OutlineConfig, dryRun = false): Promise<RunResult> {
  const runLock = dryRun ? null : acquireLock('outline');
  try {
    return await run(cfg, dryRun);
  } finally {
    releaseLock(runLock);
  }
}

// ---------- 直接运行入口 ----------
const DRY = process.argv.includes('--dry-run');

// 仅在直接运行时执行（不被 import 时不跑）
const isMain =
  import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') ||
  process.argv[1]?.endsWith('outline-runner.ts') ||
  process.argv[1]?.endsWith('outline-runner.js');

if (isMain) {
  const cfg = loadConfig();
  runOutline(cfg, DRY).catch((err) => {
    console.error('运行出错:', err);
    process.exit(1);
  });
}
