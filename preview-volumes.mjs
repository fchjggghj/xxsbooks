// preview-volumes.mjs
// 分析新书榜源目录，按世界标题生成分卷预览报告。
// 用法: node preview-volumes.mjs <源目录>
// 输出: 分卷预览报告.md（项目根目录）
// 规则:
//   - 读取每本书 拆分章节/ 下的文件名（按开头数字排序）
//   - 从文件名提取世界标题：去掉 "第X章" 前缀和末尾数字/完
//   - 相邻同标题的章节归为一个"分段"
//   - "现实" 等过渡章节单独标注，用户决定归并方式
//   - 不移动任何文件，只生成报告

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { arabicToChinese, sortByLeadingNumber } from './lib/naming.mjs';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const positional = [];
  let output = '';
  let help = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--output') output = argv[++index] || '';
    else if (argument === '--help' || argument === '-h') help = true;
    else if (argument.startsWith('-')) throw new Error(`未知参数: ${argument}`);
    else positional.push(argument);
  }
  return { positional, output, help };
}

// 从 "0001_第1章花柳病丈夫1.txt" 提取世界标题 "花柳病丈夫"
export function extractWorld(fileName) {
  // 去掉扩展名
  let name = fileName.replace(/\.txt$/i, '');
  // 去掉开头数字和下划线
  name = name.replace(/^\d+_/, '');
  // 反复去掉 "第...章" 前缀（可能有多层，如 "第179章第一八零-一九零章被打压的主播1"）
  // 用循环去掉所有 "第XXX章" 开头
  let prev;
  do {
    prev = name;
    name = name.replace(/^第[^章]*章/, '');
  } while (name !== prev);
  // 去掉结尾的数字、"完"、标点
  name = name.replace(/[\d]+$/, '');
  name = name.replace(/（完）$/, '').replace(/\(完\)$/, '');
  name = name.replace(/[！!]$/, '');
  name = name.replace(/[-—－]+$/, '');
  name = name.trim();
  // 如果剩下的是空，说明是 "现实" 或无标题
  if (!name) name = '（无标题）';
  return name;
}

