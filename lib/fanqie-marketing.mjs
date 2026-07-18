import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInside } from './path-safety.mjs';

export const FANQIE_TAG_GROUPS = Object.freeze(['主题', '角色', '情节']);

function text(value, label) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`${label} 不能为空`);
  return result;
}
function shortText(value, label, max) {
  const result = text(value, label);
  if ([...result].length > max) throw new Error(`${label} 不能超过 ${max} 个字符`);
  return result;
}

function normalizeEntry(projectRoot, id, raw) {
  const context = `fanqie-marketing.books.${id}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${context} 必须是对象`);
  const workId = text(raw.workId, `${context}.workId`);
  if (!/^\d+$/u.test(workId)) throw new Error(`${context}.workId 必须是数字作品 ID`);
  const localBook = text(raw.localBook, `${context}.localBook`);
  const coverPath = text(raw.coverPath, `${context}.coverPath`);
  if (path.isAbsolute(coverPath)) throw new Error(`${context}.coverPath 必须是项目内相对路径`);
  const coverFile = resolveInside(projectRoot, coverPath);
  const protagonists = Array.isArray(raw.protagonists)
    ? raw.protagonists.map((item, index) => shortText(item, `${context}.protagonists[${index}]`, 5))
    : [];
  if (protagonists.length < 1 || protagonists.length > 2) throw new Error(`${context}.protagonists 必须包含 1 至 2 个主角名`);
  const tags = {};
  for (const group of FANQIE_TAG_GROUPS) {
    const values = raw.tags?.[group];
    if (!Array.isArray(values) || values.length < 1 || values.length > 2) {
      throw new Error(`${context}.tags.${group} 必须包含 1 至 2 个标签`);
    }
    tags[group] = values.map((item, index) => shortText(item, `${context}.tags.${group}[${index}]`, 12));
  }
  const intro = text(raw.intro, `${context}.intro`).replace(/\r\n/gu, '\n');
  if ([...intro].length > 500) throw new Error(`${context}.intro 不能超过 500 个字符`);
  return {
    id: String(id),
    localBook,
    accountRef: text(raw.accountRef, `${context}.accountRef`),
    workId,
    workTitle: text(raw.workTitle, `${context}.workTitle`),
    authorName: text(raw.authorName, `${context}.authorName`),
    coverPath,
    coverFile,
    bodyDir: resolveInside(projectRoot, '书籍', localBook, '正文'),
    protagonists,
    mainCategory: text(raw.mainCategory, `${context}.mainCategory`),
    tags,
    intro,
  };
}

export async function loadFanqieMarketingConfig(projectRoot) {
  const root = path.resolve(projectRoot);
  const file = path.join(root, 'config', 'fanqie-marketing.json');
  const raw = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
  if (!raw.books || typeof raw.books !== 'object' || Array.isArray(raw.books)) {
    throw new Error(`${file} 缺少 books 对象`);
  }
  const books = Object.fromEntries(Object.entries(raw.books).map(([id, entry]) => [id, normalizeEntry(root, id, entry)]));
  const localBooks = new Set();
  const works = new Set();
  for (const entry of Object.values(books)) {
    if (localBooks.has(entry.localBook)) throw new Error(`营销配置重复绑定本地书籍: ${entry.localBook}`);
    if (works.has(entry.workId)) throw new Error(`营销配置重复绑定番茄作品: ${entry.workId}`);
    localBooks.add(entry.localBook);
    works.add(entry.workId);
  }
  return {
    file,
    observedAt: text(raw.observedAt, 'fanqie-marketing.observedAt'),
    benchmark: text(raw.benchmark, 'fanqie-marketing.benchmark'),
    books,
  };
}

export function findFanqieMarketingEntry(config, options = {}) {
  const book = String(options.book || '').trim();
  const workId = String(options.workId || '').trim();
  const matches = Object.values(config.books).filter((entry) => (
    (!book || entry.localBook === book) && (!workId || entry.workId === workId)
  ));
  if (matches.length !== 1) {
    throw new Error(`无法唯一定位番茄营销资料：book=${book || '(空)'} workId=${workId || '(空)'}`);
  }
  return matches[0];
}

export function fanqieMarketingExpectedFields(entry) {
  return [
    entry.mainCategory,
    ...entry.tags['主题'],
    ...entry.tags['角色'],
    ...entry.tags['情节'],
    ...entry.protagonists,
  ];
}

export function classifyFanqieMarketingSubmission({ body = '', entry, editDisabled = false, successToast = false }) {
  const missingFields = fanqieMarketingExpectedFields(entry).filter((value) => !String(body).includes(value));
  const introVisible = String(body).includes(entry.intro);
  if (!missingFields.length && introVisible) {
    return { ok: true, status: 'visible', introVisible, missingFields };
  }
  if (editDisabled || successToast) {
    return { ok: true, status: 'pending_review', introVisible, missingFields };
  }
  return { ok: false, status: 'uncertain', introVisible, missingFields };
}

export function renderFanqieMarketingMarkdown(entry, source = {}) {
  const tags = FANQIE_TAG_GROUPS.map((group) => `- ${group}：${entry.tags[group].join('、')}`).join('\n');
  return `# 番茄书籍信息\n\n` +
    `> 本文件由 \`npm run fanqie:marketing-sync\` 从中央配置生成，请修改 \`config/fanqie-marketing.json\` 后重新同步。\n\n` +
    `- 本地书籍：${entry.localBook}\n` +
    `- 番茄书名：${entry.workTitle}\n` +
    `- 作者名：${entry.authorName}\n` +
    `- 番茄作品 ID：${entry.workId}\n` +
    `- 账号引用：${entry.accountRef}\n` +
    `- 主角名：${entry.protagonists.join('、')}\n` +
    `- 主分类：${entry.mainCategory}\n` +
    `${tags}\n` +
    `- 榜单观察日期：${source.observedAt || ''}\n` +
    `- 参考榜单：${source.benchmark || ''}\n\n` +
    `## 作品简介\n\n${entry.intro}\n\n` +
    `## 封面\n\n同目录文件：\`番茄封面.png\`（600×800）。\n`;
}

export async function syncFanqieMarketingFiles(projectRoot, options = {}) {
  const config = options.config || await loadFanqieMarketingConfig(projectRoot);
  const selected = Object.values(config.books).filter((entry) => !options.book || entry.localBook === options.book);
  if (!selected.length) throw new Error(`营销配置中没有书籍: ${options.book}`);
  const results = [];
  for (const entry of selected) {
    await fs.access(entry.coverFile);
    await fs.access(entry.bodyDir);
    const coverTarget = path.join(entry.bodyDir, '番茄封面.png');
    const infoTarget = path.join(entry.bodyDir, '番茄书籍信息.md');
    await fs.copyFile(entry.coverFile, coverTarget);
    await fs.writeFile(infoTarget, renderFanqieMarketingMarkdown(entry, config), 'utf8');
    results.push({ book: entry.localBook, cover: coverTarget, info: infoTarget });
  }
  return { ok: true, count: results.length, results };
}
