import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { loadBookCatalog } from './book-catalog.mjs';
import { extractFileOrder, sortByLeadingNumber, sortVolumeNames } from './naming.mjs';
import { resolveInside } from './path-safety.mjs';

const CHAPTER_EXTENSIONS = new Set(['.md', '.txt']);
const CHAPTER_PREFIX = /^第\s*(?:\d+|[零〇一二三四五六七八九十百千万两]+)\s*章[\s:：、.-]*/u;
const FANQIE_SCHEMA_VERSION = 1;
const DEFAULT_QUALITY = Object.freeze({
  minBodyChars: 1000,
  maxBodyChars: 30_000,
  maxTitleChars: 30,
  minimumLeadMinutes: 15,
});

function positiveInteger(value, label, fallback = null) {
  const resolved = value == null ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${label} 必须是正整数`);
  return resolved;
}

function nonNegativeInteger(value, label, fallback = null) {
  const resolved = value == null ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < 0) throw new Error(`${label} 必须是非负整数`);
  return resolved;
}

function parseIsoDate(value, label) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} 必须是 YYYY-MM-DD`);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`${label} 不是有效日期: ${text}`);
  }
  return text;
}

function parseTime(value, label) {
  const text = String(value || '').trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(text)) throw new Error(`${label} 必须是 HH:mm`);
  return text;
}

export function normalizeChapterTitle(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().replace(CHAPTER_PREFIX, '').trim();
}