export async function analyzeBook(srcBookDir, bookName) {
  let srcSubdir = path.join(srcBookDir, '拆分章节');
  if (!fssync.existsSync(srcSubdir)) {
    srcSubdir = path.join(srcBookDir, '原著原文');
    if (!fssync.existsSync(srcSubdir)) {
      return null;
    }
  }
  const entries = await fs.readdir(srcSubdir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.txt'))
    .map((e) => e.name)
    .sort(sortByLeadingNumber);
  if (files.length === 0) return null;

  // 按顺序遍历，相邻同世界标题的归为一个分段
  const segments = [];
  let current = null;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const world = extractWorld(f);
    const numMatch = f.match(/^(\d+)/);
    const num = numMatch ? Number(numMatch[1]) : i + 1;
    if (!current || current.world !== world) {
      if (current) segments.push(current);
      current = { world, startIdx: i, startFile: f, startNum: num, endIdx: i, endFile: f, endNum: num, count: 1, sample: f };
    } else {
      current.endIdx = i;
      current.endFile = f;
      current.endNum = num;
      current.count++;
    }
  }
  if (current) segments.push(current);

  return { bookName, totalChapters: files.length, segments, srcSubdir: path.basename(srcSubdir) };
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export function formatReport(results, options = {}) {
  const lines = [];
  lines.push('# 分卷预览报告');
  lines.push('');
  const generatedAt = options.generatedAt || new Date();
  lines.push(`生成时间: ${generatedAt.toLocaleString('zh-CN')}`);
  lines.push('');
  lines.push('本报告基于源文件名中的世界标题提取，**未移动任何文件**。');
  lines.push('请检查每本书的分段是否合理，确认后再执行分卷。');
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const r of results) {
    if (!r) continue;
    lines.push(`## ${r.bookName}`);
    lines.push('');
    lines.push(`- 总章数: ${r.totalChapters}`);
    lines.push(`- 分段数: ${r.segments.length}`);
    lines.push('');

    // 统计"现实"类过渡段
    const transitionSegs = r.segments.filter((s) => /现实|过渡/.test(s.world));
    const worldSegs = r.segments.filter((s) => !/现实|过渡/.test(s.world));
    lines.push(`- 世界段: ${worldSegs.length} 个`);
    lines.push(`- 过渡段(现实等): ${transitionSegs.length} 个`);
    lines.push('');

    lines.push('### 分段详情');
    lines.push('');
    lines.push('| 序号 | 世界标题 | 起始 | 结束 | 章数 | 示例文件 |');
    lines.push('|------|----------|------|------|------|----------|');
    r.segments.forEach((s, i) => {
      const flag = /现实|过渡|（无标题）/.test(s.world) ? ' ⚠️' : '';
      lines.push(`| ${i + 1} | ${escapeMarkdownCell(s.world)}${flag} | ${s.startNum} | ${s.endNum} | ${s.count} | ${escapeMarkdownCell(s.sample)} |`);
    });
    lines.push('');

    // 建议分卷方案：合并过渡段到下一个世界
    lines.push('### 建议分卷方案（过渡段归入下一世界）');
    lines.push('');
    let volNum = 0;
    let i = 0;
    const segs = r.segments;
    while (i < segs.length) {
      const s = segs[i];
      let merged = { world: s.world, start: s.startNum, end: s.endNum, count: s.count, hasTransition: false };
      if (/现实|过渡|（无标题）/.test(s.world)) {
        merged.hasTransition = true;
        let cursor = i + 1;
        while (cursor < segs.length && /现实|过渡|（无标题）/.test(segs[cursor].world)) {
          merged.end = segs[cursor].endNum;
          merged.count += segs[cursor].count;
          cursor++;
        }
        if (cursor < segs.length) {
          merged.world = segs[cursor].world;
          merged.end = segs[cursor].endNum;
          merged.count += segs[cursor].count;
          cursor++;
        }
        i = cursor;
      } else i++;
      volNum++;
      const flag = merged.hasTransition ? ' (含过渡章)' : '';
      lines.push(`${volNum}. 第${arabicToChinese(volNum)}卷 - ${merged.world} (${merged.start}-${merged.end}, ${merged.count}章)${flag}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('## 说明');
  lines.push('');
  lines.push('- ⚠️ 标记表示过渡段（现实/无标题），默认归入下一世界');
  lines.push('- 如果分段有误，可以手动调整后再执行分卷');
  lines.push('- 章节数过少（<5章）的段可能是异常文件名，需人工检查');
  lines.push('');

  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, output, help } = parseArgs(argv);
  if (help || positional.length === 0) {
    console.log('用法: node preview-volumes.mjs <源目录> [--output <报告路径>]');
    return help ? 0 : 1;
  }
  const srcRoot = positional[0];
  if (!fssync.existsSync(srcRoot)) {
    console.error(`源目录不存在: ${srcRoot}`);
    return 1;
  }

  const books = (await fs.readdir(srcRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));

  console.log(`分析 ${books.length} 本书...`);

  const results = [];
  for (const bookDirName of books) {
    const srcBookDir = path.join(srcRoot, bookDirName);
    const infoFile = path.join(srcBookDir, '书籍信息.md');
    let bookName = bookDirName;
    try {
      const text = await fs.readFile(infoFile, 'utf8');
      const m = text.match(/^#\s+(.+?)\s*$/m);
      if (m) bookName = m[1].trim();
    } catch {}
    const r = await analyzeBook(srcBookDir, bookName);
    if (r) {
      results.push(r);
      console.log(`  ${bookName}: ${r.totalChapters}章, ${r.segments.length}段`);
    } else {
      console.log(`  ${bookName}: 跳过（无章节文件）`);
    }
  }

  const report = formatReport(results);
  const reportPath = output
    ? path.resolve(output)
    : path.join(projectRoot, 'reports', '分卷预览报告.md');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, report, 'utf8');
  console.log(`\n报告已生成: ${path.relative(projectRoot, reportPath)}`);
  return 0;
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error('失败:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
