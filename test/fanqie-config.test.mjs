import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildFanqieQualityReport,
  buildFanqieScheduleReport,
  calculateFanqiePublishAt,
  createFanqieUploadPlan,
  discoverFanqieChapters,
  inspectFanqieAccountAssignments,
  normalizeFanqieBinding,
  normalizeChapterTitle,
  resolveFanqieBinding,
} from '../lib/fanqie-config.mjs';
import { parseShortcutArguments } from '../scripts/bind-fanqie.mjs';
import { acquireFanqieLock, appendFanqieLog } from '../lib/fanqie-lock.mjs';

const schedule = { firstChapter: 5, firstDate: '2026-07-19', chaptersPerDay: 4, time: '00:00' };

test('normalizes a per-book Fanqie binding', () => {
  const value = normalizeFanqieBinding({
    profileDir: 'C:\\Profiles\\fanqie-01',
    workId: '7663866009652055065',
    workTitle: '快穿：反派的满级学习系统',
    aiUsed: true,
    schedule,
  });
  assert.equal(value.cdpUrl, 'http://127.0.0.1:9333');
  assert.equal(value.sourceDir, '正文');
  assert.equal(value.aiUsed, true);
  assert.throws(() => normalizeFanqieBinding({
    profileDir: 'relative-profile', workId: '1', workTitle: '书名', aiUsed: false, schedule,
  }), /必须是绝对路径/);
  assert.throws(() => normalizeFanqieBinding({
    schemaVersion: 99, profileDir: 'C:\\Profiles\\one', workId: '1', workTitle: '书名', aiUsed: false, schedule,
  }), /版本不受支持/);
});

test('calculates four chapters per publishing day', () => {
  assert.deepEqual(calculateFanqiePublishAt(5, schedule), { date: '2026-07-19', time: '00:00' });
  assert.deepEqual(calculateFanqiePublishAt(57, schedule), { date: '2026-08-01', time: '00:00' });
  assert.deepEqual(calculateFanqiePublishAt(61, schedule), { date: '2026-08-02', time: '00:00' });
});

test('spreads four daily chapters across configured time slots', () => {
  const staggered = { ...schedule, times: ['08:00', '12:00', '18:00', '21:00'] };
  assert.deepEqual(calculateFanqiePublishAt(5, staggered), { date: '2026-07-19', time: '08:00' });
  assert.deepEqual(calculateFanqiePublishAt(8, staggered), { date: '2026-07-19', time: '21:00' });
  assert.deepEqual(calculateFanqiePublishAt(9, staggered), { date: '2026-07-20', time: '08:00' });
});