export function normalizeFanqieBinding(raw, context = 'fanqie') {
  if (!raw || raw.enabled === false) return null;
  if (raw.schemaVersion != null && raw.schemaVersion !== FANQIE_SCHEMA_VERSION) {
    throw new Error(`${context}.schemaVersion 版本不受支持: ${raw.schemaVersion}`);
  }
  const profileDirInput = String(raw.profileDir || '').trim();
  if (!profileDirInput || !path.isAbsolute(profileDirInput)) throw new Error(`${context}.profileDir 必须是绝对路径`);
  const profileDir = path.normalize(profileDirInput);
  const shortcutPathInput = String(raw.shortcutPath || '').trim();
  if (shortcutPathInput && !path.isAbsolute(shortcutPathInput)) throw new Error(`${context}.shortcutPath 必须是绝对路径`);
  const workId = String(raw.workId || '').trim();
  if (!/^\d+$/.test(workId)) throw new Error(`${context}.workId 必须是番茄数字作品 ID`);
  const workTitle = String(raw.workTitle || '').trim();
  if (!workTitle) throw new Error(`${context}.workTitle 不能为空`);
  if (typeof raw.aiUsed !== 'boolean') throw new Error(`${context}.aiUsed 必须明确设置 true 或 false`);
  const cdpPort = positiveInteger(raw.cdpPort, `${context}.cdpPort`, 9333);
  if (cdpPort > 65535) throw new Error(`${context}.cdpPort 超出范围`);
  const schedule = raw.schedule || {};
  const firstChapter = positiveInteger(schedule.firstChapter, `${context}.schedule.firstChapter`, 1);
  const chaptersPerDay = positiveInteger(schedule.chaptersPerDay, `${context}.schedule.chaptersPerDay`, 1);
  const firstDate = parseIsoDate(schedule.firstDate, `${context}.schedule.firstDate`);
  const time = parseTime(schedule.time || '00:00', `${context}.schedule.time`);
  const times = Array.isArray(schedule.times) && schedule.times.length
    ? schedule.times.map((item, index) => parseTime(item, `${context}.schedule.times[${index}]`))
    : [time];
  if (times.length !== 1 && times.length !== chaptersPerDay) {
    throw new Error(`${context}.schedule.times 必须只含 1 个时间，或与 chaptersPerDay 数量一致`);
  }
  if (new Set(times).size !== times.length) throw new Error(`${context}.schedule.times 不能包含重复时间`);
  const sourceDir = String(raw.sourceDir || '正文').trim();
  if (!sourceDir || path.isAbsolute(sourceDir)) throw new Error(`${context}.sourceDir 必须是书目录内的相对路径`);
  const contentDetection = String(raw.contentDetection || 'basic').trim();
  if (contentDetection !== 'basic') throw new Error(`${context}.contentDetection 当前仅支持 basic`);
  const qualityRaw = raw.quality || {};
  const quality = {
    minBodyChars: nonNegativeInteger(qualityRaw.minBodyChars, `${context}.quality.minBodyChars`, DEFAULT_QUALITY.minBodyChars),
    maxBodyChars: positiveInteger(qualityRaw.maxBodyChars, `${context}.quality.maxBodyChars`, DEFAULT_QUALITY.maxBodyChars),
    maxTitleChars: positiveInteger(qualityRaw.maxTitleChars, `${context}.quality.maxTitleChars`, DEFAULT_QUALITY.maxTitleChars),
    minimumLeadMinutes: nonNegativeInteger(qualityRaw.minimumLeadMinutes, `${context}.quality.minimumLeadMinutes`, DEFAULT_QUALITY.minimumLeadMinutes),
  };
  if (quality.maxBodyChars < quality.minBodyChars) throw new Error(`${context}.quality.maxBodyChars 不能小于 minBodyChars`);
  const timeZone = String(raw.timeZone || 'Asia/Shanghai');
  if (timeZone !== 'Asia/Shanghai') throw new Error(`${context}.timeZone 当前仅支持 Asia/Shanghai`);
  return {
    schemaVersion: FANQIE_SCHEMA_VERSION,
    enabled: true,
    accountRef: String(raw.accountRef || '').trim(),
    accountLabel: String(raw.accountLabel || '').trim(),
    shortcutPath: shortcutPathInput ? path.normalize(shortcutPathInput) : '',
    profileDir,
    profileName: String(raw.profileName || 'Default').trim() || 'Default',
    cdpPort,
    cdpUrl: `http://127.0.0.1:${cdpPort}`,
    workId,
    workTitle,
    sourceDir,
    aiUsed: raw.aiUsed,
    contentDetection,
    timeZone,
    quality,
    schedule: { firstChapter, firstDate, chaptersPerDay, time: times[0], times },
  };
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

export async function loadFanqieAccountRegistry(projectRoot) {
  const file = path.join(path.resolve(projectRoot), 'config', 'local', 'fanqie-accounts.json');
  let raw;
  try {
    raw = await readJson(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`缺少本机番茄账号配置 ${file}；请复制 config/fanqie-accounts.example.json 后填写真实 Profile 路径`);
    }
    throw error;
  }
  if (raw.schemaVersion !== FANQIE_SCHEMA_VERSION || !raw.accounts || typeof raw.accounts !== 'object') {
    throw new Error(`本机番茄账号配置格式无效或版本不受支持: ${file}`);
  }
  return { file, accounts: raw.accounts };
}

export async function resolveFanqieBinding(projectRoot, raw, context = 'fanqie') {
  if (!raw || raw.enabled === false) return null;
  if (!raw.accountRef) return normalizeFanqieBinding(raw, context);
  const accountRef = String(raw.accountRef).trim();
  const registry = await loadFanqieAccountRegistry(projectRoot);
  const account = registry.accounts[accountRef];
  if (!account) throw new Error(`${context}.accountRef 未在本机账号配置中定义: ${accountRef}`);
  return normalizeFanqieBinding({
    ...raw,
    accountRef,
    accountLabel: account.label || accountRef,
    shortcutPath: account.shortcutPath,
    profileDir: account.profileDir,
    profileName: account.profileName,
    cdpPort: account.cdpPort,
  }, context);
}

