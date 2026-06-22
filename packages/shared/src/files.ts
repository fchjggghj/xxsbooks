/**
 * 文件操作工具（两个 runner 共享）
 */
import fs from 'node:fs';
import path from 'node:path';
import { naturalCompare } from './utils.js';
import type { Novel, OutlineItem, Plan } from './types.js';

/** 最小完成字节数 */
export const MIN_DONE_BYTES = 800;

/** 文件是否存在 */
export function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 列出目录下的文件（自然排序） */
export function listFiles(dir: string, ext: string): string[] {
  if (!fileExists(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(ext.toLowerCase()))
      .sort(naturalCompare);
  } catch {
    return [];
  }
}

/** 列出目录下的子目录 */
export function listDirs(dir: string): string[] {
  if (!fileExists(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(naturalCompare);
  } catch {
    return [];
  }
}

/** 读取文件内容（安全） */
export function readFile(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** 原子写入文件（先写 tmp 再 rename） */
export function writeFile(p: string, content: string): boolean {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/** 获取文件大小 */
export function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** 判断大纲是否已完成（文件存在且 >= minBytes） */
export function isDone(outline: OutlineItem, minBytes = MIN_DONE_BYTES): boolean {
  return fileSize(outline.outputPath) >= minBytes;
}

/** 列出小说目录 */
export function listNovels(root: string, filter?: string[]): Novel[] {
  const names = listDirs(root);
  const filtered = filter?.length ? names.filter((n) => filter.includes(n)) : names;
  return filtered.map((name) => ({
    name,
    path: path.join(root, name),
    totalChapters: 0,
    selectedChapters: 0,
    doneChapters: 0,
    failedChapters: 0,
    pendingChapters: 0,
  }));
}

/** 列出大纲条目 */
export function listOutlines(
  novel: Novel,
  inputDir: string,
  outputDir: string,
  ext: string,
): OutlineItem[] {
  const inDir = path.join(inputDir, novel.name);
  const outDir = path.join(outputDir, novel.name);
  const files = listFiles(inDir, ext);
  return files.map((name) => {
    const base = name.replace(new RegExp(`${ext}$`, 'i'), '');
    return {
      name,
      base,
      inputPath: path.join(inDir, name),
      outputPath: path.join(outDir, name),
      novel,
    } satisfies OutlineItem;
  });
}

/** 构建处理计划 */
export function buildPlan(
  novels: Novel[],
  inputDir: string,
  outputDir: string,
  ext: string,
  minBytes = MIN_DONE_BYTES,
): { plan: Plan[]; totalNovels: number; totalOutlines: number; pendingOutlines: number } {
  const plan: Plan[] = [];
  let totalOutlines = 0;
  let pendingOutlines = 0;

  for (const novel of novels) {
    const outlines = listOutlines(novel, inputDir, outputDir, ext);
    const pending = outlines.filter((o) => !isDone(o, minBytes));
    novel.totalChapters = outlines.length;
    novel.doneChapters = outlines.length - pending.length;
    novel.pendingChapters = pending.length;
    totalOutlines += outlines.length;
    pendingOutlines += pending.length;
    if (outlines.length) plan.push({ novel, outlines, pending });
  }

  return { plan, totalNovels: novels.length, totalOutlines, pendingOutlines };
}

/** 对话 URL 持久化 */
export function conversationUrlPath(outputRoot: string, novelName: string): string {
  return path.join(outputRoot, novelName, '.conversation_url');
}

export function readConversationUrl(outputRoot: string, novelName: string): string | null {
  const p = conversationUrlPath(outputRoot, novelName);
  try {
    if (fs.existsSync(p)) {
      const url = fs.readFileSync(p, 'utf8').trim();
      if (url && /^https?:\/\//.test(url)) return url;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function saveConversationUrl(outputRoot: string, novelName: string, url: string): void {
  writeFile(conversationUrlPath(outputRoot, novelName), url);
}

export function deleteConversationUrl(outputRoot: string, novelName: string): void {
  try {
    fs.unlinkSync(conversationUrlPath(outputRoot, novelName));
  } catch {
    /* ignore */
  }
}
