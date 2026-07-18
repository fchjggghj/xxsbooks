import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {
  buildFanqieQualityReport,
  buildFanqieScheduleReport,
  calculateFanqiePublishAt,
  createFanqieUploadPlan,
  inspectFanqieAccountAssignments,
  loadFanqieAccountRegistry,
  loadFanqieBook,
  normalizeChapterTitle,
} from './fanqie-config.mjs';
import {
  connectFanqieBrowser,
  inspectFanqieRemoteChapters,
  updateFanqieBookMarketing,
  uploadFanqiePlan,
} from './fanqie-browser.mjs';
import { captureFanqieFailure } from './fanqie-evidence.mjs';
import { acquireFanqieLock, appendFanqieLog, inspectFanqieLock } from './fanqie-lock.mjs';
import {
  findFanqieMarketingEntry,
  loadFanqieMarketingConfig,
  syncFanqieMarketingFiles,
} from './fanqie-marketing.mjs';
import {
  applyFanqieReconcile,
  buildFanqieReconcile,
  loadFanqieState,
  recordFanqieChapterPhase,
  recordFanqiePlan,
  summarizeFanqieState,
} from './fanqie-state.mjs';

export async function listBoundFanqieBooks(projectRoot) {
  const dir = path.join(projectRoot, 'config', 'books');
  const books = [];
  for (const file of (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).sort()) {
    const raw = JSON.parse((await fs.readFile(path.join(dir, file), 'utf8')).replace(/^\uFEFF/, ''));
    if (raw.enabled !== false && raw.fanqie?.enabled !== false && raw.fanqie) books.push(raw.name);
  }
  return books;
}

export async function resolveFanqieBookName(projectRoot, requested) {
  if (String(requested || '').trim()) return String(requested).trim();
  const books = await listBoundFanqieBooks(projectRoot);
  if (books.length !== 1) throw new Error(`请用 --book 指定书名；当前启用的番茄绑定有 ${books.length} 个`);
  return books[0];
}

function planSummary(chapters, binding) {
  return chapters.map((chapter) => ({
    chapterNumber: chapter.chapterNumber,
    title: chapter.title,
    publishAt: calculateFanqiePublishAt(chapter.chapterNumber, binding.schedule),
    file: chapter.file,
  }));
}

function remoteStatusSummary(remote) {
  const statuses = {};
  for (const chapter of remote) statuses[chapter.status || '未知'] = (statuses[chapter.status || '未知'] || 0) + 1;
  return statuses;
}

function durableRemotePrefix(localChapters, state) {
  let count = 0;
  for (const chapter of localChapters) {
    const saved = state.chapters?.[String(chapter.chapterNumber)];
    if (!saved?.remoteChapterId) break;
    if (normalizeChapterTitle(saved.title) !== normalizeChapterTitle(chapter.title)) {
      throw new Error(`第 ${chapter.chapterNumber} 章本地发布状态标题与正文标题不一致，已停止以避免错传`);
    }
    count = chapter.chapterNumber;
  }
  return count;
}

function remoteSafetyReport(remote) {
  const errors = remote
    .filter((chapter) => /草稿|保存失败|提交失败/u.test(chapter.status || ''))
    .map((chapter) => ({
      code: 'unsafe_remote_status', chapterNumber: chapter.chapterNumber,
      detail: `远端状态“${chapter.status}”不能当作已确认章节`,
    }));
  return { ok: errors.length === 0, errors };
}

async function localBookOverview(projectRoot, bookName, assignments) {
  const loaded = await loadFanqieBook(projectRoot, bookName);
  const state = await loadFanqieState(projectRoot, loaded.book.name, loaded.binding);
  const quality = buildFanqieQualityReport(loaded.chapters, loaded.binding);
  return {
    loaded,
    state,
    output: {
      book: loaded.book.name,
      accountRef: loaded.binding.accountRef,
      account: loaded.binding.accountLabel,
      cdpUrl: loaded.binding.cdpUrl,
      workId: loaded.binding.workId,
      workTitle: loaded.binding.workTitle,
      localChapterCount: loaded.chapters.length,
      quality,
      state: summarizeFanqieState(state.state),
      accountAssignmentOk: assignments.ok,
    },
  };
}