export function calculateFanqiePublishAt(chapterNumber, schedule) {
  const chapter = positiveInteger(chapterNumber, 'chapterNumber');
  if (chapter < schedule.firstChapter) {
    throw new Error(`第 ${chapter} 章早于排期起始章节 ${schedule.firstChapter}`);
  }
  const offset = chapter - schedule.firstChapter;
  const dayOffset = Math.floor(offset / schedule.chaptersPerDay);
  const date = new Date(`${schedule.firstDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  const times = Array.isArray(schedule.times) && schedule.times.length ? schedule.times : [schedule.time];
  const time = times.length === 1 ? times[0] : times[offset % schedule.chaptersPerDay];
  return { date: date.toISOString().slice(0, 10), time };
}

async function chapterFilesIn(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && CHAPTER_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort(sortByLeadingNumber)
    .map((name) => path.join(dir, name));
}

async function readChapter(file, chapterNumber) {
  const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const titleIndex = lines.findIndex((line) => line.trim());
  if (titleIndex < 0) throw new Error(`章节文件为空: ${file}`);
  const originalTitle = lines[titleIndex].trim();
  const title = normalizeChapterTitle(originalTitle);
  const body = lines.slice(titleIndex + 1).join('\n').trim();
  if (!title) throw new Error(`章节标题为空: ${file}`);
  if (!body) throw new Error(`章节正文为空: ${file}`);
  return {
    chapterNumber,
    file,
    originalTitle,
    title,
    body,
    nonWhitespaceLength: body.replace(/\s/gu, '').length,
  };
}

export async function discoverFanqieChapters(bookDir, binding, options = {}) {
  const volumeMode = options.volumeMode === true;
  let files = [];
  if (!volumeMode) {
    const sourceDir = resolveInside(bookDir, binding.sourceDir);
    if (!fssync.existsSync(sourceDir)) throw new Error(`番茄正文目录不存在: ${sourceDir}`);
    files = await chapterFilesIn(sourceDir);
    for (let index = 0; index < files.length; index++) {
      const order = extractFileOrder(path.basename(files[index]));
      if (order !== index + 1) {
        throw new Error(`正文文件必须从 1 连续编号；期望第 ${index + 1} 章，实际文件 ${path.basename(files[index])}`);
      }
    }
  } else {
    const entries = await fs.readdir(bookDir, { withFileTypes: true });
    const volumes = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort(sortVolumeNames);
    for (const volume of volumes) {
      const sourceDir = resolveInside(bookDir, volume, binding.sourceDir);
      if (fssync.existsSync(sourceDir)) files.push(...await chapterFilesIn(sourceDir));
    }
  }
  if (!files.length) throw new Error(`没有找到可上传的 .md/.txt 正文章节: ${bookDir}`);
  return Promise.all(files.map((file, index) => readChapter(file, index + 1)));
}

export async function loadFanqieBook(projectRoot, bookName) {
  const root = path.resolve(projectRoot);
  const xiePath = path.join(root, 'config-xie.json');
  const xie = JSON.parse((await fs.readFile(xiePath, 'utf8')).replace(/^\uFEFF/, ''));
  const catalog = await loadBookCatalog({
    bookConfigDir: path.resolve(root, xie.bookConfigDir || 'config/books'),
    bookCatalogMode: xie.bookCatalogMode || 'explicit',
  });
  const item = catalog.books.get(String(bookName || '').trim());
  if (!item) throw new Error(`未找到书籍配置: ${bookName}`);
  if (!item.enabled) throw new Error(`书籍已禁用: ${bookName}`);
  const binding = await resolveFanqieBinding(root, item.fanqie, `${path.basename(item.sourceFile)}:fanqie`);
  if (!binding) throw new Error(`书籍尚未绑定番茄账号: ${bookName}`);
  const bookDir = resolveInside(path.join(root, '书籍'), item.name);
  if (!fssync.existsSync(bookDir)) throw new Error(`书籍目录不存在: ${bookDir}`);
  const chapters = await discoverFanqieChapters(bookDir, binding, { volumeMode: xie.volumeMode === true });
  return { projectRoot: root, book: item, binding, bookDir, chapters, volumeMode: xie.volumeMode === true };
}

export async function inspectFanqieAccountAssignments(projectRoot) {
  const root = path.resolve(projectRoot);
  const configDir = path.join(root, 'config', 'books');
  const configuredBooks = [];
  for (const name of (await fs.readdir(configDir)).filter((file) => file.endsWith('.json')).sort()) {
    const raw = await readJson(path.join(configDir, name));
    if (raw.fanqie && raw.fanqie.enabled !== false) configuredBooks.push({ name, raw });
  }
  if (!configuredBooks.length) return { ok: true, assignments: [], errors: [], accountFile: null };
  const registry = await loadFanqieAccountRegistry(root);
  const assignments = [];
  const errors = [];
  for (const { name, raw } of configuredBooks) {
    const ref = String(raw.fanqie.accountRef || '').trim();
    if (!ref) {
      errors.push({ code: 'legacy_inline_account', book: raw.name, detail: `${name} 仍使用内联本机 Profile 配置` });
      continue;
    }
    const account = registry.accounts[ref];
    if (!account) {
      errors.push({ code: 'missing_account_ref', book: raw.name, detail: `找不到本机账号 ${ref}` });
      continue;
    }
    const profileDir = String(account.profileDir || '').trim();
    const cdpPort = Number(account.cdpPort || 9333);
    if (!path.isAbsolute(profileDir)) {
      errors.push({ code: 'invalid_profile_dir', book: raw.name, detail: `本机账号 ${ref} 的 profileDir 必须是绝对路径` });
      continue;
    }
    if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) {
      errors.push({ code: 'invalid_cdp_port', book: raw.name, detail: `本机账号 ${ref} 的 cdpPort 无效` });
      continue;
    }
    assignments.push({ book: raw.name, accountRef: ref, profileDir: path.normalize(profileDir), cdpPort });
  }
  for (let left = 0; left < assignments.length; left++) {
    for (let right = left + 1; right < assignments.length; right++) {
      const a = assignments[left];
      const b = assignments[right];
      if (a.accountRef === b.accountRef) continue;
      if (a.cdpPort === b.cdpPort) errors.push({ code: 'cdp_port_collision', books: [a.book, b.book], detail: `不同账号共用 CDP 端口 ${a.cdpPort}` });
      if (a.profileDir.toLocaleLowerCase() === b.profileDir.toLocaleLowerCase()) {
        errors.push({ code: 'profile_collision', books: [a.book, b.book], detail: '不同账号引用同一个 Chrome Profile' });
      }
    }
  }
  return { ok: errors.length === 0, assignments, errors, accountFile: registry.file };
}

function textLength(value) {
  return Array.from(String(value || '')).length;
}

export function buildFanqieQualityReport(chapters, binding) {
  const issues = [];
  const titleOwners = new Map();
  const add = (level, chapter, code, detail) => issues.push({
    level, chapterNumber: chapter.chapterNumber, file: chapter.file, code, detail,
  });
  for (const chapter of chapters) {
    const titleChars = textLength(chapter.title);
    if (titleChars > binding.quality.maxTitleChars) {
      add('error', chapter, 'title_too_long', `标题 ${titleChars} 字，超过上限 ${binding.quality.maxTitleChars}`);
    }
    if (/^#{1,6}\s*/u.test(chapter.originalTitle) || /^#{1,6}\s*/u.test(chapter.title)) {
      add('error', chapter, 'markdown_title', '标题包含 Markdown # 前缀');
    }
    const normalized = normalizeChapterTitle(chapter.title).toLocaleLowerCase('zh-CN');
    if (titleOwners.has(normalized)) {
      add('error', chapter, 'duplicate_title', `与第 ${titleOwners.get(normalized)} 章标题重复`);
    } else titleOwners.set(normalized, chapter.chapterNumber);
    if (chapter.nonWhitespaceLength < binding.quality.minBodyChars) {
      add('error', chapter, 'body_too_short', `正文 ${chapter.nonWhitespaceLength} 字，低于下限 ${binding.quality.minBodyChars}`);
    }
    if (chapter.nonWhitespaceLength > binding.quality.maxBodyChars) {
      add('error', chapter, 'body_too_long', `正文 ${chapter.nonWhitespaceLength} 字，超过上限 ${binding.quality.maxBodyChars}`);
    }
    if (/(作为(?:一个)?AI|以下是(?:根据|为你)|希望以上内容)/u.test(chapter.body)) {
      add('warning', chapter, 'suspected_ai_artifact', '正文包含疑似助手回复残留，请人工核对');
    }
    if (/^#{1,6}\s+\S+/mu.test(chapter.body)) {
      add('warning', chapter, 'markdown_heading_in_body', '正文包含 Markdown 标题标记，请确认不会原样上传 #');
    }
    if (normalizeChapterTitle(chapter.body.split('\n').find((line) => line.trim()) || '') === normalizeChapterTitle(chapter.title)) {
      add('warning', chapter, 'repeated_title', '正文首行疑似重复章节标题');
    }
  }
  const lengths = chapters.map((chapter) => chapter.nonWhitespaceLength);
  return {
    ok: !issues.some((issue) => issue.level === 'error'),
    chapterCount: chapters.length,
    stats: {
      minBodyChars: Math.min(...lengths),
      maxBodyChars: Math.max(...lengths),
      averageBodyChars: Math.round(lengths.reduce((sum, value) => sum + value, 0) / lengths.length),
    },
    errors: issues.filter((issue) => issue.level === 'error'),
    warnings: issues.filter((issue) => issue.level === 'warning'),
  };
}

function shanghaiDate(date, time) {
  return new Date(`${date}T${time}:00+08:00`);
}

export function buildFanqieScheduleReport(chapters, binding, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const minimum = now.getTime() + binding.quality.minimumLeadMinutes * 60_000;
  const entries = chapters.map((chapter) => ({
    chapterNumber: chapter.chapterNumber,
    title: chapter.title,
    ...calculateFanqiePublishAt(chapter.chapterNumber, binding.schedule),
  }));
  const errors = entries
    .filter((entry) => shanghaiDate(entry.date, entry.time).getTime() < minimum)
    .map((entry) => ({
      level: 'error', chapterNumber: entry.chapterNumber, code: 'schedule_too_early',
      detail: `${entry.date} ${entry.time} 早于当前时间加 ${binding.quality.minimumLeadMinutes} 分钟`,
    }));
  return { ok: errors.length === 0, timeZone: binding.timeZone, entries, errors };
}

export function createFanqieUploadPlan(localChapters, remoteChapters, options = {}) {
  if (remoteChapters.length > localChapters.length) {
    throw new Error(`番茄已有 ${remoteChapters.length} 章，但本地只有 ${localChapters.length} 章，已停止以避免覆盖错书`);
  }
  const minimumRemoteCount = Number(options.minimumRemoteCount || 0);
  if (remoteChapters.length < minimumRemoteCount) {
    throw new Error(`番茄现有章节只有 ${remoteChapters.length} 章，但排期从第 ${minimumRemoteCount + 1} 章开始；已停止以避免漏传或重排前置章节`);
  }
  for (let index = 0; index < remoteChapters.length; index++) {
    const localTitle = normalizeChapterTitle(localChapters[index].title);
    const remoteTitle = normalizeChapterTitle(remoteChapters[index].title);
    if (localTitle !== remoteTitle) {
      throw new Error(`第 ${index + 1} 章标题不一致：本地“${localTitle}”，番茄“${remoteTitle}”`);
    }
  }
  const knownRemoteCount = Number(options.knownRemoteCount || 0);
  if (!Number.isInteger(knownRemoteCount) || knownRemoteCount < 0 || knownRemoteCount > localChapters.length) {
    throw new Error('knownRemoteCount 必须是有效的本地章节前缀');
  }
  // 远端列表偶尔在异步加载窗口内返回空表；已经取得远端章节 ID 的连续本地记录
  // 仍可作为防重下界，但不能替代上面对当前可见远端标题的逐章核验。
  const nextChapter = Math.max(remoteChapters.length, knownRemoteCount) + 1;
  const requestedFrom = options.from == null ? nextChapter : positiveInteger(options.from, '--from');
  const requestedTo = options.to == null ? localChapters.length : positiveInteger(options.to, '--to');
  if (requestedFrom > nextChapter) throw new Error(`不能跳过第 ${nextChapter} 章直接从第 ${requestedFrom} 章上传`);
  if (requestedTo < requestedFrom) {
    if (requestedFrom === nextChapter && nextChapter > localChapters.length) return [];
    throw new Error('--to 不能小于 --from');
  }
  const start = Math.max(nextChapter, requestedFrom);
  const end = Math.min(requestedTo, localChapters.length);
  return start > end ? [] : localChapters.slice(start - 1, end);
}
