import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { firstNonEmptyLine, replaceReplyTitle, assertChapterTitle } from '../lib/chapter-title.mjs';

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const apply = process.argv.includes('--apply');
const booksRoot = path.join(projectRoot, '书籍');
const backupRoot = path.join(booksRoot, '.state', 'title-backup-20260718');
const manifest = [];

async function atomicWrite(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, text, 'utf8');
  await fs.rename(temp, file);
}

const books = (await fs.readdir(booksRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));

for (const book of books) {
  const sourceDir = path.join(booksRoot, book, '原文');
  const bodyDir = path.join(booksRoot, book, '正文');
  if (!fssync.existsSync(sourceDir) || !fssync.existsSync(bodyDir)) continue;

  const bodyFiles = (await fs.readdir(bodyDir))
    .filter((name) => /^\d{4}\.md$/i.test(name))
    .sort();

  for (const bodyName of bodyFiles) {
    const stem = path.basename(bodyName, '.md');
    const sourcePath = ['.txt', '.md']
      .map((extension) => path.join(sourceDir, `${stem}${extension}`))
      .find((candidate) => fssync.existsSync(candidate));
    if (!sourcePath) throw new Error(`Missing source chapter: ${book}/${stem}`);

    const bodyPath = path.join(bodyDir, bodyName);
    const source = await fs.readFile(sourcePath, 'utf8');
    const body = await fs.readFile(bodyPath, 'utf8');
    const originalTitle = assertChapterTitle(firstNonEmptyLine(source), `${book}/${stem}`);
    const currentTitle = firstNonEmptyLine(body);
    const updated = replaceReplyTitle(body, originalTitle);
    const changed = currentTitle !== originalTitle;
    manifest.push({ book, chapter: stem, currentTitle, originalTitle, changed });

    if (apply && changed) {
      const backupPath = path.join(backupRoot, book, bodyName);
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await atomicWrite(backupPath, body);
      await atomicWrite(bodyPath, updated);
    }
  }
}

if (apply) {
  await fs.mkdir(backupRoot, { recursive: true });
  await atomicWrite(
    path.join(backupRoot, 'manifest.json'),
    `${JSON.stringify({ createdAt: new Date().toISOString(), chapters: manifest }, null, 2)}\n`,
  );
}

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'preview',
  chapters: manifest.length,
  changed: manifest.filter((item) => item.changed).length,
  unchanged: manifest.filter((item) => !item.changed).length,
  backupRoot: apply ? backupRoot : null,
  samples: manifest.filter((item) => item.changed).slice(0, 12),
}, null, 2));