export async function getFanqieLocalStatus(projectRoot, requestedBook = '') {
  const books = requestedBook ? [requestedBook] : await listBoundFanqieBooks(projectRoot);
  const assignments = await inspectFanqieAccountAssignments(projectRoot);
  const registry = await loadFanqieAccountRegistry(projectRoot);
  const lock = await inspectFanqieLock(projectRoot);
  const results = [];
  for (const book of books) {
    try {
      results.push((await localBookOverview(projectRoot, book, assignments)).output);
    } catch (error) {
      results.push({ book, error: error.message });
    }
  }
  const accounts = Object.entries(registry.accounts).map(([ref, account]) => {
    const profileDir = account.profileDir || '';
    const profileName = account.profileName || 'Default';
    const defaultDir = profileDir ? path.join(profileDir, profileName) : '';
    const initialized = Boolean(
      profileDir && defaultDir && fssync.existsSync(defaultDir)
      && fssync.existsSync(path.join(profileDir, 'Local State'))
      && fssync.existsSync(path.join(defaultDir, 'Preferences')),
    );
    const cookieStoreExists = Boolean(
      defaultDir && (fssync.existsSync(path.join(defaultDir, 'Network', 'Cookies')) || fssync.existsSync(path.join(defaultDir, 'Cookies'))),
    );
    return {
      ref,
      label: account.label || ref,
      publishingEnabled: account.publishingEnabled !== false && account.status !== 'unavailable',
      status: account.status || 'active',
      sourceAccountId: account.sourceAccountId || null,
      shortcutPath: account.shortcutPath || null,
      shortcutExists: Boolean(account.shortcutPath && fssync.existsSync(account.shortcutPath)),
      profileDir: profileDir || null,
      profileExists: Boolean(profileDir && fssync.existsSync(profileDir)),
      initialized,
      cookieStoreExists,
      loginVerified: false,
      cdpPort: Number(account.cdpPort || 9333),
    };
  });
  return {
    ok: assignments.ok && accounts.every((item) => item.profileExists && (!item.shortcutPath || item.shortcutExists)) && results.every((item) => !item.error && item.quality?.ok),
    mode: 'local',
    accountRegistry: {
      file: registry.file,
      count: accounts.length,
      initializedCount: accounts.filter((item) => item.initialized).length,
      cookieStoreCount: accounts.filter((item) => item.cookieStoreExists).length,
      accounts,
    },
    assignments,
    lock,
    books: results,
  };
}

export async function inspectFanqieBook(projectRoot, options = {}) {
  const bookName = await resolveFanqieBookName(projectRoot, options.book);
  const assignments = await inspectFanqieAccountAssignments(projectRoot);
  const loaded = await loadFanqieBook(projectRoot, bookName);
  const quality = buildFanqieQualityReport(loaded.chapters, loaded.binding);
  const connection = await connectFanqieBrowser(loaded.binding);
  try {
    const remote = await inspectFanqieRemoteChapters(connection.page, loaded.binding);
    const state = await loadFanqieState(projectRoot, loaded.book.name, loaded.binding);
    const knownRemoteCount = durableRemotePrefix(loaded.chapters, state.state);
    const plan = createFanqieUploadPlan(loaded.chapters, remote, {
      from: options.from,
      to: options.to,
      minimumRemoteCount: loaded.binding.schedule.firstChapter - 1,
      knownRemoteCount,
    });
    const schedule = buildFanqieScheduleReport(plan, loaded.binding, { now: options.now });
    const remoteSafety = remoteSafetyReport(remote);
    const preflight = {
      ok: assignments.ok && quality.ok && schedule.ok && remoteSafety.ok,
      accountAssignments: assignments,
      quality,
      schedule,
      remoteSafety,
    };
    return { loaded, connection, remote, plan, state, knownRemoteCount, preflight };
  } catch (error) {
    await captureFanqieFailure(connection.page, projectRoot, loaded.binding, null, error).catch(() => {});
    await connection.page.close().catch(() => {});
    throw error;
  }
}

