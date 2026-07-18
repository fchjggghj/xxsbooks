import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

async function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

function normalizedKey(value) {
  return path.normalize(path.resolve(value)).toLocaleLowerCase('en-US');
}

function accountNumber(name) {
  const match = String(name).match(/番茄账号\s*(\d{1,3})/u);
  return match ? Number(match[1]) : null;
}

function preferredShortcut(items) {
  return [...items].sort((left, right) => {
    const leftNamed = /【[^】]+】/u.test(left.name) ? 1 : 0;
    const rightNamed = /【[^】]+】/u.test(right.name) ? 1 : 0;
    return rightNamed - leftNamed || left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true });
  })[0];
}

function uniqueRef(base, occupied) {
  if (!occupied.has(base)) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base}-${index}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

function nextPort(preferred, occupied) {
  let port = preferred;
  while (occupied.has(port) && port <= 65535) port++;
  if (port > 65535) throw new Error('没有可用的 Chrome CDP 端口。');
  occupied.add(port);
  return port;
}

export async function discoverFanqieAccounts(accountRoot) {
  const root = path.resolve(String(accountRoot || '').trim());
  if (!fssync.existsSync(root)) throw new Error(`独立 Chrome 账号目录不存在: ${root}`);
  const profilesRoot = path.join(root, 'Profiles');
  if (!fssync.existsSync(profilesRoot)) throw new Error(`账号目录缺少 Profiles 子目录: ${profilesRoot}`);

  const shortcutGroups = new Map();
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.lnk') continue;
    const number = accountNumber(entry.name);
    if (!number) continue;
    const group = shortcutGroups.get(number) || [];
    group.push({ name: entry.name, path: path.join(root, entry.name) });
    shortcutGroups.set(number, group);
  }

  const profiles = [];
  for (const entry of await fs.readdir(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^fanqie-(\d{1,3})$/i);
    if (!match) continue;
    const number = Number(match[1]);
    const shortcuts = shortcutGroups.get(number) || [];
    if (!shortcuts.length) throw new Error(`Profile ${entry.name} 没有对应的 .lnk 快捷方式。`);
    const shortcut = preferredShortcut(shortcuts);
    const note = shortcut.name.match(/【([^】]+)】/u)?.[1] || '';
    profiles.push({
      number,
      accountId: `fanqie-${String(number).padStart(2, '0')}`,
      label: note ? `番茄账号 ${String(number).padStart(2, '0')}【${note}】` : `番茄账号 ${String(number).padStart(2, '0')}`,
      shortcutPath: shortcut.path,
      profileDir: path.join(profilesRoot, entry.name),
      profileName: 'Default',
    });
  }
  profiles.sort((left, right) => left.number - right.number);
  if (!profiles.length) throw new Error(`没有找到 Profiles\\fanqie-NN: ${profilesRoot}`);
  return { root, profilesRoot, accounts: profiles };
}

export async function buildFanqieAccountRegistry(projectRoot, accountRoot) {
  const root = path.resolve(projectRoot);
  const file = path.join(root, 'config', 'local', 'fanqie-accounts.json');
  const current = await readJsonIfExists(file, { schemaVersion: SCHEMA_VERSION, accounts: {} });
  if (current.schemaVersion !== SCHEMA_VERSION || !current.accounts || typeof current.accounts !== 'object') {
    throw new Error(`现有番茄账号注册表格式无效: ${file}`);
  }
  const discovered = await discoverFanqieAccounts(accountRoot);
  const existingByProfile = new Map();
  for (const [ref, account] of Object.entries(current.accounts)) {
    if (account?.profileDir && path.isAbsolute(account.profileDir)) {
      existingByProfile.set(normalizedKey(account.profileDir), { ref, account });
    }
  }
  const occupiedRefs = new Set(Object.keys(current.accounts));
  const occupiedPorts = new Set(
    Object.values(current.accounts).map((account) => Number(account?.cdpPort)).filter(Number.isInteger),
  );
  const merged = { ...current.accounts };
  const imported = [];

  for (const item of discovered.accounts) {
    const existing = existingByProfile.get(normalizedKey(item.profileDir));
    let ref;
    let cdpPort;
    if (existing) {
      ref = existing.ref;
      cdpPort = Number(existing.account.cdpPort);
      if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) {
        cdpPort = nextPort(9332 + item.number, occupiedPorts);
      }
    } else {
      ref = uniqueRef(item.accountId, occupiedRefs);
      occupiedRefs.add(ref);
      cdpPort = nextPort(9332 + item.number, occupiedPorts);
    }
    merged[ref] = {
      ...(existing?.account || {}),
      label: item.label,
      shortcutPath: item.shortcutPath,
      profileDir: item.profileDir,
      profileName: item.profileName,
      cdpPort,
      sourceAccountId: item.accountId,
    };
    imported.push({ ref, ...merged[ref] });
  }
  return {
    file,
    registry: { schemaVersion: SCHEMA_VERSION, sourceRoot: discovered.root, accounts: merged },
    imported,
    discovered: discovered.accounts.length,
    preserved: imported.filter((item) => existingByProfile.has(normalizedKey(item.profileDir))).length,
  };
}

export async function buildMaterialSourceRegistry(projectRoot, materialRoot, sourceId = 'main') {
  const root = path.resolve(projectRoot);
  const sourceRoot = path.resolve(String(materialRoot || '').trim());
  if (!fssync.existsSync(sourceRoot)) throw new Error(`素材库目录不存在: ${sourceRoot}`);
  if (!(await fs.stat(sourceRoot)).isDirectory()) throw new Error(`素材库路径不是目录: ${sourceRoot}`);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(sourceId)) throw new Error(`素材源 ID 格式无效: ${sourceId}`);
  const file = path.join(root, 'config', 'local', 'material-sources.json');
  const current = await readJsonIfExists(file, { schemaVersion: SCHEMA_VERSION, sources: {} });
  if (current.schemaVersion !== SCHEMA_VERSION || !current.sources || typeof current.sources !== 'object') {
    throw new Error(`现有素材源注册表格式无效: ${file}`);
  }
  const registry = {
    schemaVersion: SCHEMA_VERSION,
    sources: {
      ...current.sources,
      [sourceId]: {
        label: sourceId === 'main' ? '本机素材库' : sourceId,
        root: sourceRoot,
        mode: 'read-only',
        extensions: ['.txt', '.md'],
      },
    },
  };
  return { file, registry, sourceId, source: registry.sources[sourceId] };
}

export async function importExternalResources(projectRoot, options = {}) {
  const fanqie = options.fanqieRoot
    ? await buildFanqieAccountRegistry(projectRoot, options.fanqieRoot)
    : null;
  const materials = options.materialRoot
    ? await buildMaterialSourceRegistry(projectRoot, options.materialRoot, options.sourceId || 'main')
    : null;
  if (!fanqie && !materials) throw new Error('至少指定 --fanqie-root 或 --material-root。');
  if (options.apply) {
    if (fanqie) await writeJsonAtomic(fanqie.file, fanqie.registry);
    if (materials) await writeJsonAtomic(materials.file, materials.registry);
  }
  return {
    ok: true,
    command: 'resources import',
    applied: options.apply === true,
    readOnly: options.apply !== true,
    fanqie: fanqie ? {
      sourceRoot: fanqie.registry.sourceRoot,
      accountFile: fanqie.file,
      discovered: fanqie.discovered,
      preserved: fanqie.preserved,
      accounts: fanqie.imported,
    } : null,
    materials: materials ? {
      sourceId: materials.sourceId,
      root: materials.source.root,
      registryFile: materials.file,
      mode: materials.source.mode,
    } : null,
  };
}
