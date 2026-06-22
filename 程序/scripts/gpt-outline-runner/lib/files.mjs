// 纯文件逻辑（不依赖浏览器，可单独 dry-run 验证）：
// 列小说、列章节、自然排序、断点判断（输出已存在则跳过）、输出路径。
import fs from 'node:fs';
import path from 'node:path';
import { parseReaders, selectForNovel, tierOf } from './select.mjs';

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

/** 列出要处理的小说文件夹。novelsFilter 为空数组时＝全库。 */
export function listNovels(libraryRoot, novelsFilter) {
  if (!fs.existsSync(libraryRoot)) {
    throw new Error(`素材库根目录不存在: ${libraryRoot}`);
  }
  let names;
  if (Array.isArray(novelsFilter) && novelsFilter.length) {
    names = novelsFilter.slice();
  } else {
    names = fs.readdirSync(libraryRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
  names.sort(collator.compare);
  return names
    .map((name) => ({ name, dir: path.join(libraryRoot, name), readers: parseReaders(name) }))
    .filter((n) => fs.existsSync(n.dir));
}

/** 列出某本小说「章节」文件夹里的章节文件，自然排序，跳过 skipFiles 和非 .txt。 */
export function listChapters(novel, cfg) {
  const chDir = path.join(novel.dir, cfg.chaptersDir);
  if (!fs.existsSync(chDir)) return [];
  const skip = new Set((cfg.skipFiles || []).map((s) => s.toLowerCase()));
  const files = fs.readdirSync(chDir, { withFileTypes: true })
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

/** 断点：输出文件已存在且非空 ＝ 已处理过，跳过。 */
// 有效产出的最小字节数：真大纲都 2KB+；拒答/报错/空白等垃圾都 <600B。
// 卡 800B 能准确区分——小于此一律视为"未成功生成"，断点续传会重做。
const MIN_DONE_BYTES = 800;

function mirrorOutputPath(chapter, cfg = {}) {
  const root = String(cfg.pipelineRoot || '').trim();
  const movedDir = String(cfg.movedDoneOutputDir || '').trim();
  if (!root || !movedDir) return null;
  const novelName = path.basename(path.dirname(path.dirname(chapter.outputPath)));
  if (!novelName) return null;
  return path.join(root, movedDir, novelName, path.basename(chapter.outputPath));
}

function hasDoneOutput(chapter, cfg = {}) {
  try {
    const st = fs.statSync(chapter.outputPath);
    return st.isFile() && st.size >= MIN_DONE_BYTES;
  } catch {
    const mirror = mirrorOutputPath(chapter, cfg);
    if (!mirror) return false;
    try {
      const st = fs.statSync(mirror);
      return st.isFile() && st.size >= MIN_DONE_BYTES;
    } catch {
      return false;
    }
  }
}

function fileExists(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

function nonEmptyFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function readLockPid(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid || 0);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function skipMarkerPath(chapter) {
  return `${chapter.outputPath}.skip.json`;
}

export function lockMarkerPath(chapter) {
  return `${chapter.outputPath}.lock`;
}

export function isSkipped(chapter) {
  return nonEmptyFile(skipMarkerPath(chapter));
}

/** 读跳过标记内容（含 reason / attempts）；无则 null。 */
export function readSkipMarker(chapter) {
  try { return JSON.parse(fs.readFileSync(skipMarkerPath(chapter), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

/** 软失败重试上限：软失败累计尝试达到此值后转为永久放弃（默认 5）。 */
function softCap(cfg) { return Number(cfg?.softRetryCap ?? 5); }

/** 永久放弃（不再重试）：政策拒绝，或软失败已重试到上限。 */
export function isPermanentSkip(chapter, cfg) {
  const m = readSkipMarker(chapter);
  if (!m) return false;
  if (m.reason === 'policy_refusal') return true;
  return Number(m.attempts || 1) >= softCap(cfg);
}

/** 软失败（可重试、应优先排队）：有标记、非政策拒绝、未到重试上限、且还没成功产出。 */
export function isSoftFail(chapter, cfg) {
  if (hasDoneOutput(chapter, cfg)) return false;
  const m = readSkipMarker(chapter);
  if (!m || m.reason === 'policy_refusal') return false;
  return Number(m.attempts || 1) < softCap(cfg);
}

/** 删除跳过标记（成功生成后调用，让记录回归"已完成"）。 */
export function clearSkipMarker(chapter) {
  try { fs.unlinkSync(skipMarkerPath(chapter)); return true; }
  catch (err) { if (err?.code !== 'ENOENT') throw err; return false; }
}

/** 已完成（跳过续传）＝ 有有效产出 或 永久放弃。软失败不算完成→会被重新尝试。 */
export function isDone(chapter, cfg) {
  return hasDoneOutput(chapter, cfg) || isPermanentSkip(chapter, cfg);
}

export function readChapter(chapter) {
  return fs.readFileSync(chapter.inputPath, 'utf8');
}

export function claimChapter(chapter, cfg = {}) {
  if (isDone(chapter, cfg)) return { claimed: false, reason: 'done' };

  const dir = path.dirname(chapter.outputPath);
  fs.mkdirSync(dir, { recursive: true });

  const lockPath = lockMarkerPath(chapter);
  const staleMs = Number(cfg.chapterLockStaleMs ?? 6 * 60 * 60 * 1000);

  for (let i = 0; i < 2; i++) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        inputPath: chapter.inputPath,
        outputPath: chapter.outputPath,
      }, null, 2), 'utf8');
      return { claimed: true, lockPath };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
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
        if (staleErr?.code !== 'ENOENT') throw staleErr;
        continue;
      }

      return { claimed: false, reason: 'locked', lockPath };
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
  }

  return { claimed: false, reason: 'locked', lockPath };
}

export function releaseChapterClaim(claim) {
  if (!claim?.claimed || !claim.lockPath) return;
  try {
    fs.unlinkSync(claim.lockPath);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

export function writeOutput(chapter, text) {
  const dir = path.dirname(chapter.outputPath);
  fs.mkdirSync(dir, { recursive: true });

  if (isDone(chapter)) return false;

  if (fileExists(chapter.outputPath)) {
    fs.unlinkSync(chapter.outputPath);
  }

  try {
    fs.writeFileSync(chapter.outputPath, text, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

export function writeSkipMarker(chapter, reason, details = {}) {
  const dir = path.dirname(chapter.outputPath);
  fs.mkdirSync(dir, { recursive: true });

  if (hasDoneOutput(chapter)) return false;
  if (fileExists(chapter.outputPath)) fs.unlinkSync(chapter.outputPath);

  const prev = readSkipMarker(chapter);
  // 政策拒绝＝直接永久放弃；其它＝软失败，累计 attempts（达到 softCap 后转永久放弃）。
  const attempts = reason === 'policy_refusal' ? 1 : (Number(prev?.attempts || 0) + 1);
  const markerPath = skipMarkerPath(chapter);
  const payload = {
    reason,
    attempts,
    createdAt: prev?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    chapter: chapter.name,
    inputPath: chapter.inputPath,
    outputPath: chapter.outputPath,
    ...details,
  };

  // 允许覆盖（累计 attempts）。软失败会在后续轮次被优先重试，到上限才永久放弃。
  fs.writeFileSync(markerPath, JSON.stringify(payload, null, 2), 'utf8');
  return true;
}

/** 构建处理计划：每本小说 → 按规则选中的、且未完成的待处理章节。 */
export function buildPlan(cfg) {
  const novels = listNovels(cfg.libraryRoot, cfg.novels);
  const plan = [];
  let totalChapters = 0;
  let selectedChapters = 0;
  let pendingChapters = 0;
  const tierCount = { big: 0, small: 0, nodata: 0 };
  const tierSelected = { big: 0, small: 0, nodata: 0 };
  let retryPending = 0;
  for (const novel of novels) {
    const chapters = listChapters(novel, cfg);
    const { tier, selected } = selectForNovel(novel, chapters, cfg);
    const pendingAll = selected.filter((c) => !isDone(c, cfg));
    // 失败优先：软失败（可重试）排在本书待处理最前面，再接没生成过的。
    const soft = pendingAll.filter((c) => isSoftFail(c, cfg));
    const fresh = pendingAll.filter((c) => !isSoftFail(c, cfg));
    const pending = [...soft, ...fresh];
    totalChapters += chapters.length;
    selectedChapters += selected.length;
    pendingChapters += pending.length;
    retryPending += soft.length;
    tierCount[tier] += 1;
    tierSelected[tier] += selected.length;
    plan.push({ novel, tier, chapters, selected, pending, softCount: soft.length });
  }
  // 有失败章的小说整本排到最前（稳定排序，其余保持原顺序）。
  plan.sort((a, b) => (b.softCount > 0 ? 1 : 0) - (a.softCount > 0 ? 1 : 0));
  return {
    plan,
    totalNovels: novels.length,
    totalChapters,
    selectedChapters,
    pendingChapters,
    retryPending,
    tierCount,
    tierSelected,
  };
}
