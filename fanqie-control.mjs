import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fanqieChapterManageUrl } from './lib/fanqie-browser.mjs';
import { loadFanqieBook } from './lib/fanqie-config.mjs';
import {
  getFanqieLocalStatus,
  resolveFanqieBookName,
  runFanqieReconcile,
  runFanqieRemoteStatus,
  runFanqieUpload,
} from './lib/fanqie-service.mjs';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(process.env.XXSBOOKS_PROJECT_ROOT || appRoot);

function usage() {
  return `番茄发布控制

  node fanqie-control.mjs local-status [--book "书名"]
  node fanqie-control.mjs chrome [--book "书名"]
  node fanqie-control.mjs status [--book "书名"] [--from N] [--to N]
  node fanqie-control.mjs upload [--book "书名"] [--from N] [--to N] [--apply]
  node fanqie-control.mjs reconcile [--book "书名"] [--apply]

local-status 完全本地；status、reconcile 预览和不带 --apply 的 upload 都不会发布。`;
}

export function parseFanqieControlArgs(argv) {
  const first = argv[0] || 'local-status';
  const result = { command: first === '--help' || first === '-h' ? 'local-status' : first, apply: false, help: first === '--help' || first === '-h' };
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--apply') result.apply = true;
    else if (token === '--json') result.json = true;
    else if (token === '--help' || token === '-h') result.help = true;
    else if (['--book', '--from', '--to'].includes(token)) {
      if (!argv[index + 1]) throw new Error(`${token} 缺少参数`);
      result[token.slice(2)] = argv[++index];
    } else throw new Error(`未知参数: ${token}`);
  }
  return result;
}

async function launchChrome(args, root) {
  const bookName = await resolveFanqieBookName(root, args.book);
  const { binding } = await loadFanqieBook(root, bookName);
  const script = path.join(root, 'start-fanqie-chrome.ps1');
  const child = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-ProfileDir', binding.profileDir, '-ProfileName', binding.profileName,
    '-Port', String(binding.cdpPort), '-Url', fanqieChapterManageUrl(binding),
  ], { cwd: root, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`番茄 Chrome 启动脚本退出码: ${code}`);
}

export async function runFanqieControl(argv, root = projectRoot) {
  const args = parseFanqieControlArgs(argv);
  if (args.help) return { ok: true, help: usage() };
  if (args.command === 'chrome') {
    await launchChrome(args, root);
    return { ok: true, command: 'chrome', book: args.book || '' };
  }
  let result;
  if (args.command === 'local-status') {
    if (args.apply) throw new Error('local-status 不接受 --apply');
    result = await getFanqieLocalStatus(root, args.book);
  } else if (args.command === 'status') {
    if (args.apply) throw new Error('status 不接受 --apply；请使用 upload --apply');
    result = await runFanqieRemoteStatus(root, args);
  } else if (args.command === 'upload') {
    result = await runFanqieUpload(root, {
      ...args,
      onProgress: (item) => console.error(`已提交第 ${item.chapterNumber} 章：${item.title} -> ${item.date} ${item.time}`),
    });
  } else if (args.command === 'reconcile') {
    result = await runFanqieReconcile(root, args);
  } else throw new Error(`未知命令: ${args.command}\n${usage()}`);
  return result;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  runFanqieControl(process.argv.slice(2)).then(
    (result) => {
      console.log(result.help || JSON.stringify(result, null, 2));
      process.exit(0);
    },
    (error) => {
      console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
      process.exit(1);
    },
  );
}
