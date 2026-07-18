import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

const CHAPTER_TITLE_PATTERN = /^第(?:\d+|[一二三四五六七八九十百千万零〇两]+)章/u;

export function firstNonEmptyLine(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim() || '';
}

export function assertChapterTitle(title, context = 'chapter') {
  const value = String(title || '').trim();
  if (!CHAPTER_TITLE_PATTERN.test(value)) {
    throw new Error(`Invalid original title for ${context}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function replaceReplyTitle(reply, originalTitle) {
  const title = assertChapterTitle(originalTitle);
  const normalized = String(reply ?? '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const lines = normalized.split('\n');
  const firstIndex = lines.findIndex((line) => line.trim());
  if (firstIndex === -1) return `${title}\n`;

  if (CHAPTER_TITLE_PATTERN.test(lines[firstIndex].trim())) {
    lines[firstIndex] = title;
  } else {
    lines.splice(firstIndex, 0, title, '');
  }
  return `${lines.join('\n').trim()}\n`;
}

export async function resolveOriginalTitle(cfg, task) {
  const policy = cfg.titlePolicy;
  if (!policy || policy.mode === 'reply') return '';
  if (policy.mode !== 'source-first-line') {
    throw new Error(`Unsupported titlePolicy.mode: ${policy.mode}`);
  }

  const sourceSubdir = String(policy.sourceSubdir || '原文');
  const novelParts = task.novelKey.split(/[\\/]+/).filter(Boolean);
  const input = task.inputFiles[0].inputPath;
  const stem = path.basename(input, path.extname(input));
  const extensions = Array.isArray(policy.extensions) && policy.extensions.length
    ? policy.extensions
    : ['.txt', '.md'];

  for (const extension of extensions) {
    const ext = String(extension).startsWith('.') ? String(extension) : `.${extension}`;
    const candidate = path.join(cfg.inputDir, ...novelParts, sourceSubdir, `${stem}${ext}`);
    if (!fssync.existsSync(candidate)) continue;
    const title = firstNonEmptyLine(await fs.readFile(candidate, 'utf8'));
    return assertChapterTitle(title, task.id);
  }

  if (policy.required !== false) {
    throw new Error(`Original title source not found for ${task.id} (${stem})`);
  }
  return '';
}
