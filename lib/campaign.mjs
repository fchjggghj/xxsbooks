import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { assertSafePathSegment, resolveInside } from './path-safety.mjs';
import { acquireQueueLock, releaseQueueLock } from '../queue-lock.mjs';
import { inspectFanqieLock } from './fanqie-lock.mjs';

const SCHEMA_VERSION = 1;
const MATERIAL_STATE_PARTS = ['书籍', '.state', 'materials', 'catalog.json'];
const CAMPAIGN_STATE_PARTS = ['书籍', '.state', 'campaign', 'state.json'];
const CHAPTER_EXTENSIONS = new Set(['.txt', '.md']);
const CHAPTER_HEADING = /^第\s*[0-9〇零一二三四五六七八九十百千万两]+\s*章[^\r\n]*$/gmu;

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function readJsonIfExists(file) {
  try { return await readJson(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

async function withCampaignWrite(projectRoot, command, action) {
  const fanqieLock = await inspectFanqieLock(projectRoot);
  if (fanqieLock.active) throw new Error(`番茄发布正在运行（PID ${fanqieLock.info?.pid || '未知'}），拒绝修改投放状态。`);
  const handle = await acquireQueueLock(projectRoot, { command });
  try { return await action(); }
  finally { await releaseQueueLock(handle); }
}

function stateFile(projectRoot) {
  return path.join(path.resolve(projectRoot), ...CAMPAIGN_STATE_PARTS);
}

function shanghaiToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function parseYmd(value, label = '日期') {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} 必须是 YYYY-MM-DD。`);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error(`${label} 无效: ${text}`);
  return text;
}

function compareDate(left, right) {
  return parseYmd(left).localeCompare(parseYmd(right));
}

function addMonths(month, count) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`月份必须是 YYYY-MM: ${month}`);
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + count, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function campaignCycles(month, config) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`月份必须是 YYYY-MM: ${month}`);
  const starts = config.cycleStartDays;
  return starts.map((day, index) => {
    const startDate = `${month}-${String(day).padStart(2, '0')}`;
    const nextDate = index + 1 < starts.length
      ? `${month}-${String(starts[index + 1]).padStart(2, '0')}`
      : `${addMonths(month, 1)}-${String(starts[0]).padStart(2, '0')}`;
    return { number: index + 1, id: `${month}-C${index + 1}`, month, startDate, evaluateOn: nextDate };
  });
}

export function cycleForDate(dateText, config) {
  const date = parseYmd(dateText);
  const month = date.slice(0, 7);
  const cycles = campaignCycles(month, config);
  const found = [...cycles].reverse().find((cycle) => compareDate(date, cycle.startDate) >= 0);
  if (found) return found;
  return campaignCycles(addMonths(month, -1), config).at(-1);
}

function nextCycle(cycle, config) {
  if (cycle.number < config.cycleStartDays.length) return campaignCycles(cycle.month, config)[cycle.number];
  return campaignCycles(addMonths(cycle.month, 1), config)[0];
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} 必须是正整数。`);
  return number;
}

export async function loadCampaignConfig(projectRoot) {
  const file = path.join(path.resolve(projectRoot), 'config', 'campaign.json');
  const raw = await readJson(file);
  if (raw.schemaVersion !== SCHEMA_VERSION) throw new Error(`投放配置版本不受支持: ${raw.schemaVersion}`);
  const laneCount = positiveInteger(raw.laneCount, 'laneCount');
  const initialChapters = positiveInteger(raw.initialChapters, 'initialChapters');
  const continuationChapters = positiveInteger(raw.continuationChapters, 'continuationChapters');
  const cycleStartDays = Array.isArray(raw.cycleStartDays) ? raw.cycleStartDays.map(Number) : [];
  if (cycleStartDays.length !== 3 || cycleStartDays.some((day) => !Number.isInteger(day) || day < 1 || day > 28)) {
    throw new Error('cycleStartDays 必须包含 3 个 1-28 的日期。');
  }
  if ([...cycleStartDays].sort((a, b) => a - b).some((day, index) => day !== cycleStartDays[index])) {
    throw new Error('cycleStartDays 必须严格递增。');
  }
  return {
    file,
    config: {
      ...raw,
      laneCount,
      initialChapters,
      continuationChapters,
      cycleStartDays,
      timeZone: 'Asia/Shanghai',
    },
  };
}

export async function loadCampaignState(projectRoot) {
  const file = stateFile(projectRoot);
  const state = await readJsonIfExists(file);
  if (state && state.schemaVersion !== SCHEMA_VERSION) throw new Error(`投放状态版本不受支持: ${state.schemaVersion}`);
  return { file, state };
}

async function bookConfigs(projectRoot) {
  const dir = path.join(path.resolve(projectRoot), 'config', 'books');
  const items = [];
  for (const name of (await fs.readdir(dir)).filter((item) => item.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    items.push({ file, name, raw: await readJson(file) });
  }
  return items;
}

async function materialCatalog(projectRoot) {
  return readJsonIfExists(path.join(path.resolve(projectRoot), ...MATERIAL_STATE_PARTS));
}

function normalizedTitle(value) {
  return (String(value || '').normalize('NFKC').toLocaleLowerCase('zh-Hans-CN').match(/[\p{L}\p{N}]/gu) || []).join('');
}

function exactMaterialMatch(bookName, catalog) {
  if (!catalog?.items) return null;
  const key = normalizedTitle(bookName);
  const matches = catalog.items.filter((item) => normalizedTitle(item.title) === key);
  return matches.length === 1 ? { sourceId: matches[0].sourceId, relativePath: matches[0].relativePath, itemId: matches[0].id } : null;
}

async function accountPool(projectRoot) {
  const file = path.join(path.resolve(projectRoot), 'config', 'local', 'fanqie-accounts.json');
  const raw = await readJson(file);
  const accounts = Object.entries(raw.accounts || {})
    .filter(([, account]) => account.publishingEnabled !== false && account.status !== 'unavailable')
    .map(([ref, account]) => {
      const defaultDir = path.join(account.profileDir || '', account.profileName || 'Default');
      const initialized = Boolean(
        account.profileDir && fssync.existsSync(path.join(account.profileDir, 'Local State'))
        && fssync.existsSync(path.join(defaultDir, 'Preferences')),
      );
      const cookieStoreExists = Boolean(
        fssync.existsSync(path.join(defaultDir, 'Network', 'Cookies')) || fssync.existsSync(path.join(defaultDir, 'Cookies')),
      );
      const order = Number(String(account.sourceAccountId || ref).match(/(\d+)$/)?.[1] || Number.MAX_SAFE_INTEGER);
      return { ref, label: account.label || ref, order, initialized, cookieStoreExists };
    });
  accounts.sort((left, right) => left.order - right.order || left.ref.localeCompare(right.ref));
  return { file, accounts };
}

function accountForLane(existingRef, pool, occupied, preferInitialized) {
  if (existingRef) {
    if (occupied.has(existingRef)) throw new Error(`账号 ${existingRef} 被多本启用书籍重复占用。`);
    if (!pool.some((item) => item.ref === existingRef)) throw new Error(`本机账号注册表缺少 ${existingRef}。`);
    occupied.add(existingRef);
    return existingRef;
  }
  const available = pool.filter((item) => !occupied.has(item.ref));
  const selected = preferInitialized
    ? available.find((item) => item.initialized && item.cookieStoreExists) || available[0]
    : available[0];
  if (!selected) throw new Error('没有足够的本机番茄账号分配给 6 条投放线。');
  occupied.add(selected.ref);
  return selected.ref;
}

function baseState(config, cycle, lanes) {
  return {
    schemaVersion: SCHEMA_VERSION,
    campaignName: config.name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeCycle: cycle,
    lanes,
  };
}

export async function bootstrapCampaign(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const loaded = await loadCampaignConfig(root);
  const existing = await loadCampaignState(root);
  if (existing.state) {
    return { ok: true, command: 'campaign bootstrap', applied: false, readOnly: true, existing: true, stateFile: existing.file, state: existing.state };
  }
  const today = options.today ? parseYmd(options.today) : shanghaiToday();
  const cycle = options.month
    ? campaignCycles(options.month, loaded.config)[positiveInteger(options.cycle || 1, 'cycle') - 1]
    : cycleForDate(today, loaded.config);
  if (!cycle) throw new Error('cycle 超出配置范围。');
  const configs = (await bookConfigs(root)).filter((item) => item.raw.enabled !== false).slice(0, loaded.config.laneCount);
  if (configs.length !== loaded.config.laneCount) {
    throw new Error(`启动投放需要 ${loaded.config.laneCount} 本启用书籍，当前只有 ${configs.length} 本。`);
  }
  const materials = await materialCatalog(root);
  const pool = await accountPool(root);
  const occupied = new Set();
  const lanes = {};
  for (let index = 0; index < configs.length; index++) {
    const item = configs[index];
    const lane = index + 1;
    const targetChapters = Number(item.raw.stages?.xie?.chapterRange?.end || loaded.config.initialChapters);
    const accountRef = accountForLane(
      item.raw.fanqie?.enabled !== false ? item.raw.fanqie?.accountRef : '',
      pool.accounts,
      occupied,
      loaded.config.accountPolicy?.preferInitializedProfiles !== false,
    );
    lanes[String(lane)] = {
      lane,
      accountRef,
      history: [],
      current: {
        book: item.raw.name,
        configFile: path.relative(root, item.file),
        source: exactMaterialMatch(item.raw.name, materials),
        targetChapters,
        cycle,
        metrics: null,
        decision: null,
      },
    };
  }
  const state = baseState(loaded.config, cycle, lanes);
  if (options.apply) await withCampaignWrite(root, 'campaign-bootstrap', () => writeJsonAtomic(existing.file, state));
  return {
    ok: true,
    command: 'campaign bootstrap',
    applied: options.apply === true,
    readOnly: options.apply !== true,
    existing: false,
    stateFile: existing.file,
    state,
    accountPool: { total: pool.accounts.length, initialized: pool.accounts.filter((item) => item.initialized && item.cookieStoreExists).length },
  };
}

function chapterNumber(name) {
  const value = Number(path.parse(name).name.match(/\d+/)?.[0]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function chapterCoverage(dir, target) {
  if (!fssync.existsSync(dir)) return { count: 0, complete: false, missing: Array.from({ length: target }, (_, index) => index + 1) };
  const numbers = new Set((await fs.readdir(dir, { withFileTypes: true }))
    .filter((item) => item.isFile() && CHAPTER_EXTENSIONS.has(path.extname(item.name).toLowerCase()))
    .map((item) => chapterNumber(item.name)).filter(Boolean));
  const missing = [];
  for (let number = 1; number <= target; number++) if (!numbers.has(number)) missing.push(number);
  return { count: [...numbers].filter((number) => number <= target).length, complete: missing.length === 0, missing: missing.slice(0, 20) };
}

async function fanqieConfirmed(projectRoot, bookConfig, target) {
  const binding = bookConfig?.fanqie;
  if (!binding || binding.enabled === false || !binding.workId || !binding.accountRef) return { bound: false, confirmed: 0, stateExists: false };
  const file = path.join(projectRoot, '书籍', '.state', 'fanqie', String(binding.workId), 'state.json');
  const state = await readJsonIfExists(file);
  const chapters = Object.values(state?.chapters || {});
  return {
    bound: true,
    workId: binding.workId,
    workTitle: binding.workTitle,
    accountRef: binding.accountRef,
    accountMatchesLane: null,
    stateExists: Boolean(state),
    confirmed: chapters.filter((item) => item.phase === 'confirmed' && item.chapterNumber <= target).length,
    uncertain: chapters.filter((item) => ['submitting', 'submitted', 'failed'].includes(item.phase)).map((item) => item.chapterNumber),
  };
}

function derivePhase(item, today) {
  if (!item.current) return 'awaiting_replacement';
  if (!item.pipeline.original.complete) return 'source_incomplete';
  if (!item.pipeline.chai.complete) return 'chai_pending';
  if (!item.pipeline.xie.complete) return 'xie_pending';
  if (!item.fanqie.bound) return 'awaiting_fanqie_binding';
  if (!item.fanqie.accountMatchesLane) return 'account_binding_mismatch';
  if (item.fanqie.uncertain.length) return 'publish_attention';
  if (item.fanqie.confirmed < item.current.targetChapters) return item.fanqie.stateExists ? 'publishing' : 'ready_to_publish';
  if (compareDate(today, item.current.cycle.evaluateOn) >= 0) return item.current.metrics ? 'decision_due' : 'metrics_due';
  return 'observing';
}

function nextAction(item, labels) {
  const bookArg = JSON.stringify(item.current?.book || '');
  if (item.phase === 'chai_pending') return `node control.mjs start chai --book ${bookArg}`;
  if (item.phase === 'xie_pending') return `node control.mjs start xie --book ${bookArg}`;
  if (item.phase === 'awaiting_fanqie_binding') return `为 ${item.current.book} 创建番茄作品并绑定账号 ${item.accountRef}`;
  if (item.phase === 'account_binding_mismatch') return `把 ${item.current.book} 改绑到投放线账号 ${item.accountRef}`;
  if (item.phase === 'ready_to_publish' || item.phase === 'publishing') return `node control.mjs fanqie upload --book ${bookArg}`;
  if (item.phase === 'metrics_due') return `node control.mjs campaign metrics --lane ${item.lane} ... --apply`;
  if (item.phase === 'decision_due') return `node control.mjs campaign decide --lane ${item.lane} --decision <continue|replace> --reason <原因> --apply`;
  if (item.phase === 'awaiting_replacement') return `node control.mjs campaign enroll --lane ${item.lane} --file <素材相对路径> --book <新书名> --apply`;
  if (item.phase === 'source_incomplete') return `${item.current.book} 缺少目标范围内的原文章节`;
  if (item.phase === 'publish_attention') return `${item.current.book} 存在不确定发布状态，先运行 reconcile 预览`;
  return `${labels.chai}、${labels.xie}、发布或观察均按计划进行`;
}

export async function campaignStatus(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const loaded = await loadCampaignConfig(root);
  const saved = await loadCampaignState(root);
  const today = options.today ? parseYmd(options.today) : shanghaiToday();
  if (!saved.state) {
    return {
      ok: true, command: 'campaign status', readOnly: true, initialized: false, today,
      currentCycle: cycleForDate(today, loaded.config), stateFile: saved.file,
      nextAction: 'node control.mjs campaign bootstrap --apply',
    };
  }
  const configs = await bookConfigs(root);
  const byBook = new Map(configs.map((item) => [item.raw.name, item]));
  const lanes = [];
  for (const lane of Object.values(saved.state.lanes || {}).sort((a, b) => a.lane - b.lane)) {
    if (!lane.current) {
      const item = { ...lane, phase: 'awaiting_replacement', pipeline: null, fanqie: null };
      item.nextAction = nextAction(item, loaded.config.stageLabels);
      lanes.push(item);
      continue;
    }
    const book = byBook.get(lane.current.book);
    const bookDir = resolveInside(path.join(root, '书籍'), lane.current.book);
    const target = positiveInteger(lane.current.targetChapters, 'targetChapters');
    const pipeline = {
      original: await chapterCoverage(path.join(bookDir, '原文'), target),
      chai: await chapterCoverage(path.join(bookDir, '拆分'), target),
      xie: await chapterCoverage(path.join(bookDir, '正文'), target),
    };
    const fanqie = await fanqieConfirmed(root, book?.raw, target);
    if (fanqie.bound) fanqie.accountMatchesLane = fanqie.accountRef === lane.accountRef;
    const item = { ...lane, configExists: Boolean(book), configEnabled: book?.raw.enabled !== false, pipeline, fanqie };
    item.phase = derivePhase(item, today);
    item.nextAction = nextAction(item, loaded.config.stageLabels);
    lanes.push(item);
  }
  const phaseCounts = {};
  for (const lane of lanes) phaseCounts[lane.phase] = (phaseCounts[lane.phase] || 0) + 1;
  const attentionPhases = new Set(['source_incomplete', 'awaiting_fanqie_binding', 'account_binding_mismatch', 'publish_attention', 'metrics_due', 'decision_due', 'awaiting_replacement']);
  return {
    ok: lanes.every((lane) => !['source_incomplete', 'account_binding_mismatch', 'publish_attention'].includes(lane.phase)),
    attentionRequired: lanes.some((lane) => attentionPhases.has(lane.phase)),
    command: 'campaign status', readOnly: true, initialized: true, today,
    config: { file: loaded.file, name: loaded.config.name, laneCount: loaded.config.laneCount, initialChapters: loaded.config.initialChapters, continuationChapters: loaded.config.continuationChapters, stageLabels: loaded.config.stageLabels },
    stateFile: saved.file,
    activeCycle: saved.state.activeCycle,
    phaseCounts,
    lanes,
  };
}

export function splitNovelText(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const matches = [...normalized.matchAll(CHAPTER_HEADING)];
  if (!matches.length) throw new Error('素材正文中没有识别到“第N章”章节标题。');
  return matches.map((match, index) => {
    const start = match.index;
    const end = matches[index + 1]?.index ?? normalized.length;
    const block = normalized.slice(start, end).trim();
    const newline = block.indexOf('\n');
    const title = (newline < 0 ? block : block.slice(0, newline)).trim();
    const body = (newline < 0 ? '' : block.slice(newline + 1)).trim();
    if (!body) throw new Error(`素材第 ${index + 1} 章正文为空: ${title}`);
    return { chapterNumber: index + 1, title, body, text: `${title}\n${body}\n` };
  });
}

async function resolveMaterial(projectRoot, sourceId, relativePath) {
  const registry = await readJson(path.join(projectRoot, 'config', 'local', 'material-sources.json'));
  const source = registry.sources?.[sourceId];
  if (!source || !path.isAbsolute(source.root)) throw new Error(`找不到素材源: ${sourceId}`);
  const portable = String(relativePath || '').trim().replace(/\\/gu, '/');
  const target = path.resolve(source.root, ...portable.split('/'));
  const relative = path.relative(source.root, target);
  if (!portable || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('素材路径越界。');
  if (!fssync.existsSync(target)) throw new Error(`素材文件不存在: ${target}`);
  return { sourceId, relativePath: relative.split(path.sep).join('/'), absolutePath: target };
}

async function readNovelSource(file) {
  const buffer = await fs.readFile(file);
  try {
    return { buffer, text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    return { buffer, text: new TextDecoder('gb18030').decode(buffer), encoding: 'gb18030' };
  }
}

async function writeChapterRange(bookDir, chapters, from, to) {
  const originalDir = path.join(bookDir, '原文');
  await fs.mkdir(originalDir, { recursive: true });
  for (let number = from; number <= to; number++) {
    const chapter = chapters[number - 1];
    if (!chapter) throw new Error(`素材只有 ${chapters.length} 章，无法生成第 ${number} 章。`);
    const file = path.join(originalDir, `${String(number).padStart(4, '0')}.txt`);
    if (fssync.existsSync(file)) continue;
    await fs.writeFile(file, chapter.text, { encoding: 'utf8', flag: 'wx' });
  }
}

function nextBookConfigFile(configs, configDir) {
  const next = Math.max(0, ...configs.map((item) => Number(path.basename(item.name, '.json')) || 0)) + 1;
  return path.join(configDir, `${String(next).padStart(3, '0')}.json`);
}

export async function enrollCampaignBook(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const loaded = await loadCampaignConfig(root);
  const saved = await loadCampaignState(root);
  if (!saved.state) throw new Error('投放尚未初始化，请先 bootstrap。');
  const laneNumber = positiveInteger(options.lane, 'lane');
  const lane = saved.state.lanes?.[String(laneNumber)];
  if (!lane) throw new Error(`不存在投放线 ${laneNumber}。`);
  if (lane.current) throw new Error(`投放线 ${laneNumber} 当前仍有书籍 ${lane.current.book}；先做 replace 决策。`);
  const bookName = assertSafePathSegment(options.book, '书名');
  const sourceId = String(options.sourceId || 'main').trim();
  const material = await resolveMaterial(root, sourceId, options.relativePath);
  const sourceContent = await readNovelSource(material.absolutePath);
  const chapters = splitNovelText(sourceContent.text);
  if (chapters.length < loaded.config.initialChapters) throw new Error(`素材只有 ${chapters.length} 章，不足首轮 ${loaded.config.initialChapters} 章。`);
  const configs = await bookConfigs(root);
  if (configs.some((item) => item.raw.name === bookName)) throw new Error(`书籍配置已存在: ${bookName}`);
  const bookDir = resolveInside(path.join(root, '书籍'), bookName);
  if (fssync.existsSync(bookDir)) throw new Error(`书籍目录已存在: ${bookDir}`);
  const next = lane.pendingCycle || nextCycle(saved.state.activeCycle, loaded.config);
  const configFile = nextBookConfigFile(configs, path.join(root, 'config', 'books'));
  const sourceHash = crypto.createHash('sha256').update(sourceContent.buffer).digest('hex');
  const bookConfig = {
    name: bookName,
    enabled: true,
    stages: {
      chai: { enabled: true, chapterRange: { start: 1, end: loaded.config.initialChapters } },
      xie: { enabled: true, chapterRange: { start: 1, end: loaded.config.initialChapters } },
    },
    campaign: {
      lane: laneNumber,
      accountRef: lane.accountRef,
      source: { sourceId, relativePath: material.relativePath, sha256: sourceHash },
      enrolledAt: new Date().toISOString(),
    },
  };
  const current = {
    book: bookName,
    configFile: path.relative(root, configFile),
    source: bookConfig.campaign.source,
    targetChapters: loaded.config.initialChapters,
    cycle: next,
    metrics: null,
    decision: null,
  };
  const result = { ok: true, command: 'campaign enroll', applied: options.apply === true, readOnly: options.apply !== true, lane: laneNumber, accountRef: lane.accountRef, material, sourceEncoding: sourceContent.encoding, detectedChapters: chapters.length, book: bookName, bookDir, configFile, current };
  if (!options.apply) return result;
  const stageDir = `${bookDir}.campaign-${crypto.randomUUID()}.tmp`;
  await withCampaignWrite(root, 'campaign-enroll', async () => {
    try {
      await fs.mkdir(stageDir, { recursive: true });
      await fs.mkdir(path.join(stageDir, '拆分'));
      await fs.mkdir(path.join(stageDir, '正文'));
      await writeChapterRange(stageDir, chapters, 1, loaded.config.initialChapters);
      await fs.writeFile(path.join(stageDir, '来源.json'), `${JSON.stringify(bookConfig.campaign.source, null, 2)}\n`, 'utf8');
      await fs.rename(stageDir, bookDir);
      await writeJsonAtomic(configFile, bookConfig);
      const nextState = {
        ...saved.state,
        updatedAt: new Date().toISOString(),
        activeCycle: next,
        lanes: { ...saved.state.lanes, [String(laneNumber)]: { ...lane, pendingCycle: null, current } },
      };
      await writeJsonAtomic(saved.file, nextState);
    } catch (error) {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  });
  return result;
}

function numericMetric(value, label, { percent = false } = {}) {
  if (value == null || value === '') return null;
  const number = Number(value);
  const max = percent ? 100 : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(number) || number < 0 || number > max) throw new Error(`${label} 数值无效。`);
  return number;
}

export function evaluateCampaignMetrics(metrics, performance) {
  const requiredMissing = (performance.requiredMetrics || []).filter((name) => metrics[name] == null);
  const checks = Object.entries(performance.thresholds || {})
    .filter(([, threshold]) => threshold != null)
    .map(([metric, threshold]) => ({ metric, actual: metrics[metric] ?? null, threshold: Number(threshold), passed: metrics[metric] != null && Number(metrics[metric]) >= Number(threshold) }));
  if (performance.mode !== 'threshold' || !checks.length) {
    return { mode: 'manual', recommendation: null, requiredMissing, checks, detail: '当前为人工决策模式，成绩只记录不自动淘汰。' };
  }
  const passes = checks.filter((item) => item.passed).length;
  const minimumPasses = positiveInteger(performance.minimumPasses || checks.length, 'minimumPasses');
  return { mode: 'threshold', recommendation: requiredMissing.length ? null : (passes >= minimumPasses ? 'continue' : 'replace'), requiredMissing, checks, passes, minimumPasses };
}

export async function recordCampaignMetrics(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const loaded = await loadCampaignConfig(root);
  const saved = await loadCampaignState(root);
  if (!saved.state) throw new Error('投放尚未初始化。');
  const laneNumber = positiveInteger(options.lane, 'lane');
  const lane = saved.state.lanes?.[String(laneNumber)];
  if (!lane?.current) throw new Error(`投放线 ${laneNumber} 当前没有书籍。`);
  const metrics = {
    recordedAt: new Date().toISOString(),
    readers: numericMetric(options.readers, 'readers'),
    readThroughRate: numericMetric(options.readThroughRate, 'readThroughRate', { percent: true }),
    followers: numericMetric(options.followers, 'followers'),
    revenueCny: numericMetric(options.revenueCny, 'revenueCny'),
    comments: numericMetric(options.comments, 'comments'),
    note: String(options.note || '').trim(),
  };
  const evaluation = evaluateCampaignMetrics(metrics, loaded.config.performance || {});
  const result = { ok: evaluation.requiredMissing.length === 0, command: 'campaign metrics', applied: options.apply === true, readOnly: options.apply !== true, lane: laneNumber, book: lane.current.book, metrics, evaluation };
  if (options.apply) {
    if (evaluation.requiredMissing.length) throw new Error(`缺少必填成绩: ${evaluation.requiredMissing.join(', ')}。`);
    const nextLane = { ...lane, current: { ...lane.current, metrics } };
    await withCampaignWrite(root, 'campaign-metrics', () => writeJsonAtomic(saved.file, { ...saved.state, updatedAt: new Date().toISOString(), lanes: { ...saved.state.lanes, [String(laneNumber)]: nextLane } }));
  }
  return result;
}

async function extendBookSource(projectRoot, current, from, to) {
  const bookDir = resolveInside(path.join(projectRoot, '书籍'), current.book);
  const coverage = await chapterCoverage(path.join(bookDir, '原文'), to);
  if (coverage.complete) return { added: 0, available: coverage.count };
  if (!current.source?.sourceId || !current.source?.relativePath) {
    throw new Error(`${current.book} 的原文不足 ${to} 章，且没有可追溯的素材库来源。`);
  }
  const material = await resolveMaterial(projectRoot, current.source.sourceId, current.source.relativePath);
  const chapters = splitNovelText((await readNovelSource(material.absolutePath)).text);
  if (chapters.length < to) throw new Error(`来源素材只有 ${chapters.length} 章，无法续写到第 ${to} 章。`);
  await writeChapterRange(bookDir, chapters, from, to);
  return { added: to - from + 1, available: chapters.length };
}

export async function decideCampaignLane(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const loaded = await loadCampaignConfig(root);
  const saved = await loadCampaignState(root);
  if (!saved.state) throw new Error('投放尚未初始化。');
  const laneNumber = positiveInteger(options.lane, 'lane');
  const lane = saved.state.lanes?.[String(laneNumber)];
  if (!lane?.current) throw new Error(`投放线 ${laneNumber} 当前没有书籍。`);
  const decision = String(options.decision || '').trim();
  if (!['continue', 'replace'].includes(decision)) throw new Error('decision 必须是 continue 或 replace。');
  const reason = String(options.reason || '').trim();
  if (!reason) throw new Error('必须填写 --reason，保留成绩决策依据。');
  if (!lane.current.metrics) throw new Error('尚未记录成绩，拒绝做续写/淘汰决策。');
  const evaluation = evaluateCampaignMetrics(lane.current.metrics, loaded.config.performance || {});
  if (evaluation.requiredMissing.length) throw new Error(`成绩记录缺少必填项: ${evaluation.requiredMissing.join(', ')}。`);
  if (evaluation.recommendation && evaluation.recommendation !== decision && options.override !== true) {
    throw new Error(`阈值策略建议 ${evaluation.recommendation}；如坚持相反决策请显式使用 --override。`);
  }
  const today = options.today ? parseYmd(options.today) : shanghaiToday();
  if (compareDate(today, lane.current.cycle.evaluateOn) < 0 && options.override !== true) {
    throw new Error(`观察期尚未结束（${lane.current.cycle.evaluateOn}），如确需提前处理请显式使用 --override。`);
  }
  const next = nextCycle(lane.current.cycle, loaded.config);
  const decisionRecord = { decision, reason, decidedAt: new Date().toISOString(), metrics: lane.current.metrics, cycle: lane.current.cycle };
  const history = [...(lane.history || []), { ...lane.current, decision: decisionRecord }];
  const result = { ok: true, command: 'campaign decide', applied: options.apply === true, readOnly: options.apply !== true, lane: laneNumber, book: lane.current.book, decision, nextCycle: next, nextTargetChapters: decision === 'continue' ? lane.current.targetChapters + loaded.config.continuationChapters : null };
  if (!options.apply) return result;
  await withCampaignWrite(root, 'campaign-decide', async () => {
    const configs = await bookConfigs(root);
    const book = configs.find((item) => item.raw.name === lane.current.book);
    if (!book) throw new Error(`找不到书籍配置: ${lane.current.book}`);
    let current = null;
    if (decision === 'continue') {
      const previousTarget = lane.current.targetChapters;
      const targetChapters = previousTarget + loaded.config.continuationChapters;
      await extendBookSource(root, lane.current, previousTarget + 1, targetChapters);
      const bookConfig = {
        ...book.raw,
        enabled: true,
        stages: {
          ...book.raw.stages,
          chai: { ...(book.raw.stages?.chai || {}), enabled: true, chapterRange: { start: 1, end: targetChapters } },
          xie: { ...(book.raw.stages?.xie || {}), enabled: true, chapterRange: { start: 1, end: targetChapters } },
        },
      };
      await writeJsonAtomic(book.file, bookConfig);
      current = { ...lane.current, targetChapters, cycle: next, metrics: null, decision: null };
    } else {
      await writeJsonAtomic(book.file, { ...book.raw, enabled: false, retiredAt: new Date().toISOString(), retirementReason: reason });
    }
    const nextLane = { ...lane, history, current, pendingCycle: decision === 'replace' ? next : null };
    await writeJsonAtomic(saved.file, { ...saved.state, updatedAt: new Date().toISOString(), activeCycle: next, lanes: { ...saved.state.lanes, [String(laneNumber)]: nextLane } });
  });
  return result;
}