test('discovers continuous chapter files and strips the numbered title prefix', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fanqie-book-'));
  try {
    const source = path.join(root, '正文');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, '0001.md'), '第一章第一天\n\n正文一', 'utf8');
    await fs.writeFile(path.join(source, '0002.md'), '第2章 第二天\n\n正文二', 'utf8');
    const chapters = await discoverFanqieChapters(root, { sourceDir: '正文' });
    assert.deepEqual(chapters.map(({ chapterNumber, title }) => ({ chapterNumber, title })), [
      { chapterNumber: 1, title: '第一天' },
      { chapterNumber: 2, title: '第二天' },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('upload planning refuses mismatches, gaps, and missing scheduled predecessors', () => {
  const local = [1, 2, 3, 4, 5].map((chapterNumber) => ({ chapterNumber, title: `标题${chapterNumber}` }));
  assert.throws(() => createFanqieUploadPlan(local, [{ title: '别的标题' }]), /标题不一致/);
  assert.throws(() => createFanqieUploadPlan(local, [], { from: 2 }), /不能跳过/);
  assert.throws(() => createFanqieUploadPlan(local, local.slice(0, 3), { minimumRemoteCount: 4 }), /排期从第 5 章开始/);
  assert.deepEqual(createFanqieUploadPlan(local, local.slice(0, 4), { minimumRemoteCount: 4 }).map((item) => item.chapterNumber), [5]);
  assert.deepEqual(createFanqieUploadPlan(local, [], { knownRemoteCount: 1 }).map((item) => item.chapterNumber), [2, 3, 4, 5]);
  assert.deepEqual(createFanqieUploadPlan(local, local), []);
  assert.throws(() => createFanqieUploadPlan(local, [], { knownRemoteCount: 6 }), /有效的本地章节前缀/);
  assert.equal(normalizeChapterTitle('第 5 章 标题5'), '标题5');
  assert.equal(normalizeChapterTitle('第一十章自闭天才少年（一十）'), '自闭天才少年（一十）');
});

test('parses Chrome profile arguments from a shortcut', () => {
  assert.deepEqual(parseShortcutArguments('--user-data-dir="C:\\Profiles\\fanqie-01" --profile-directory=Default'), {
    profileDir: 'C:\\Profiles\\fanqie-01',
    profileName: 'Default',
  });
});

test('quality and schedule gates block invalid content before publishing', () => {
  const binding = normalizeFanqieBinding({
    profileDir: 'C:\\Profiles\\fanqie-01', workId: '1', workTitle: '书名', aiUsed: false,
    schedule, quality: { minBodyChars: 5, maxBodyChars: 20, maxTitleChars: 4, minimumLeadMinutes: 15 },
  });
  const chapters = [
    { chapterNumber: 5, title: '重复标题过长', originalTitle: '# 重复标题过长', body: '作为AI，这是内容', nonWhitespaceLength: 9, file: '0005.md' },
    { chapterNumber: 6, title: '重复标题过长', originalTitle: '重复标题过长', body: '短', nonWhitespaceLength: 1, file: '0006.md' },
  ];
  const quality = buildFanqieQualityReport(chapters, binding);
  assert.equal(quality.ok, false);
  assert.equal(quality.errors.some((item) => item.code === 'duplicate_title'), true);
  assert.equal(quality.warnings.some((item) => item.code === 'suspected_ai_artifact'), true);
  const scheduleReport = buildFanqieScheduleReport([chapters[0]], binding, { now: '2026-07-19T00:00:00+08:00' });
  assert.equal(scheduleReport.ok, false);
});

test('account registry resolves local profiles and reports port collisions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fanqie-accounts-'));
  try {
    await fs.mkdir(path.join(root, 'config', 'local'), { recursive: true });
    await fs.mkdir(path.join(root, 'config', 'books'), { recursive: true });
    await fs.writeFile(path.join(root, 'config', 'local', 'fanqie-accounts.json'), JSON.stringify({
      schemaVersion: 1,
      accounts: {
        one: { label: '账号一', profileDir: 'C:\\Profiles\\one', profileName: 'Default', cdpPort: 9333 },
        two: { label: '账号二', profileDir: 'C:\\Profiles\\two', profileName: 'Default', cdpPort: 9333 },
      },
    }), 'utf8');
    const base = { enabled: true, workId: '1', workTitle: '书', aiUsed: false, schedule };
    await fs.writeFile(path.join(root, 'config', 'books', '001.json'), JSON.stringify({ name: '书一', fanqie: { ...base, accountRef: 'one' } }), 'utf8');
    await fs.writeFile(path.join(root, 'config', 'books', '002.json'), JSON.stringify({ name: '书二', fanqie: { ...base, workId: '2', accountRef: 'two' } }), 'utf8');
    const resolved = await resolveFanqieBinding(root, { ...base, accountRef: 'one' });
    assert.equal(resolved.profileDir, 'C:\\Profiles\\one');
    const assignments = await inspectFanqieAccountAssignments(root);
    assert.equal(assignments.ok, false);
    assert.equal(assignments.errors[0].code, 'cdp_port_collision');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Fanqie publishing lock prevents concurrent upload and releases only its own lock', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fanqie-lock-'));
  try {
    const lock = await acquireFanqieLock(root, '测试书');
    await assert.rejects(() => acquireFanqieLock(root, '另一本书'), /已有番茄发布任务占用锁/);
    await lock.release();
    const next = await acquireFanqieLock(root, '另一本书');
    await next.release();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Fanqie JSONL log rotates at a bounded size', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fanqie-log-'));
  try {
    await appendFanqieLog(root, { event: 'one', text: 'x'.repeat(100) }, { maxBytes: 1, rotations: 2 });
    await appendFanqieLog(root, { event: 'two' }, { maxBytes: 1, rotations: 2 });
    const dir = path.join(root, '书籍', '.state', 'fanqie');
    assert.equal((await fs.readFile(path.join(dir, 'run.log.1'), 'utf8')).includes('"event":"one"'), true);
    assert.equal((await fs.readFile(path.join(dir, 'run.log'), 'utf8')).includes('"event":"two"'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