export function fanqieRemoteOverview(inspection, mode = 'preview') {
  const { loaded, remote, plan, state, knownRemoteCount = 0, preflight } = inspection;
  return {
    ok: preflight.ok,
    mode,
    book: loaded.book.name,
    accountRef: loaded.binding.accountRef,
    account: loaded.binding.accountLabel,
    workId: loaded.binding.workId,
    workTitle: loaded.binding.workTitle,
    localChapterCount: loaded.chapters.length,
    remoteChapterCount: remote.length,
    knownRemoteCount,
    remoteStatuses: remoteStatusSummary(remote),
    nextChapter: Math.max(remote.length, knownRemoteCount) + 1,
    pendingCount: plan.length,
    plan: planSummary(plan, loaded.binding),
    preflight,
    state: summarizeFanqieState(state.state),
  };
}

export async function runFanqieRemoteStatus(projectRoot, options = {}) {
  const inspection = await inspectFanqieBook(projectRoot, options);
  try {
    return fanqieRemoteOverview(inspection, 'preview');
  } finally {
    await inspection.connection.page.close().catch(() => {});
  }
}

export async function runFanqieMarketing(projectRoot, options = {}) {
  const bookName = await resolveFanqieBookName(projectRoot, options.book);
  const loaded = await loadFanqieBook(projectRoot, bookName);
  const config = await loadFanqieMarketingConfig(projectRoot);
  const entry = findFanqieMarketingEntry(config, { book: loaded.book.name, workId: loaded.binding.workId });
  if (entry.accountRef !== loaded.binding.accountRef || entry.workTitle !== loaded.binding.workTitle) {
    throw new Error('营销配置与书籍番茄绑定不一致，已停止以避免修改错误账号或作品');
  }
  const plan = {
    book: entry.localBook,
    accountRef: entry.accountRef,
    workId: entry.workId,
    workTitle: entry.workTitle,
    cover: entry.coverPath,
    protagonists: entry.protagonists,
    mainCategory: entry.mainCategory,
    tags: entry.tags,
    introChars: [...entry.intro].length,
  };
  if (!options.apply) return { ok: true, mode: 'preview', plan };
  const assignments = await inspectFanqieAccountAssignments(projectRoot);
  if (!assignments.ok) throw new Error('番茄账号分配检查未通过，已停止作品资料修改');
  const lock = await acquireFanqieLock(projectRoot, loaded.book.name, loaded.binding.accountRef);
  let connection;
  try {
    connection = await connectFanqieBrowser(loaded.binding);
    await appendFanqieLog(projectRoot, {
      event: 'marketing-start', book: loaded.book.name, accountRef: loaded.binding.accountRef, workId: loaded.binding.workId,
    });
    const remote = await updateFanqieBookMarketing(connection.page, loaded.binding, entry, {
      onReady: async (page) => {
        const evidenceDir = path.join(projectRoot, '书籍', '.state', 'fanqie', loaded.binding.workId, 'marketing');
        await fs.mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: path.join(evidenceDir, 'ready.png'), fullPage: true });
      },
    });
    const local = await syncFanqieMarketingFiles(projectRoot, { config, book: loaded.book.name });
    await appendFanqieLog(projectRoot, {
      event: 'marketing-complete', book: loaded.book.name, workId: loaded.binding.workId, status: remote.status,
    });
    return { ok: true, mode: 'apply', plan, remote, local };
  } catch (error) {
    if (connection?.page) await captureFanqieFailure(connection.page, projectRoot, loaded.binding, null, error).catch(() => {});
    await appendFanqieLog(projectRoot, {
      event: 'marketing-failed', book: loaded.book.name, workId: loaded.binding.workId, error: error.message,
    }).catch(() => {});
    throw error;
  } finally {
    await connection?.page?.close().catch(() => {});
    await lock.release();
  }
}

