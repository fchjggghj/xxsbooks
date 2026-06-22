import fs from 'node:fs';
import path from 'node:path';

const CONTROL_URL = process.env.CONTROL_URL || 'http://127.0.0.1:8787';
const PIPELINE_ROOT = process.env.PIPELINE_ROOT || 'C:\\Users\\Administrator\\Desktop\\novel_pipeline';
const PIPELINE_STEP1_DIR = path.join(PIPELINE_ROOT, 'data', '01_broken_outlines');
const REPORT_DIR = path.join(PIPELINE_ROOT, '程序', 'logs'); // logs 已并入 程序\

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function api(route) {
  const res = await fetch(CONTROL_URL + route);
  if (!res.ok) throw new Error(`${route} -> HTTP ${res.status}`);
  return await res.json();
}

function chapterNo(name = '') {
  const m = String(name).match(/第\s*0*(\d+)\s*章/);
  return m ? Number(m[1]) : null;
}

function expectedPipelinePath(bookName, chapterName) {
  const base = String(chapterName || '').replace(/\.[^.]+$/, '.md');
  return path.join(PIPELINE_STEP1_DIR, bookName, base);
}

function summarizeBook(book, detail) {
  const selected = (detail.chapters || []).filter((c) => c.status !== 'unselected');
  const statuses = {};
  for (const c of selected) statuses[c.status] = (statuses[c.status] || 0) + 1;

  let continuousDone = 0;
  while (continuousDone < selected.length && selected[continuousDone].status === 'done') continuousDone++;

  let lastDone = -1;
  for (let i = selected.length - 1; i >= 0; i--) {
    if (selected[i].status === 'done') { lastDone = i; break; }
  }

  const internalGaps = [];
  if (lastDone >= 0) {
    for (let i = 0; i < lastDone; i++) {
      if (selected[i].status !== 'done') {
        internalGaps.push({
          index: i + 1,
          chapterNo: chapterNo(selected[i].name),
          name: selected[i].name,
          status: selected[i].status,
          reason: selected[i].reason || '',
        });
      }
    }
  }

  const pipelineMissing = [];
  for (const c of selected) {
    if (c.status !== 'done') continue;
    const target = expectedPipelinePath(book.name, c.name);
    if (!fs.existsSync(target)) {
      pipelineMissing.push({
        chapterNo: chapterNo(c.name),
        name: c.name,
        expected: target,
      });
    }
  }

  const firstMissing = selected[continuousDone] || null;
  const pendingTailCount = internalGaps.length ? 0 : Math.max(0, selected.length - continuousDone);

  return {
    name: book.name,
    selected: selected.length,
    done: statuses.done || 0,
    pending: statuses.pending || 0,
    failed: statuses.failed || 0,
    skipped: statuses.skipped || 0,
    retry: statuses.retry || 0,
    continuousDone,
    pendingTailCount,
    complete: continuousDone === selected.length,
    firstMissing: firstMissing ? {
      index: continuousDone + 1,
      chapterNo: chapterNo(firstMissing.name),
      name: firstMissing.name,
      status: firstMissing.status,
      reason: firstMissing.reason || '',
    } : null,
    lastDone: lastDone >= 0 ? {
      index: lastDone + 1,
      chapterNo: chapterNo(selected[lastDone].name),
      name: selected[lastDone].name,
    } : null,
    internalGaps,
    pipelineMissing,
  };
}

function writeMarkdown(report, mdPath) {
  const lines = [];
  lines.push('# Step 1 Continuity Report');
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Books: ${report.summary.books}`);
  lines.push(`- Complete books: ${report.summary.completeBooks}`);
  lines.push(`- Books with only tail pending: ${report.summary.tailPendingBooks}`);
  lines.push(`- Books with internal gaps: ${report.summary.internalGapBooks}`);
  lines.push(`- Pipeline copy missing done files: ${report.summary.pipelineMissingDoneFiles}`);
  lines.push('');

  for (const b of report.books) {
    if (b.complete && !b.pipelineMissing.length) continue;
    lines.push(`## ${b.name}`);
    lines.push('');
    lines.push(`- selected: ${b.selected}, done: ${b.done}, pending: ${b.pending}, failed: ${b.failed}, continuous done: ${b.continuousDone}`);
    if (b.firstMissing) lines.push(`- first not done: #${b.firstMissing.index} ${b.firstMissing.name} (${b.firstMissing.status})`);
    if (b.internalGaps.length) {
      lines.push('- internal gaps:');
      for (const g of b.internalGaps.slice(0, 30)) lines.push(`  - #${g.index} ${g.name} (${g.status}${g.reason ? `, ${g.reason}` : ''})`);
      if (b.internalGaps.length > 30) lines.push(`  - ... ${b.internalGaps.length - 30} more`);
    } else if (!b.complete) {
      lines.push(`- only tail pending: ${b.pendingTailCount}`);
    }
    if (b.pipelineMissing.length) lines.push(`- pipeline missing copied done files: ${b.pipelineMissing.length}`);
    lines.push('');
  }

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
}

const booksResp = await api('/api/books');
const books = booksResp.books || [];
const reports = [];

for (const book of books) {
  const detail = await api('/api/book?name=' + encodeURIComponent(book.name));
  reports.push(summarizeBook(book, detail));
}

const summary = {
  books: reports.length,
  selected: reports.reduce((n, b) => n + b.selected, 0),
  done: reports.reduce((n, b) => n + b.done, 0),
  pending: reports.reduce((n, b) => n + b.pending, 0),
  failed: reports.reduce((n, b) => n + b.failed, 0),
  completeBooks: reports.filter((b) => b.complete).length,
  tailPendingBooks: reports.filter((b) => !b.complete && !b.internalGaps.length).length,
  internalGapBooks: reports.filter((b) => b.internalGaps.length).length,
  internalGapCount: reports.reduce((n, b) => n + b.internalGaps.length, 0),
  pipelineMissingDoneFiles: reports.reduce((n, b) => n + b.pipelineMissing.length, 0),
};

const report = {
  generatedAt: new Date().toISOString(),
  controlUrl: CONTROL_URL,
  pipelineStep1Dir: PIPELINE_STEP1_DIR,
  summary,
  books: reports,
};

ensureDir(REPORT_DIR);
const jsonPath = path.join(REPORT_DIR, 'step1-continuity-report.json');
const mdPath = path.join(REPORT_DIR, 'step1-continuity-report.md');
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
writeMarkdown(report, mdPath);

console.log(JSON.stringify({
  summary,
  reports: { jsonPath, mdPath },
  booksWithInternalGaps: reports.filter((b) => b.internalGaps.length).map((b) => ({
    name: b.name,
    gaps: b.internalGaps.length,
    firstGap: b.internalGaps[0],
  })),
  booksWithTailPending: reports.filter((b) => !b.complete && !b.internalGaps.length).map((b) => ({
    name: b.name,
    pendingTailCount: b.pendingTailCount,
    firstMissing: b.firstMissing,
  })),
}, null, 2));
