import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

function normalizeRange(value, context) {
  if (!value) return null;
  const start = Number(value.start);
  const end = value.end == null ? Infinity : Number(value.end);
  if (!Number.isInteger(start) || start < 1 || !(end === Infinity || (Number.isInteger(end) && end >= start))) {
    throw new Error(`Invalid chapterRange in ${context}`);
  }
  return { start, end };
}

export async function loadBookCatalog(cfg) {
  const mode = String(cfg.bookCatalogMode || 'discover');
  if (!cfg.bookConfigDir) return { mode, books: new Map(), sourceFiles: [] };
  if (!fssync.existsSync(cfg.bookConfigDir)) {
    if (mode === 'explicit') throw new Error(`Book config directory not found: ${cfg.bookConfigDir}`);
    return { mode, books: new Map(), sourceFiles: [] };
  }

  const names = (await fs.readdir(cfg.bookConfigDir))
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort();
  const books = new Map();
  const sourceFiles = [];
  for (const name of names) {
    const file = path.join(cfg.bookConfigDir, name);
    const raw = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    const bookName = String(raw.name || '').trim();
    if (!bookName) throw new Error(`Book config has no name: ${file}`);
    if (books.has(bookName)) throw new Error(`Duplicate book config: ${bookName}`);
    const stages = {};
    for (const stage of ['chai', 'xie']) {
      const item = raw.stages?.[stage] || {};
      stages[stage] = {
        enabled: item.enabled !== false,
        chapterRange: normalizeRange(item.chapterRange, `${name}:${stage}`),
      };
    }
    books.set(bookName, { name: bookName, enabled: raw.enabled !== false, stages, sourceFile: file });
    sourceFiles.push(file);
  }
  return { mode, books, sourceFiles };
}

export function settingsForBook(catalog, bookName, stage, fallbackRange = null) {
  const item = catalog.books.get(bookName);
  if (!item) {
    return { enabled: catalog.mode !== 'explicit', chapterRange: fallbackRange, configured: false };
  }
  const stageSettings = item.stages[stage] || { enabled: true, chapterRange: null };
  return {
    enabled: item.enabled && stageSettings.enabled,
    chapterRange: stageSettings.chapterRange || fallbackRange,
    configured: true,
  };
}
