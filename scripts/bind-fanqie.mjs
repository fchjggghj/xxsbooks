import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeFanqieBinding } from '../lib/fanqie-config.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function usage() {
  return `绑定一本书到本地番茄账号（默认仅预览）

node scripts/bind-fanqie.mjs --book "书名" --account-ref fanqie-02 \\
  --work-id 123 --work-title "番茄书名" --ai-used true \\
  --first-chapter 5 --first-date 2026-07-19 --chapters-per-day 4 --time 00:00 [--apply]

accountRef 已在 config/local/fanqie-accounts.json 中登记时，无需重复提供 Profile。
新账号也可用 --shortcut，或用 --profile-dir 绝对路径 [--profile-name Default]。`;
}

function parseArgs(argv) {
  const result = { apply: false };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--apply') result.apply = true;
    else if (token === '--help' || token === '-h') result.help = true;
    else if (token.startsWith('--')) {
      if (!argv[index + 1]) throw new Error(`${token} 缺少参数`);
      result[token.slice(2)] = argv[++index];
    } else throw new Error(`未知参数: ${token}`);
  }
  return result;
}

export function parseShortcutArguments(argumentsText) {
  const text = String(argumentsText || '');
  const value = (name) => {
    const match = text.match(new RegExp(`--${name}=(?:"([^"]+)"|(\\S+))`, 'i'));
    return match?.[1] || match?.[2] || '';
  };
  return { profileDir: value('user-data-dir'), profileName: value('profile-directory') || 'Default' };
}

function readShortcut(shortcutPath) {
  const script = path.join(projectRoot, 'scripts', 'read-chrome-shortcut.ps1');
  const result = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ShortcutPath', shortcutPath,
  ], { cwd: projectRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || '读取 Chrome 快捷方式失败');
  const shortcut = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''));
  return { ...shortcut, ...parseShortcutArguments(shortcut.arguments) };
}

async function findBookConfig(bookName) {
  const dir = path.join(projectRoot, 'config', 'books');
  for (const name of (await fs.readdir(dir)).filter((item) => item.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    const raw = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    if (raw.name === bookName) return { file, raw };
  }
  throw new Error(`未找到书籍配置: ${bookName}`);
}

async function readAccountRegistry() {
  const file = path.join(projectRoot, 'config', 'local', 'fanqie-accounts.json');
  try {
    return { file, raw: JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { file, raw: { schemaVersion: 1, accounts: {} } };
  }
}

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

function required(args, name) {
  const value = String(args[name] || '').trim();
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const bookName = required(args, 'book');
  const { file, raw } = await findBookConfig(bookName);
  const accountRef = String(args['account-ref'] || raw.fanqie?.accountRef || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(accountRef)) throw new Error('--account-ref 必须使用字母、数字、点、下划线或连字符');
  const registry = await readAccountRegistry();
  const existingAccount = registry.raw.accounts?.[accountRef] || null;
  const shortcut = args.shortcut ? readShortcut(path.resolve(args.shortcut)) : null;
  const aiText = required(args, 'ai-used').toLowerCase();
  if (!['true', 'false'].includes(aiText)) throw new Error('--ai-used 必须是 true 或 false');
  const account = {
    ...(existingAccount || {}),
    label: args['account-label'] || existingAccount?.label || (args.shortcut ? path.basename(args.shortcut, '.lnk') : accountRef),
    shortcutPath: args.shortcut ? path.resolve(args.shortcut) : existingAccount?.shortcutPath,
    profileDir: args['profile-dir'] || shortcut?.profileDir || existingAccount?.profileDir,
    profileName: args['profile-name'] || shortcut?.profileName || existingAccount?.profileName || 'Default',
    cdpPort: Number(args['cdp-port'] || existingAccount?.cdpPort || 9333),
  };
  const binding = {
    schemaVersion: 1,
    enabled: true,
    accountRef,
    workId: required(args, 'work-id'),
    workTitle: required(args, 'work-title'),
    sourceDir: args['source-dir'] || '正文',
    aiUsed: aiText === 'true',
    contentDetection: 'basic',
    quality: raw.fanqie?.quality || {
      minBodyChars: 1000, maxBodyChars: 30000, maxTitleChars: 30, minimumLeadMinutes: 15,
    },
    schedule: {
      firstChapter: Number(args['first-chapter'] || 1),
      firstDate: required(args, 'first-date'),
      chaptersPerDay: Number(args['chapters-per-day'] || 1),
      time: args.time || '00:00',
    },
  };
  normalizeFanqieBinding({ ...binding, ...account });
  const output = { ...raw, fanqie: binding };
  const registryOutput = {
    ...registry.raw,
    schemaVersion: 1,
    accounts: { ...(registry.raw.accounts || {}), [accountRef]: account },
  };
  console.log(JSON.stringify({
    mode: args.apply ? 'apply' : 'preview', configFile: file, accountFile: registry.file,
    book: bookName, fanqie: binding, localAccount: { accountRef, ...account },
  }, null, 2));
  if (args.apply) {
    await atomicWriteJson(registry.file, registryOutput);
    await atomicWriteJson(file, output);
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
