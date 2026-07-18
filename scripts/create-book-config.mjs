import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
let bookName = '';
let apply = false;
let chapters = 60;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--apply') apply = true;
  else if (arg === '--chapters') chapters = Number(args[++index]);
  else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
  else if (!bookName) bookName = String(arg).trim();
  else throw new Error(`Unexpected argument: ${arg}`);
}
if (!bookName) throw new Error('Usage: node scripts/create-book-config.mjs <书名> [--chapters N] [--apply]');
if (!Number.isInteger(chapters) || chapters < 1) throw new Error('--chapters must be a positive integer.');

const projectRoot = process.cwd();
const bookDir = path.join(projectRoot, '书籍', bookName);
if (!fssync.existsSync(bookDir)) throw new Error(`Book directory not found: ${bookDir}`);
const configDir = path.join(projectRoot, 'config', 'books');
if (apply) await fs.mkdir(configDir, { recursive: true });
const files = fssync.existsSync(configDir)
  ? (await fs.readdir(configDir)).filter((name) => name.endsWith('.json')).sort()
  : [];
for (const file of files) {
  const existing = JSON.parse(await fs.readFile(path.join(configDir, file), 'utf8'));
  if (existing.name === bookName) {
    console.log(JSON.stringify({ mode: 'existing', book: bookName, file: path.join(configDir, file) }, null, 2));
    process.exit(0);
  }
}

const next = Math.max(0, ...files.map((name) => Number(path.basename(name, '.json')) || 0)) + 1;
const target = path.join(configDir, `${String(next).padStart(3, '0')}.json`);
const config = {
  name: bookName,
  enabled: true,
  stages: {
    chai: { enabled: true, chapterRange: { start: 1, end: chapters } },
    xie: { enabled: true, chapterRange: { start: 1, end: chapters } },
  },
};
if (apply) await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', book: bookName, chapters, file: target, config }, null, 2));
