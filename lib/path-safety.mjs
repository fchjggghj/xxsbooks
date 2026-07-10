import path from 'node:path';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const INVALID_SEGMENT_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

export function sanitizePathSegment(value, fallback = '未命名') {
  let result = String(value ?? '')
    .normalize('NFC')
    .replace(INVALID_SEGMENT_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120);

  if (!result || result === '.' || result === '..') result = fallback;
  if (WINDOWS_RESERVED.test(result)) result = `_${result}`;
  return result;
}

export function assertSafePathSegment(value, label = '名称') {
  const original = String(value ?? '').normalize('NFC').trim();
  const sanitized = sanitizePathSegment(original, '');
  if (!original || !sanitized || sanitized !== original) {
    throw new Error(`${label}包含 Windows 路径不允许的字符或格式: ${JSON.stringify(original)}`);
  }
  return sanitized;
}

export function resolveInside(root, ...segments) {
  const base = path.resolve(root);
  const candidate = path.resolve(base, ...segments);
  const relative = path.relative(base, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`目标路径越出允许目录: ${candidate}`);
  }
  return candidate;
}

export function canonicalPathKey(value) {
  return path.resolve(value).normalize('NFC').toLocaleLowerCase('en-US');
}
