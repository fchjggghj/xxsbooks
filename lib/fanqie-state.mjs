import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_VERSION = 1;
const PHASES = new Set(['planned', 'editing', 'submitting', 'submitted', 'confirmed', 'failed']);

export function fanqieWorkStateDir(projectRoot, binding) {
  return path.join(path.resolve(projectRoot), '书籍', '.state', 'fanqie', binding.workId);
}

export function fanqieWorkStateFile(projectRoot, binding) {
  return path.join(fanqieWorkStateDir(projectRoot, binding), 'state.json');
}

function emptyState(bookName, binding) {
  return {
    version: STATE_VERSION,
    book: bookName,
    workId: binding.workId,
    workTitle: binding.workTitle,
    updatedAt: null,
    chapters: {},
  };
}

export async function loadFanqieState(projectRoot, bookName, binding) {
  const file = fanqieWorkStateFile(projectRoot, binding);
  let state;
  try {
    state = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return { file, state: emptyState(bookName, binding), exists: false };
    throw error;
  }
  if (state.version !== STATE_VERSION) throw new Error(`不支持的番茄发布状态版本: ${state.version}`);
  if (state.workId !== binding.workId || state.book !== bookName) {
    throw new Error(`番茄发布状态归属不匹配: ${file}`);
  }
  return { file, state, exists: true };
}

export async function saveFanqieState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await fs.rename(temp, file);
      return next;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 5) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
  await fs.rm(temp, { force: true }).catch(() => {});
  throw lastError;
}

export async function recordFanqieChapterPhase(projectRoot, bookName, binding, chapter, phase, fields = {}) {
  if (!PHASES.has(phase)) throw new Error(`未知番茄发布阶段: ${phase}`);
  const loaded = await loadFanqieState(projectRoot, bookName, binding);
  const key = String(chapter.chapterNumber);
  const previous = loaded.state.chapters[key] || {};
  const eventAt = new Date().toISOString();
  const nextChapter = {
    ...previous,
    chapterNumber: chapter.chapterNumber,
    title: chapter.title,
    file: chapter.file || previous.file || '',
    phase,
    ...fields,
    lastEventAt: eventAt,
    history: [...(previous.history || []), { phase, at: eventAt, ...fields }].slice(-20),
  };
  const state = {
    ...loaded.state,
    chapters: { ...loaded.state.chapters, [key]: nextChapter },
  };
  return saveFanqieState(loaded.file, state);
}

export async function recordFanqiePlan(projectRoot, bookName, binding, chapters, publishEntries) {
  let loaded = await loadFanqieState(projectRoot, bookName, binding);
  const chaptersState = { ...loaded.state.chapters };
  for (let index = 0; index < chapters.length; index++) {
    const chapter = chapters[index];
    const key = String(chapter.chapterNumber);
    if (chaptersState[key]?.phase === 'confirmed') continue;
    const eventAt = new Date().toISOString();
    const publishAt = publishEntries[index];
    chaptersState[key] = {
      ...(chaptersState[key] || {}), chapterNumber: chapter.chapterNumber, title: chapter.title,
      file: chapter.file, phase: 'planned', publishAt, lastEventAt: eventAt,
      history: [...(chaptersState[key]?.history || []), { phase: 'planned', at: eventAt, publishAt }].slice(-20),
    };
  }
  return saveFanqieState(loaded.file, { ...loaded.state, chapters: chaptersState });
}

export function summarizeFanqieState(state) {
  const values = Object.values(state.chapters || {});
  const phases = {};
  for (const item of values) phases[item.phase] = (phases[item.phase] || 0) + 1;
  return { exists: values.length > 0, chapterCount: values.length, phases, updatedAt: state.updatedAt };
}

export function buildFanqieReconcile(localChapters, remoteChapters, state) {
  const changes = [];
  const issues = [];
  for (const remote of remoteChapters) {
    const chapter = localChapters[remote.chapterNumber - 1];
    if (!chapter) {
      issues.push({ code: 'remote_without_local', chapterNumber: remote.chapterNumber, detail: '远端章节没有对应本地正文' });
      continue;
    }
    if (/草稿|保存失败|提交失败/u.test(remote.status || '')) {
      issues.push({ code: 'unsafe_remote_status', chapterNumber: remote.chapterNumber, detail: `远端状态“${remote.status}”需要人工处理` });
      continue;
    }
    const current = state.chapters?.[String(remote.chapterNumber)] || null;
    if (current?.title && current.title !== chapter.title) {
      issues.push({ code: 'state_title_mismatch', chapterNumber: remote.chapterNumber, detail: `状态标题“${current.title}”与本地“${chapter.title}”不一致` });
      continue;
    }
    const desired = {
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      file: chapter.file,
      phase: 'confirmed',
      remoteChapterId: remote.remoteChapterId || current?.remoteChapterId || '',
      remoteStatus: remote.status || '',
      remotePublishAt: remote.publishAt || '',
    };
    if (!current || current.phase !== 'confirmed' || current.remoteChapterId !== desired.remoteChapterId || current.remoteStatus !== desired.remoteStatus || current.remotePublishAt !== desired.remotePublishAt) {
      changes.push({ chapterNumber: chapter.chapterNumber, before: current, after: desired, reason: current ? 'refresh_remote_confirmation' : 'backfill_remote_confirmation' });
    }
  }
  for (const current of Object.values(state.chapters || {})) {
    if (current.chapterNumber <= remoteChapters.length) continue;
    if (['submitting', 'submitted', 'confirmed'].includes(current.phase)) {
      issues.push({
        code: current.phase === 'confirmed' ? 'confirmed_missing_remote' : 'uncertain_submission',
        chapterNumber: current.chapterNumber,
        detail: `本地状态为 ${current.phase}，但远端列表没有该章，需要人工核对`,
      });
    }
  }
  return { ok: issues.length === 0, changes, issues };
}

export async function applyFanqieReconcile(file, state, reconcile) {
  if (reconcile.issues.length) throw new Error('存在需要人工核对的番茄状态问题，拒绝自动应用 reconcile');
  const chapters = { ...(state.chapters || {}) };
  for (const change of reconcile.changes) {
    const previous = chapters[String(change.chapterNumber)] || {};
    const eventAt = new Date().toISOString();
    chapters[String(change.chapterNumber)] = {
      ...previous, ...change.after, lastEventAt: eventAt,
      history: [...(previous.history || []), { phase: 'confirmed', at: eventAt, reason: change.reason }].slice(-20),
    };
  }
  return saveFanqieState(file, { ...state, chapters });
}
