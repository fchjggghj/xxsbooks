import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { importExternalResources } from '../lib/external-resources.mjs';

export function parseExternalResourceArgs(argv) {
  const options = { fanqieRoot: '', materialRoot: '', sourceId: 'main', apply: false, json: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--fanqie-root') options.fanqieRoot = String(argv[++index] || '').trim();
    else if (arg === '--material-root') options.materialRoot = String(argv[++index] || '').trim();
    else if (arg === '--source-id') options.sourceId = String(argv[++index] || '').trim();
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

export function externalResourceUsage() {
  return `导入本机外部资源

用法:
  node control.mjs resources import --fanqie-root <独立Chrome目录> --material-root <素材库目录> [--apply] [--json]

默认只预览；--apply 才写入 config/local 下的本机私有注册表。不会复制 Chrome Profile 或整座素材库。`;
}

export async function runExternalResourceImport(argv, projectRoot) {
  const options = parseExternalResourceArgs(argv);
  if (options.help) return { ok: true, help: externalResourceUsage() };
  return importExternalResources(projectRoot, options);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  runExternalResourceImport(process.argv.slice(2), projectRoot).then((result) => {
    if (result.help) console.log(result.help);
    else console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