export async function runFanqieUpload(projectRoot, options = {}) {
  if (!options.apply) return runFanqieRemoteStatus(projectRoot, options);
  const bookName = await resolveFanqieBookName(projectRoot, options.book);
  const lockTarget = await loadFanqieBook(projectRoot, bookName);
  const lock = await acquireFanqieLock(projectRoot, bookName, lockTarget.binding.accountRef);
  let inspection;
  try {
    inspection = await inspectFanqieBook(projectRoot, options);
    const overview = fanqieRemoteOverview(inspection, 'apply');
    if (!inspection.preflight.ok) throw new Error('番茄发布前检查未通过；请先查看 preflight.errors/warnings 并修复');
    if (!inspection.plan.length) return { ...overview, uploaded: [] };
    await recordFanqiePlan(
      projectRoot,
      inspection.loaded.book.name,
      inspection.loaded.binding,
      inspection.plan,
      inspection.preflight.schedule.entries.map(({ date, time }) => ({ date, time })),
    );
    await appendFanqieLog(projectRoot, {
      event: 'start', book: inspection.loaded.book.name, workId: inspection.loaded.binding.workId,
      from: inspection.plan[0].chapterNumber, to: inspection.plan.at(-1).chapterNumber,
    });
    const uploaded = await uploadFanqiePlan(inspection.connection.page, inspection.loaded.binding, inspection.plan, {
      onPhase: async (chapter, phase, fields) => {
        await recordFanqieChapterPhase(projectRoot, inspection.loaded.book.name, inspection.loaded.binding, chapter, phase, fields);
      },
      onProgress: async (result) => {
        await appendFanqieLog(projectRoot, { event: 'published', book: inspection.loaded.book.name, ...result });
        options.onProgress?.(result);
      },
      onFailure: async (chapter, error) => {
        const evidence = await captureFanqieFailure(inspection.connection.page, projectRoot, inspection.loaded.binding, chapter, error);
        await recordFanqieChapterPhase(projectRoot, inspection.loaded.book.name, inspection.loaded.binding, chapter, 'failed', {
          error: error.message, evidence,
        });
      },
    });
    await appendFanqieLog(projectRoot, { event: 'complete', book: inspection.loaded.book.name, uploaded: uploaded.length });
    const refreshedState = await loadFanqieState(projectRoot, inspection.loaded.book.name, inspection.loaded.binding);
    return { ...overview, uploaded, state: summarizeFanqieState(refreshedState.state) };
  } catch (error) {
    await appendFanqieLog(projectRoot, { event: 'failed', book: inspection?.loaded?.book?.name || bookName, error: error.message }).catch(() => {});
    throw error;
  } finally {
    await inspection?.connection?.page?.close().catch(() => {});
    await lock.release();
  }
}

export async function runFanqieReconcile(projectRoot, options = {}) {
  const bookName = await resolveFanqieBookName(projectRoot, options.book);
  const lockTarget = options.apply ? await loadFanqieBook(projectRoot, bookName) : null;
  const lock = options.apply
    ? await acquireFanqieLock(projectRoot, bookName, lockTarget.binding.accountRef)
    : null;
  let inspection;
  try {
    inspection = await inspectFanqieBook(projectRoot, options);
    const reconcile = buildFanqieReconcile(inspection.loaded.chapters, inspection.remote, inspection.state.state);
    let state = inspection.state.state;
    if (options.apply && reconcile.changes.length) {
      state = await applyFanqieReconcile(inspection.state.file, inspection.state.state, reconcile);
      await appendFanqieLog(projectRoot, { event: 'reconcile', book: bookName, changes: reconcile.changes.length });
    }
    return {
      ok: reconcile.ok,
      mode: options.apply ? 'apply' : 'preview',
      book: bookName,
      workId: inspection.loaded.binding.workId,
      remoteChapterCount: inspection.remote.length,
      state: summarizeFanqieState(state),
      reconcile,
    };
  } finally {
    await inspection?.connection?.page?.close().catch(() => {});
    await lock?.release();
  }
}
