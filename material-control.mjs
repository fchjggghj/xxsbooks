import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  importMaterialToBook,
  indexMaterialCatalog,
  materialLocalStatus,
  searchMaterialCatalog,
} from './lib/material-catalog.mjs';

export function materialUsage() {
  return `XXSBooks 素材库

用法:
  node control.mjs material local-status [--json]
  node control.mjs material index [--apply] [--json]
  node control.mjs material search --query <关键词> [--limit 50] [--json]
  node control.mjs material import --source <ID> --file <相对路径> --book <书名> [--apply] [--json]

index/import 默认只预览；--apply 才写入索引或复制单个选中的素材。外部素材源始终只读。`;
}

export function parseMaterialControlArgs(argv) {
  const options = { command: '', apply: false, json: false, query: '', limit: 50, sourceId: 'main', relativePath: '', book: '', help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!options.command && !arg.startsWith('--')) options.command = arg;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--query') options.query = String(argv[++index] || '').trim();
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else if (arg === '--source') options.sourceId = String(argv[++index] || '').trim();
    else if (arg === '--file') options.relativePath = String(argv[++index] || '').trim();
    else if (arg === '--book') options.book = String(argv[++index] || '').trim();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

export async function runMaterialControl(argv, projectRoot) {
  const options = parseMaterialControlArgs(argv);
  if (options.help || !options.command || options.command === 'help') return { ok: true, help: materialUsage() };
  if (options.command === 'local-status') return materialLocalStatus(projectRoot);
  if (options.command === 'index') return indexMaterialCatalog(projectRoot, options.apply);
  if (options.command === 'search') return searchMaterialCatalog(projectRoot, options.query, options.limit);
  if (options.command === 'import') {
    return importMaterialToBook(projectRoot, {
      sourceId: options.sourceId,
      relativePath: options.relativePath,
      book: options.book,
      apply: options.apply,
    });
  }
  throw new Error(`未知素材命令: ${options.command}\n\n${materialUsage()}`);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const projectRoot = path.resolve(process.env.XXSBOOKS_PROJECT_ROOT || path.dirname(fileURLToPath(import.meta.url)));
  runMaterialControl(process.argv.slice(2), projectRoot).then((result) => {
    if (result.help) console.log(result.help);
    else console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
