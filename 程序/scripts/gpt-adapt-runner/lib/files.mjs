// step2 改编大纲的文件逻辑（不依赖浏览器，可 dry-run 验证）：
// 输入：data/01_broken_outlines/<本>/第NNN章.md（step1 的成品快照）
// 输出：data/02_adapted/<本>/第NNN章.md
// 断点：输出已存在且 ≥800B 即跳过。
import fs from 'node:fs';
import path from 'node:path';

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

const MIN_DONE_BYTES = 800;

/** 列出 inputRoot 下的小说文件夹。novelsFilter 为空数组时＝全部。 */
export function listNovels(inputRoot, novelsFilter) {
  if (!fs.existsSync(inputRoot)) {
    throw new Error(`输入根目录不存在: ${inputRoot}`);
  }
  let names;
  if (Array.isArray(novelsFilter) && novelsFilter.length) {
    names = novelsFilter.slice();
  } else {
    names = fs.readdirSync(inputRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
  names.sort(collator.compare);
  return names
    .map((name) => ({ name, dir: path.join(inputRoot, name) }))
    .filter((n) => fs.existsSync(n.dir));
}

/** 列出某本小说输入目录里的 .md 大纲文件，自然排序。 */
export function listOutlines(novel, cfg) {
  if (!fs.existsSync(novel.dir)) return [];
  const ext = (cfg.inputExt || '.md').toLowerCase();
  const files = fs.readdirSync(novel.dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => name.toLowerCase().endsWith(ext));
  files.sort(collator.compare);
  return files.map((name) => {
    const base = name.replace(/\.[^.]+$/, '');
    return {
      name,
      base,
      inputPath: path.join(novel.dir, name),
      outputPath: path.join(cfg.outputRoot, novel.name, base + (cfg.outputExt || '.md')),
    };
  });
}

function fileExists(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

/** 断点：输出文件已存在且 ≥800B ＝ 已处理过，跳过。 */
export function isDone(outline) {
  try {
    const st = fs.statSync(outline.outputPath);
    return st.isFile() && st.size >= MIN_DONE_BYTES;
  } catch {
    return false;
  }
}

export function readOutline(outline) {
  return fs.readFileSync(outline.inputPath, 'utf8');
}

export function writeOutput(outline, text) {
  const dir = path.dirname(outline.outputPath);
  fs.mkdirSync(dir, { recursive: true });

  if (isDone(outline)) return false;

  // 原子写入：先写临时文件，再 rename，避免崩溃时丢失数据
  const tmpPath = outline.outputPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, text, { encoding: 'utf8' });
    fs.renameSync(tmpPath, outline.outputPath);
    return true;
  } catch (err) {
    // 清理临时文件
    try { fs.unlinkSync(tmpPath); } catch {}
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

/** 获取对话URL持久化文件路径 */
export function conversationUrlPath(novel, cfg) {
  return path.join(cfg.outputRoot, novel.name, '.conversation_url');
}

/** 读取已保存的对话URL */
export function readConversationUrl(novel, cfg) {
  const p = conversationUrlPath(novel, cfg);
  try {
    if (fs.existsSync(p)) {
      const url = fs.readFileSync(p, 'utf8').trim();
      if (url && /^https?:\/\//.test(url)) return url;
    }
  } catch {}
  return null;
}

/** 保存对话URL */
export function saveConversationUrl(novel, cfg, url) {
  const p = conversationUrlPath(novel, cfg);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, url, 'utf8');
}

/** 删除对话URL（小说完成时清理） */
export function deleteConversationUrl(novel, cfg) {
  const p = conversationUrlPath(novel, cfg);
  try { fs.unlinkSync(p); } catch {}
}

/** 构建处理计划：每本小说 → 全部输入大纲 → 过滤出待处理。 */
export function buildPlan(cfg) {
  const novels = listNovels(cfg.inputRoot, cfg.novels);
  const plan = [];
  let totalOutlines = 0;
  let pendingOutlines = 0;

  for (const novel of novels) {
    const outlines = listOutlines(novel, cfg);
    const pending = outlines.filter((o) => !isDone(o));
    totalOutlines += outlines.length;
    pendingOutlines += pending.length;
    plan.push({ novel, outlines, pending });
  }

  return {
    plan,
    totalNovels: novels.length,
    totalOutlines,
    pendingOutlines,
  };
}
