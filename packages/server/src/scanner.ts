/**
 * 全库扫描
 *
 * 扫描小说库，统计进度，60 秒缓存。
 * 包含章节选择逻辑（按在读人数分档 + 弧边界）。
 * 支持多任务（outline/adapt/generate），每个任务有独立的扫描缓存。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  BookStats,
  ChapterInfo,
  FailureInfo,
  NovelInfo,
  NovelTier,
  PlanResult,
  ScanResult,
  SkipMarker,
  TierStats,
} from './types.js';
import {
  getConfig,
  MIN_DONE_BYTES,
  PLAN_TTL,
  SCAN_TTL,
  readJson,
  getTaskScanConfig,
  type TaskScanConfig,
} from './config.js';

// ---------- 小说/章节列举 ----------

const collator = new Intl.Collator('zh-Hans-CN', {
  numeric: true,
  sensitivity: 'base',
});

/** 从小说文件夹名解析在读人数 */
function parseReaders(name: string): number | null {
  let m = name.match(/在读[:：]\s*([\d.]+)\s*万/);
  if (m) return Math.round(parseFloat(m[1]) * 10000);
  m = name.match(/在读[:：]\s*(\d+)\s*人/);
  if (m) return parseInt(m[1], 10);
  return null;
}

/** 列出要处理的小说文件夹 */
function listNovels(libraryRoot: string, novelsFilter: string[]): NovelInfo[] {
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
  names.sort(collator.compare);
  return names
    .map((name) => ({
      name,
      dir: path.join(libraryRoot, name),
      readers: parseReaders(name),
    }))
    .filter((n) => fs.existsSync(n.dir));
}

/** 列出某本小说的章节文件 */
function listChapters(novel: NovelInfo): ChapterInfo[] {
  const cfg = getConfig();
  const chDir = path.join(novel.dir, cfg.chaptersDir);
  if (!fs.existsSync(chDir)) return [];
  const skip = new Set((cfg.skipFiles || []).map((s) => s.toLowerCase()));
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
      outputPath: path.join(novel.dir, cfg.outputDir, base + (cfg.outputExt || '.md')),
    };
  });
}

// ---------- 选择逻辑 ----------

/** 分档：big=全书拆；small=在读<阈值取前N；nodata=无在读取前N */
function tierOf(readers: number | null): NovelTier {
  const cfg = getConfig();
  const big = cfg.selection?.bigThreshold ?? 50000;
  if (readers == null) return 'nodata';
  return readers >= big ? 'big' : 'small';
}

/** 从章节名提取「世界名」 */
function arcNameOf(chapterName: string): string {
  let s = String(chapterName).replace(/\.[^.]+$/, '');
  s = s.replace(/^第?\s*\d+\s*章[_\s]*/, '');
  s = s.replace(/[\s_]*[（(]\s*\d+\s*[)）]\s*$/, '');
  s = s.replace(/[\s_]*\d+\s*$/, '');
  return s.trim();
}

