import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { assertSafePathSegment, resolveInside } from './path-safety.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_EXTENSIONS = ['.txt', '.md'];

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function readJsonIfExists(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

function catalogFile(projectRoot) {
  return path.join(path.resolve(projectRoot), '书籍', '.state', 'materials', 'catalog.json');
}

function portableRelative(value) {
  return value.split(path.sep).join('/');
}

function metadataFromFilename(filename) {
  const stem = path.parse(filename).name;
  const tags = [...stem.matchAll(/【([^】]+)】/gu)].map((match) => match[1].trim()).filter(Boolean);
  const wordLabel = stem.match(/(\d+(?:\.\d+)?)\s*万(?:字)?/u)?.[0] || '';
  const title = stem
    .replace(/^\d+[_\s-]*/u, '')
    .replace(/【[^】]+】/gu, '')
    .replace(/\d+(?:\.\d+)?\s*万(?:字)?/gu, '')
    .replace(/[＿_\s-]+$/u, '')
    .trim() || stem;
  return { title, tags, wordLabel };
}

function validateSource(id, source) {
  if (!source || typeof source !== 'object') throw new Error(`素材源 ${id} 配置无效。`);
  const root = String(source.root || '').trim();
  if (!root || !path.isAbsolute(root)) throw new Error(`素材源 ${id}.root 必须是绝对路径。`);
  const extensions = Array.isArray(source.extensions) && source.extensions.length
    ? source.extensions.map((item) => String(item).toLowerCase())
    : DEFAULT_EXTENSIONS;
  if (extensions.some((item) => !/^\.[a-z0-9]+$/i.test(item))) throw new Error(`素材源 ${id}.extensions 格式无效。`);
  return {
    id,
    label: String(source.label || id).trim() || id,
    root: path.normalize(root),
    mode: source.mode === 'read-only' ? 'read-only' : 'read-only',
    extensions: [...new Set(extensions)],
  };
}

export async function loadMaterialSources(projectRoot) {
  const file = path.join(path.resolve(projectRoot), 'config', 'local', 'material-sources.json');
  let raw;
  try {
    raw = await readJson(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`缺少本机素材源配置 ${file}；请先运行 resources import。`);
    }
    throw error;
  }
  if (raw.schemaVersion !== SCHEMA_VERSION || !raw.sources || typeof raw.sources !== 'object') {
    throw new Error(`本机素材源配置格式无效或版本不受支持: ${file}`);
  }
  const sources = Object.fromEntries(Object.entries(raw.sources).map(([id, source]) => [id, validateSource(id, source)]));
  return { file, sources };
}

async function walkSource(source) {
  const allowed = new Set(source.extensions);
  const items = [];
  const stack = [source.root];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => right.name.localeCompare(left.name, 'zh-Hans-CN', { numeric: true }));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile() || !allowed.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fs.stat(absolute);
      const relativePath = portableRelative(path.relative(source.root, absolute));
      const metadata = metadataFromFilename(entry.name);
      items.push({
        id: crypto.createHash('sha256').update(`${source.id}\0${relativePath}`).digest('hex').slice(0, 20),
        sourceId: source.id,
        relativePath,
        name: entry.name,
        extension: path.extname(entry.name).toLowerCase(),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        ...metadata,
      });
    }
  }
  items.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-Hans-CN', { numeric: true }));
  return items;
}

export async function buildMaterialCatalog(projectRoot) {
  const registry = await loadMaterialSources(projectRoot);
  const sources = [];
  const items = [];
  for (const source of Object.values(registry.sources)) {
    if (!fssync.existsSync(source.root)) {
      sources.push({ ...source, exists: false, fileCount: 0, totalBytes: 0 });
      continue;
    }
    const sourceItems = await walkSource(source);
    const totalBytes = sourceItems.reduce((sum, item) => sum + item.sizeBytes, 0);
    sources.push({ ...source, exists: true, fileCount: sourceItems.length, totalBytes });
    items.push(...sourceItems);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    indexedAt: new Date().toISOString(),
    registryFile: registry.file,
    sourceCount: sources.length,
    fileCount: items.length,
    totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
    sources,
    items,
  };
}

