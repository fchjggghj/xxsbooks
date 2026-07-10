// 将外部新书榜目录安全导入到 书籍/书名/原文/。默认只预览，--apply 才会写入。
import fssync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { applyImportPlan, createImportPlan } from './lib/import-books.mjs';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const targetRoot = path.join(projectRoot, '书籍');

function parseArgs(argv) {
  const positional = [];
  let apply = false;
  let help = false;
  for (const argument of argv) {
    if (argument === '--apply') apply = true;
    else if (argument === '--help' || argument === '-h') help = true;
    else if (argument.startsWith('--')) throw new Error(`未知参数: ${argument}`);
    else positional.push(argument);
  }
  if (positional.length > 1) throw new Error('只能指定一个源目录');
  return { source: positional[0], apply, help };
}

function printResults(results, apply) {
  for (const result of results) {
    const tag = result.status === 'done' ? '完成'
      : result.status === 'ready' ? '预览'
        : result.status === 'conflict' ? '冲突' : '跳过';
    const renamed = result.renamed ? `，安全目录名: ${result.bookName}` : '';
    const detail = ['ready', 'done'].includes(result.status)
      ? `${result.sourceLabel}/ -> 书籍/${result.bookName}/原文 (${result.files.length}章)${renamed}`
      : result.reason;
    console.log(`[${tag}] ${result.rawBookName}  ${detail}`);
  }
  const completed = results.filter((item) => item.status === (apply ? 'done' : 'ready')).length;
  const chapters = results
    .filter((item) => item.status === (apply ? 'done' : 'ready'))
    .reduce((sum, item) => sum + item.files.length, 0);
  console.log(`\n合计: ${completed}/${results.length} 本, ${chapters} 章`);
}

export async function main(argv = process.argv.slice(2)) {
  const { source, apply, help } = parseArgs(argv);
  if (help || !source) {
    console.log('用法: node import-newbooks.mjs <源目录> [--apply]');
    console.log('  默认只预览；--apply 将每本书完整复制后原子落盘。');
    return help ? 0 : 1;
  }
  if (!fssync.existsSync(source)) throw new Error(`源目录不存在: ${source}`);
  const plan = await createImportPlan(path.resolve(source), targetRoot);
  if (!plan.length) throw new Error(`源目录下无书目录: ${source}`);
  console.log(apply ? `=== 导入（执行）源: ${source} ===` : `=== 预览 源: ${source}（加 --apply 执行）===`);
  const results = apply ? await applyImportPlan(plan, targetRoot) : plan;
  printResults(results, apply);
  return results.some((item) => item.status === 'conflict') ? 2 : 0;
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error('导入失败:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