/** 按「世界名」把连续章节分组成弧 */
function groupArcs(chapters: ChapterInfo[]): Array<{ name: string; chapters: ChapterInfo[] }> {
  const arcs: Array<{ name: string; chapters: ChapterInfo[] }> = [];
  let cur: { name: string; chapters: ChapterInfo[] } | null = null;
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

/** 取前 N 章：roundToArc=true 时按弧边界不切断世界 */
function pickFirstN(chapters: ChapterInfo[], N: number, roundToArc = true): ChapterInfo[] {
  if (!(N > 0)) return [];
  if (!roundToArc) return chapters.slice(0, N);
  const arcs = groupArcs(chapters);
  const selected: ChapterInfo[] = [];
  for (const arc of arcs) {
    if (selected.length === 0 || selected.length + arc.chapters.length <= N) {
      selected.push(...arc.chapters);
    } else {
      break;
    }
  }
  return selected;
}

/** 对一本书应用规则，返回 { tier, selected } */
function selectForNovel(
  novel: NovelInfo,
  chapters: ChapterInfo[],
): { tier: NovelTier; selected: ChapterInfo[] } {
  const cfg = getConfig();
  const tier = tierOf(novel.readers);
  const roundToArc = cfg.selection?.roundToArc ?? true;
  const uniform = Number(cfg.selection?.firstNPerNovel ?? 0);
  if (uniform > 0) {
    return { tier, selected: pickFirstN(chapters, uniform, roundToArc) };
  }
  if (tier === 'big') return { tier, selected: chapters };
  const N =
    tier === 'small'
      ? (cfg.selection?.firstNForSmall ?? 200)
      : (cfg.selection?.firstNForNoData ?? 200);
  return { tier, selected: pickFirstN(chapters, N, roundToArc) };
}

// ---------- 断点判断 ----------

/** 镜像输出路径（已移动的完成输出） */
function mirrorOutputPath(chapter: ChapterInfo): string | null {
  const cfg = getConfig();
  const root = String(cfg.pipelineRoot || '').trim();
  const movedDir = String(cfg.movedDoneOutputDir || '').trim();
  if (!root || !movedDir) return null;
  const novelName = path.basename(path.dirname(path.dirname(chapter.outputPath)));
  if (!novelName) return null;
  return path.join(root, movedDir, novelName, path.basename(chapter.outputPath));
}

/** 是否有有效产出（文件存在且 >= MIN_DONE_BYTES） */
function hasDoneOutput(chapter: ChapterInfo): boolean {
  try {
    const st = fs.statSync(chapter.outputPath);
    return st.isFile() && st.size >= MIN_DONE_BYTES;
  } catch {
    const mirror = mirrorOutputPath(chapter);
    if (!mirror) return false;
    try {
      const st = fs.statSync(mirror);
      return st.isFile() && st.size >= MIN_DONE_BYTES;
    } catch {
      return false;
    }
  }
}

/** 跳过标记路径 */
function skipMarkerPath(chapter: ChapterInfo): string {
  return `${chapter.outputPath}.skip.json`;
}

/** 读跳过标记内容 */
function readSkipMarker(chapter: ChapterInfo): SkipMarker | null {
  return readJson<SkipMarker>(skipMarkerPath(chapter));
}

/** 非空文件判断 */
function nonEmptyFile(filePath: string): boolean {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/** 是否已跳过（有跳过标记） */
function isSkipped(chapter: ChapterInfo): boolean {
  return nonEmptyFile(skipMarkerPath(chapter));
}

/** 软失败重试上限 */
function softCap(): number {
  return Number(getConfig().softRetryCap ?? 5);
}

/** 永久放弃 */
function isPermanentSkip(chapter: ChapterInfo): boolean {
  const m = readSkipMarker(chapter);
  if (!m) return false;
  if (m.reason === 'policy_refusal') return true;
  return Number(m.attempts || 1) >= softCap();
}

/** 软失败（可重试） */
function isSoftFail(chapter: ChapterInfo): boolean {
  if (hasDoneOutput(chapter)) return false;
  const m = readSkipMarker(chapter);
  if (!m || m.reason === 'policy_refusal') return false;
  return Number(m.attempts || 1) < softCap();
}

/** 已完成 */
function isDone(chapter: ChapterInfo): boolean {
  return hasDoneOutput(chapter) || isPermanentSkip(chapter);
}

// ---------- 扫描（带缓存） ----------

function blankTier(): TierStats {
  return { books: 0, selected: 0, done: 0, failed: 0, pending: 0 };
}

let scanCache: ScanResult | null = null;
let scanInFlight: Promise<ScanResult> | null = null;

/** 执行扫描 */
async function doScan(): Promise<ScanResult> {
  const cfg = getConfig();
  const novels = listNovels(cfg.libraryRoot, cfg.novels);
  const books: BookStats[] = [];
  const failures: FailureInfo[] = [];
  const tiers = {
    big: blankTier(),
    small: blankTier(),
    nodata: blankTier(),
  };
  let totalChapters = 0;
  let selectedTotal = 0;
  let doneTotal = 0;
  let failedTotal = 0;
  let pendingTotal = 0;

  for (let i = 0; i < novels.length; i++) {
    const novel = novels[i];
    const chapters = listChapters(novel);
    const { tier, selected } = selectForNovel(novel, chapters);
    let done = 0;
    let failed = 0;
    let pending = 0;
    let firstPending: string | null = null;

    for (const ch of selected) {
      if (isSoftFail(ch)) {
        pending++;
        if (!firstPending) firstPending = ch.name;
        const mk = readSkipMarker(ch);
        failures.push({
          book: novel.name,
          chapter: ch.name,
          reason: mk?.reason || 'soft_fail',
          attempts: mk?.attempts || 0,
          retryable: true,
          createdAt: mk?.createdAt || null,
          outputPath: ch.outputPath,
        });
      } else if (isSkipped(ch)) {
        failed++;
        const mk = readJson<SkipMarker>(skipMarkerPath(ch));
        failures.push({
          book: novel.name,
          chapter: ch.name,
          reason: mk?.reason || 'unknown',
          attempts: mk?.attempts || 0,
          retryable: false,
          createdAt: mk?.createdAt || null,
          outputPath: ch.outputPath,
        });
      } else if (isDone(ch)) {
        done++;
      } else {
        pending++;
        if (!firstPending) firstPending = ch.name;
      }
    }

    totalChapters += chapters.length;
    selectedTotal += selected.length;
    doneTotal += done;
    failedTotal += failed;
    pendingTotal += pending;

    const t = tiers[tier];
    t.books++;
    t.selected += selected.length;
    t.done += done;
    t.failed += failed;
    t.pending += pending;

    books.push({
      name: novel.name,
      tier,
      readers: novel.readers,
      total: chapters.length,
      selected: selected.length,
      done,
      failed,
      pending,
      firstPending,
    });

    if (i % 5 === 4) await new Promise((r) => setImmediate(r));
  }

  return {
    scannedAt: Date.now(),
    totals: {
      novels: novels.length,
      chapters: totalChapters,
      selected: selectedTotal,
      done: doneTotal,
      failed: failedTotal,
      pending: pendingTotal,
    },
    tiers,
    books,
    failures,
  };
}

/** 获取扫描结果（带缓存） */
export async function getScan(force = false): Promise<ScanResult> {
  const fresh = scanCache && Date.now() - scanCache.scannedAt < SCAN_TTL;
  if (fresh && !force) return scanCache!;
  if (!scanInFlight) {
    scanInFlight = doScan()
      .then((s) => {
        scanCache = s;
        scanInFlight = null;
        return s;
      })
      .catch((e) => {
        scanInFlight = null;
        throw e;
      });
  }
  if (scanCache && !force) {
    scanInFlight.catch(() => {});
    return scanCache;
  }
  return scanInFlight;
}

// ---------- 队列预览（dry-run 计划） ----------

let planCache: PlanResult | null = null;
let planInFlight: Promise<PlanResult> | null = null;

/** 构建处理计划 */
async function doPlan(): Promise<PlanResult> {
  const cfg = getConfig();
  const novels = listNovels(cfg.libraryRoot, cfg.novels);
  const perBook: PlanResult['perBook'] = [];
  const queue: PlanResult['queue'] = [];
  let totalChapters = 0;
  let selectedChapters = 0;
  let pendingChapters = 0;
  let retryPending = 0;

  for (let i = 0; i < novels.length; i++) {
    const novel = novels[i];
    const chapters = listChapters(novel);
    const { tier, selected } = selectForNovel(novel, chapters);
    const pendingAll = selected.filter((c) => !isDone(c));
    const soft = pendingAll.filter((c) => isSoftFail(c));
    const fresh = pendingAll.filter((c) => !isSoftFail(c));
    const pending = [...soft, ...fresh];

    totalChapters += chapters.length;
    selectedChapters += selected.length;
    pendingChapters += pending.length;
    retryPending += soft.length;

    if (selected.length) {
      perBook.push({
        name: novel.name,
        tier,
        readers: novel.readers,
        selected: selected.length,
        pending: pending.length,
        done: selected.length - pending.length,
        retryPending: soft.length,
        next: pending.slice(0, 12).map((c) => c.name),
      });

      if (queue.length < 500) {
        for (const c of pending) {
          const mk = readSkipMarker(c);
          queue.push({
            book: novel.name,
            chapter: c.name,
            tier,
            input: c.inputPath,
            priority: isSoftFail(c) ? 'retry' : 'normal',
            attempts: mk?.attempts || 0,
            reason: mk?.reason || '',
          });
          if (queue.length >= 500) break;
        }
      }
    }

    if (i % 5 === 4) await new Promise((r) => setImmediate(r));
  }

  // 有失败章的小说整本排到最前
  perBook.sort((a, b) => (b.retryPending > 0 ? 1 : 0) - (a.retryPending > 0 ? 1 : 0));

  return {
    builtAt: Date.now(),
    totals: {
      novels: novels.length,
      chapters: totalChapters,
      selected: selectedChapters,
      pending: pendingChapters,
      retryPending,
    },
    perBook,
    queue,
  };
}

/** 获取处理计划（带缓存） */
export async function getPlan(force = false): Promise<PlanResult> {
  const fresh = planCache && Date.now() - planCache.builtAt < PLAN_TTL;
  if (fresh && !force) return planCache!;
  if (!planInFlight) {
    planInFlight = doPlan()
      .then((p) => {
        planCache = p;
        planInFlight = null;
        return p;
      })
      .catch((e) => {
        planInFlight = null;
        throw e;
      });
  }
  if (planCache && !force) {
    planInFlight.catch(() => {});
    return planCache;
  }
  return planInFlight;
}

/** 失效缓存 */
export function invalidateCaches(): void {
  scanCache = null;
  planCache = null;
  // 同时清除多任务扫描缓存
  for (const key of taskScanCache.keys()) {
    taskScanCache.delete(key);
  }
  for (const key of taskPlanCache.keys()) {
    taskPlanCache.delete(key);
  }
}

// ---------- 多任务扫描（outline/adapt/generate 通用） ----------

/** 任务扫描结果缓存 */
const taskScanCache = new Map<string, ScanResult>();
const taskScanInFlight: Map<string, Promise<ScanResult>> = new Map();

/** 任务计划缓存 */
const taskPlanCache = new Map<string, PlanResult>();

/** 列出任务的输入文件（通用版） */
function listTaskItems(scanCfg: TaskScanConfig, novel: NovelInfo): ChapterInfo[] {
  const itemDir = scanCfg.inputSubDir
    ? path.join(novel.dir, scanCfg.inputSubDir)
    : novel.dir;
  if (!fs.existsSync(itemDir)) return [];
  const skip = new Set((scanCfg.skipFiles || []).map((s) => s.toLowerCase()));
  const ext = scanCfg.inputExt.toLowerCase();
  const files = fs
    .readdirSync(itemDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => name.toLowerCase().endsWith(ext))
    .filter((name) => !skip.has(name.toLowerCase()));
  files.sort(collator.compare);
  return files.map((name) => {
    const base = name.replace(/\.[^.]+$/, '');
    // 输出路径：outputRoot/novelName/[outputSubDir]/base.outputExt
    const outDir = scanCfg.outputSubDir
      ? path.join(scanCfg.outputRoot, novel.name, scanCfg.outputSubDir)
      : path.join(scanCfg.outputRoot, novel.name);
    return {
      name,
      base,
      inputPath: path.join(itemDir, name),
      outputPath: path.join(outDir, base + (scanCfg.outputExt || '.md')),
    };
  });
}

/** 任务级别的选择逻辑（outline 用选择规则，其他任务全选） */
function selectForTask(
  scanCfg: TaskScanConfig,
  novel: NovelInfo,
  chapters: ChapterInfo[],
): { tier: NovelTier; selected: ChapterInfo[] } {
  if (!scanCfg.hasSelection) {
    // adapt/generate: 全选，tier 按 readers 分档（仅用于显示）
    const tier = tierOf(novel.readers);
    return { tier, selected: chapters };
  }
  // outline: 使用原有选择逻辑
  return selectForNovel(novel, chapters);
}

/** 任务级别的输出存在判断（支持镜像路径） */
function hasTaskOutput(scanCfg: TaskScanConfig, chapter: ChapterInfo): boolean {
  try {
    const st = fs.statSync(chapter.outputPath);
    return st.isFile() && st.size >= MIN_DONE_BYTES;
  } catch {
    // 检查镜像路径（仅 outline 有 movedDoneOutputDir）
    const movedDir = String(scanCfg.raw.movedDoneOutputDir || '').trim();
    const pipelineRoot = String(scanCfg.raw.pipelineRoot || '').trim();
    if (movedDir && pipelineRoot) {
      const novelName = path.basename(path.dirname(path.dirname(chapter.outputPath)));
      if (novelName) {
        try {
          const mirror = path.join(pipelineRoot, movedDir, novelName, path.basename(chapter.outputPath));
          const st = fs.statSync(mirror);
          return st.isFile() && st.size >= MIN_DONE_BYTES;
        } catch {
          return false;
        }
      }
    }
    return false;
  }
}

/** 任务级别的跳过标记路径 */
function taskSkipMarkerPath(chapter: ChapterInfo): string {
  return `${chapter.outputPath}.skip.json`;
}

/** 执行任务扫描 */
async function doScanForTask(taskId: string): Promise<ScanResult> {
  const scanCfg = getTaskScanConfig(taskId);
  const novels = listNovels(scanCfg.inputRoot, scanCfg.novels);
  const books: BookStats[] = [];
  const failures: FailureInfo[] = [];
  const tiers = {
    big: blankTier(),
    small: blankTier(),
    nodata: blankTier(),
  };
  let totalChapters = 0;
  let selectedTotal = 0;
  let doneTotal = 0;
  let failedTotal = 0;
  let pendingTotal = 0;

  for (let i = 0; i < novels.length; i++) {
    const novel = novels[i];
    const chapters = listTaskItems(scanCfg, novel);
    const { tier, selected } = selectForTask(scanCfg, novel, chapters);
    let done = 0;
    let failed = 0;
    let pending = 0;
    let firstPending: string | null = null;

    for (const ch of selected) {
      const skipPath = taskSkipMarkerPath(ch);
      const hasOutput = hasTaskOutput(scanCfg, ch);
      const isSkipped = nonEmptyFile(skipPath);

      if (hasOutput) {
        done++;
      } else if (isSkipped) {
        failed++;
        const mk = readJson<SkipMarker>(skipPath);
        failures.push({
          book: novel.name,
          chapter: ch.name,
          reason: mk?.reason || 'unknown',
          attempts: mk?.attempts || 0,
          retryable: mk?.reason !== 'policy_refusal' && Number(mk?.attempts || 1) < softCap(),
          createdAt: mk?.createdAt || null,
          outputPath: ch.outputPath,
        });
      } else {
        pending++;
        if (!firstPending) firstPending = ch.name;
        // 检查是否有软失败标记
        const mk = readJson<SkipMarker>(skipPath);
        if (mk && mk.reason !== 'policy_refusal' && Number(mk.attempts || 0) > 0) {
          failures.push({
            book: novel.name,
            chapter: ch.name,
            reason: mk.reason || 'soft_fail',
            attempts: mk.attempts || 0,
            retryable: true,
            createdAt: mk.createdAt || null,
            outputPath: ch.outputPath,
          });
        }
      }
    }

    totalChapters += chapters.length;
    selectedTotal += selected.length;
    doneTotal += done;
    failedTotal += failed;
    pendingTotal += pending;

    const t = tiers[tier];
    t.books++;
    t.selected += selected.length;
    t.done += done;
    t.failed += failed;
    t.pending += pending;

    books.push({
      name: novel.name,
      tier,
      readers: novel.readers,
      total: chapters.length,
      selected: selected.length,
      done,
      failed,
      pending,
      firstPending,
    });

    if (i % 5 === 4) await new Promise((r) => setImmediate(r));
  }

  return {
    scannedAt: Date.now(),
    totals: {
      novels: novels.length,
      chapters: totalChapters,
      selected: selectedTotal,
      done: doneTotal,
      failed: failedTotal,
      pending: pendingTotal,
    },
    tiers,
    books,
    failures,
  };
}

/** 获取任务扫描结果（带缓存） */
export async function getScanForTask(taskId: string, force = false): Promise<ScanResult> {
  const fresh = taskScanCache.get(taskId) && Date.now() - taskScanCache.get(taskId)!.scannedAt < SCAN_TTL;
  if (fresh && !force) return taskScanCache.get(taskId)!;
  const inFlight = taskScanInFlight.get(taskId);
  if (!inFlight) {
    const promise = doScanForTask(taskId)
      .then((s) => {
        taskScanCache.set(taskId, s);
        taskScanInFlight.delete(taskId);
        return s;
      })
      .catch((e) => {
        taskScanInFlight.delete(taskId);
        throw e;
      });
    taskScanInFlight.set(taskId, promise);
  }
  const cached = taskScanCache.get(taskId);
  if (cached && !force) {
    taskScanInFlight.get(taskId)!.catch(() => {});
    return cached;
  }
  return taskScanInFlight.get(taskId)!;
}

/** 获取任务的书本详情 */
export function getBookDetailsForTask(
  taskId: string,
  name: string,
): {
  name: string;
  tier: NovelTier;
  readers: number | null;
  total: number;
  selected: number;
  chapters: Array<{
    name: string;
    status: 'unselected' | 'retry' | 'failed' | 'done' | 'pending';
    outputPath: string;
    hasOutput: boolean;
    attempts: number;
    reason: string;
  }>;
} | null {
  const scanCfg = getTaskScanConfig(taskId);
  const novel = listNovels(scanCfg.inputRoot, [name])[0];
  if (!novel) return null;
  const chapters = listTaskItems(scanCfg, novel);
  const { tier, selected } = selectForTask(scanCfg, novel, chapters);
  const sel = new Set(selected.map((c) => c.name));
  const list = chapters.map((ch) => {
    let st: 'unselected' | 'retry' | 'failed' | 'done' | 'pending' = 'unselected';
    let marker: SkipMarker | null = null;
    if (sel.has(ch.name)) {
      const skipPath = taskSkipMarkerPath(ch);
      marker = readJson<SkipMarker>(skipPath);
      const hasOutput = hasTaskOutput(scanCfg, ch);
      const isSkipped = nonEmptyFile(skipPath);
      if (hasOutput) {
        st = 'done';
      } else if (isSkipped && marker?.reason === 'policy_refusal') {
        st = 'failed';
      } else if (isSkipped && Number(marker?.attempts || 1) >= softCap()) {
        st = 'failed';
      } else if (isSkipped) {
        st = 'retry';
      } else {
        st = 'pending';
      }
    }
    return {
      name: ch.name,
      status: st,
      outputPath: ch.outputPath,
      hasOutput: st === 'done',
      attempts: marker?.attempts || 0,
      reason: marker?.reason || '',
    };
  });
  return {
    name,
    tier,
    readers: novel.readers,
    total: chapters.length,
    selected: selected.length,
    chapters: list,
  };
}

// ---------- 单本/单章查询 ----------

/** 查询单本小说详情 */
export function getBookDetails(name: string): {
  name: string;
  tier: NovelTier;
  readers: number | null;
  total: number;
  selected: number;
  chapters: Array<{
    name: string;
    status: 'unselected' | 'retry' | 'failed' | 'done' | 'pending';
    outputPath: string;
    hasOutput: boolean;
    attempts: number;
    reason: string;
  }>;
} | null {
  const cfg = getConfig();
  const novel = listNovels(cfg.libraryRoot, [name])[0];
  if (!novel) return null;
  const chapters = listChapters(novel);
  const { tier, selected } = selectForNovel(novel, chapters);
  const sel = new Set(selected.map((c) => c.name));
  const list = chapters.map((ch) => {
    let st: 'unselected' | 'retry' | 'failed' | 'done' | 'pending' = 'unselected';
    let marker: SkipMarker | null = null;
    if (sel.has(ch.name)) {
      marker = readSkipMarker(ch);
      st = isSoftFail(ch) ? 'retry' : isSkipped(ch) ? 'failed' : isDone(ch) ? 'done' : 'pending';
    }
    return {
      name: ch.name,
      status: st,
      outputPath: ch.outputPath,
      hasOutput: st === 'done',
      attempts: marker?.attempts || 0,
      reason: marker?.reason || '',
    };
  });
  return {
    name,
    tier,
    readers: novel.readers,
    total: chapters.length,
    selected: selected.length,
    chapters: list,
  };
}