export async function indexMaterialCatalog(projectRoot, apply = false) {
  const catalog = await buildMaterialCatalog(projectRoot);
  const file = catalogFile(projectRoot);
  if (apply) await writeJsonAtomic(file, catalog);
  return {
    ok: catalog.sources.every((source) => source.exists),
    command: 'material index',
    applied: apply === true,
    readOnly: apply !== true,
    catalogFile: file,
    indexedAt: catalog.indexedAt,
    sourceCount: catalog.sourceCount,
    fileCount: catalog.fileCount,
    totalBytes: catalog.totalBytes,
    sources: catalog.sources,
  };
}

export async function materialLocalStatus(projectRoot) {
  const registry = await loadMaterialSources(projectRoot);
  const file = catalogFile(projectRoot);
  const catalog = await readJsonIfExists(file);
  const sources = Object.values(registry.sources).map((source) => ({
    ...source,
    exists: fssync.existsSync(source.root),
    indexedFileCount: catalog?.sources?.find((item) => item.id === source.id)?.fileCount ?? null,
    indexedBytes: catalog?.sources?.find((item) => item.id === source.id)?.totalBytes ?? null,
  }));
  return {
    ok: sources.length > 0 && sources.every((source) => source.exists),
    command: 'material local-status',
    readOnly: true,
    registryFile: registry.file,
    catalogFile: file,
    indexed: Boolean(catalog),
    indexedAt: catalog?.indexedAt || null,
    fileCount: catalog?.fileCount ?? 0,
    totalBytes: catalog?.totalBytes ?? 0,
    sources,
  };
}

export async function searchMaterialCatalog(projectRoot, query, limit = 50) {
  const text = String(query || '').trim();
  if (!text) throw new Error('搜索关键词不能为空。');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit 必须是 1 到 200 的整数。');
  const file = catalogFile(projectRoot);
  const catalog = await readJsonIfExists(file);
  if (!catalog) throw new Error('素材索引尚未建立；请先运行 material index --apply。');
  const tokens = text.toLocaleLowerCase('zh-Hans-CN').split(/\s+/u).filter(Boolean);
  const matches = catalog.items.filter((item) => {
    const haystack = `${item.title} ${item.name} ${item.relativePath} ${(item.tags || []).join(' ')}`.toLocaleLowerCase('zh-Hans-CN');
    return tokens.every((token) => haystack.includes(token));
  });
  return {
    ok: true,
    command: 'material search',
    readOnly: true,
    query: text,
    totalMatches: matches.length,
    limit,
    items: matches.slice(0, limit),
  };
}

function resolveSourceFile(source, relativePath) {
  const text = String(relativePath || '').trim().replace(/\\/gu, '/');
  if (!text || path.posix.isAbsolute(text)) throw new Error('素材相对路径无效。');
  const target = path.resolve(source.root, ...text.split('/'));
  const relative = path.relative(source.root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('素材路径越界。');
  return { target, relative: portableRelative(relative) };
}

export async function importMaterialToBook(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const registry = await loadMaterialSources(root);
  const sourceId = String(options.sourceId || 'main').trim();
  const source = registry.sources[sourceId];
  if (!source) throw new Error(`找不到素材源: ${sourceId}`);
  const book = assertSafePathSegment(options.book, '书名');
  const resolved = resolveSourceFile(source, options.relativePath);
  if (!fssync.existsSync(resolved.target) || !(await fs.stat(resolved.target)).isFile()) {
    throw new Error(`素材文件不存在: ${resolved.target}`);
  }
  const booksRoot = path.join(root, '书籍');
  const bookDir = resolveInside(booksRoot, book);
  if (!fssync.existsSync(bookDir) || !(await fs.stat(bookDir)).isDirectory()) throw new Error(`书籍目录不存在: ${book}`);
  const destination = resolveInside(bookDir, '素材', sourceId, ...resolved.relative.split('/'));
  if (fssync.existsSync(destination)) throw new Error(`目标素材已存在，拒绝覆盖: ${destination}`);
  const result = {
    ok: true,
    command: 'material import',
    applied: options.apply === true,
    readOnly: options.apply !== true,
    sourceId,
    book,
    source: resolved.target,
    relativePath: resolved.relative,
    destination,
  };
  if (!options.apply) return result;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(resolved.target, destination, fssync.constants.COPYFILE_EXCL);
  return result;
}
