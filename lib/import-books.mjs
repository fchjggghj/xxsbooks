import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalPathKey, resolveInside, sanitizePathSegment } from './path-safety.mjs';
import { sortByLeadingNumber } from './naming.mjs';

export async function readBookName(infoFile, fallbackName) {
  try {
    const text = await fs.readFile(infoFile, 'utf8');
    const match = text.replace(/^\uFEFF/, '').match(/^#\s+(.+?)\s*$/m);
    if (!match) throw new Error(`无法从 ${infoFile} 提取书名（需要一行“# 书名”）`);
    return match[1].trim();
  } catch (error) {
    if (error?.code === 'ENOENT') return fallbackName;
    throw error;
  }
}

async function sourceChapterFiles(srcBookDir) {
  let sourceDir = path.join(srcBookDir, '拆分章节');
  if (!fssync.existsSync(sourceDir)) sourceDir = path.join(srcBookDir, '原著原文');
  if (!fssync.existsSync(sourceDir)) {
    return { sourceDir: null, files: [], reason: '无 拆分章节/ 或 原著原文/ 目录' };
  }
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
    .map((entry) => entry.name)
    .sort(sortByLeadingNumber);
  return {
    sourceDir,
    files,
    reason: files.length ? '' : `${path.basename(sourceDir)}/ 下无 .txt 文件`,
  };
}

export async function createImportPlan(srcRoot, targetRoot) {
  const entries = await fs.readdir(srcRoot, { withFileTypes: true });
  const sourceBooks = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));

  const plan = [];
  for (const sourceDirName of sourceBooks) {
    const srcBookDir = path.join(srcRoot, sourceDirName);
    const rawBookName = await readBookName(
      path.join(srcBookDir, '书籍信息.md'),
      sourceDirName.replace(/^\d+_/, '').replace(/_无数据_.*$/, ''),
    );
    const bookName = sanitizePathSegment(rawBookName);
    const destination = resolveInside(targetRoot, bookName);
    const source = await sourceChapterFiles(srcBookDir);
    const width = Math.max(4, String(source.files.length).length);
    plan.push({
      sourceDirName,
      srcBookDir,
      rawBookName,
      bookName,
      renamed: rawBookName !== bookName,
      sourceDir: source.sourceDir,
      sourceLabel: source.sourceDir ? path.basename(source.sourceDir) : '',
      files: source.files.map((name, index) => ({
        sourceName: name,
        sourcePath: path.join(source.sourceDir || '', name),
        targetName: `${String(index + 1).padStart(width, '0')}.txt`,
      })),
      destination,
      status: source.reason ? 'skip' : 'ready',
      reason: source.reason,
    });
  }

  const byDestination = new Map();
  for (const item of plan.filter((entry) => entry.status === 'ready')) {
    const key = canonicalPathKey(item.destination);
    const group = byDestination.get(key) || [];
    group.push(item);
    byDestination.set(key, group);
  }
  for (const group of byDestination.values()) {
    if (group.length <= 1) continue;
    for (const item of group) {
      item.status = 'conflict';
      item.reason = `同一批次有 ${group.length} 个来源映射到同一书名“${item.bookName}”`;
    }
  }
  for (const item of plan.filter((entry) => entry.status === 'ready')) {
    if (fssync.existsSync(item.destination)) {
      item.status = 'conflict';
      item.reason = '目标书目录已存在，为避免混合两个版本，未导入任何章节';
    }
  }
  return plan;
}

export async function applyBookImport(item, targetRoot, options = {}) {
  if (item.status !== 'ready') return item;
  await fs.mkdir(targetRoot, { recursive: true });
  const stageName = `.import-${sanitizePathSegment(item.bookName, 'book').slice(0, 40)}-${randomUUID()}.tmp`;
  const stageDir = resolveInside(targetRoot, stageName);
  const stageSourceDir = path.join(stageDir, '原文');
  const copyFile = options.copyFile || ((source, destination) => fs.copyFile(source, destination));

  try {
    await fs.mkdir(stageSourceDir, { recursive: true });
    for (const file of item.files) {
      await copyFile(file.sourcePath, path.join(stageSourceDir, file.targetName));
    }
    // 同盘 rename 是原子切换；目标在检查后被其他进程创建时也会安全失败。
    await fs.rename(stageDir, item.destination);
    return { ...item, status: 'done', imported: item.files.length };
  } catch (error) {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function applyImportPlan(plan, targetRoot, options = {}) {
  const results = [];
  for (const item of plan) {
    if (item.status !== 'ready') {
      results.push(item);
      continue;
    }
    results.push(await applyBookImport(item, targetRoot, options));
  }
  return results;
}
