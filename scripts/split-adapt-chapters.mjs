import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_INPUT = 'output/02_adapt';
const DEFAULT_OUTPUT = 'output/02_adapt_chapters';

function parseArgs(argv) {
  const out = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    dryRun: false,
    keep: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input') out.input = argv[++i] || out.input;
    else if (arg === '--output') out.output = argv[++i] || out.output;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--keep') out.keep = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

function resolveInside(root, value) {
  const resolved = path.resolve(root, value);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside project root: ${resolved}`);
  }
  return resolved;
}

async function walkMarkdown(dir) {
  if (!fssync.existsSync(dir)) return [];
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdown(full)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }

  return out;
}

function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '')
    .slice(0, 40) || '未命名';
}

function pad(num, width = 3) {
  return String(num).padStart(width, '0');
}

function novelDirFor(inputRoot, file) {
  const relative = path.relative(inputRoot, file);
  const parts = relative.split(path.sep);
  return parts.length > 1 ? parts[0] : '';
}

function headingRegex(strict = true) {
  return strict
    ? /^#{1,4}\s*新第\s*([0-9一二三四五六七八九十百]+)\s*章[：:、\-\s]*(.*)$/gm
    : /^#{1,4}\s*(?:新)?第\s*([0-9一二三四五六七八九十百]+)\s*章[：:、\-\s]*(.*)$/gm;
}

function findChapterHeadings(text) {
  let matches = [...text.matchAll(headingRegex(true))];
  if (matches.length === 0) matches = [...text.matchAll(headingRegex(false))];
  return matches;
}

function findTailCut(text, start) {
  const tail = text.slice(start);
  const match = tail.match(/^#{1,3}\s*(?:下批承接摘要|承接摘要|承接记录|批次承接摘要)\s*$/m);
  return match ? start + match.index : text.length;
}

function splitChapters(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  const headings = findChapterHeadings(text);
  if (headings.length === 0) return [];

  const sections = [];
  for (let i = 0; i < headings.length; i++) {
    const match = headings[i];
    const next = headings[i + 1];
    const start = match.index;
    const end = next ? next.index : findTailCut(text, start);
    const body = text.slice(start, end).trim();
    if (!body) continue;
    sections.push({
      localNumber: match[1],
      title: match[2].trim() || `新第${i + 1}章`,
      body,
    });
  }

  return sections;
}

async function main() {
  const projectRoot = process.cwd();
  const opts = parseArgs(process.argv);
  const inputRoot = resolveInside(projectRoot, opts.input);
  const outputRoot = resolveInside(projectRoot, opts.output);

  if (!opts.dryRun && !opts.keep) {
    const rel = path.relative(projectRoot, outputRoot);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Refusing to clean unsafe output path: ${outputRoot}`);
    }
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
  if (!opts.dryRun) await fs.mkdir(outputRoot, { recursive: true });

  const files = await walkMarkdown(inputRoot);
  const grouped = new Map();
  for (const file of files) {
    const novelDir = novelDirFor(inputRoot, file);
    if (!grouped.has(novelDir)) grouped.set(novelDir, []);
    grouped.get(novelDir).push(file);
  }

  let inputFiles = 0;
  let outputFiles = 0;
  const warnings = [];

  for (const [novelDir, novelFiles] of grouped.entries()) {
    novelFiles.sort((a, b) =>
      path.relative(inputRoot, a).localeCompare(path.relative(inputRoot, b), 'zh-Hans-CN', {
        numeric: true,
      }),
    );

    let chapterIndex = 1;
    for (const file of novelFiles) {
      inputFiles++;
      const raw = await fs.readFile(file, 'utf8');
      const chapters = splitChapters(raw);
      if (chapters.length === 0) {
        warnings.push(`No chapter headings found: ${path.relative(projectRoot, file)}`);
        continue;
      }

      const baseName = sanitizeFileName(path.parse(file).name);
      const outDir = path.join(outputRoot, novelDir);
      if (!opts.dryRun) await fs.mkdir(outDir, { recursive: true });

      for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i];
        const title = sanitizeFileName(chapter.title || `新第${i + 1}章`);
        const outName = `${pad(chapterIndex)}_${title}__from__${baseName}__${pad(i + 1, 2)}.md`;
        const outPath = path.join(outDir, outName);
        const content = `${chapter.body.trim()}\n`;
        outputFiles++;
        chapterIndex++;

        if (opts.dryRun) {
          console.log(`${path.relative(projectRoot, file)} -> ${path.relative(projectRoot, outPath)}`);
        } else {
          await fs.writeFile(outPath, content, 'utf8');
        }
      }
    }
  }

  console.log(`Input batch files: ${inputFiles}`);
  console.log(`Output chapter files: ${outputFiles}`);
  if (warnings.length) {
    console.warn('Warnings:');
    for (const warning of warnings) console.warn(`- ${warning}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
