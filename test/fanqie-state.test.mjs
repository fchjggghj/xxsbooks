import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureFanqieFailure } from '../lib/fanqie-evidence.mjs';
import {
  applyFanqieReconcile,
  buildFanqieReconcile,
  loadFanqieState,
  recordFanqieChapterPhase,
  recordFanqiePlan,
} from '../lib/fanqie-state.mjs';

const binding = { workId: '123456789', workTitle: '测试作品' };
const chapters = [
  { chapterNumber: 1, title: '第一章', file: '0001.md' },
  { chapterNumber: 2, title: '第二章', file: '0002.md' },
];

test('durable Fanqie journal records plan and submission phases', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fanqie-state-'));
  try {
    await recordFanqiePlan(root, '测试书', binding, chapters, [
      { date: '2026-08-01', time: '00:00' }, { date: '2026-08-01', time: '00:00' },
    ]);
    await recordFanqieChapterPhase(root, '测试书', binding, chapters[0], 'submitting', { publishAt: { date: '2026-08-01', time: '00:00' } });
    await recordFanqieChapterPhase(root, '测试书', binding, chapters[0], 'confirmed', { remoteChapterId: '900000001' });
    const loaded = await loadFanqieState(root, '测试书', binding);
    assert.equal(loaded.state.chapters['1'].phase, 'confirmed');
    assert.deepEqual(loaded.state.chapters['1'].history.map((item) => item.phase), ['planned', 'submitting', 'confirmed']);
    assert.equal(loaded.state.chapters['2'].phase, 'planned');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reconcile backfills remote confirmations and flags uncertain missing submissions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fanqie-reconcile-'));
  try {
    const loaded = await loadFanqieState(root, '测试书', binding);
    const remote = [{ chapterNumber: 1, title: '第一章', remoteChapterId: '900000001', status: '已发布', publishAt: '2026-08-01 00:00' }];
    const preview = buildFanqieReconcile(chapters, remote, loaded.state);
    assert.equal(preview.changes.length, 1);
    const state = await applyFanqieReconcile(loaded.file, loaded.state, preview);
    assert.equal(state.chapters['1'].phase, 'confirmed');
    await recordFanqieChapterPhase(root, '测试书', binding, chapters[1], 'submitted');
    const uncertain = await loadFanqieState(root, '测试书', binding);
    const next = buildFanqieReconcile(chapters, remote, uncertain.state);
    assert.equal(next.issues[0].code, 'uncertain_submission');
    await assert.rejects(() => applyFanqieReconcile(uncertain.file, uncertain.state, next), /拒绝自动应用/);
    const draft = buildFanqieReconcile(chapters, [{ ...remote[0], status: '草稿' }], loaded.state);
    assert.equal(draft.issues[0].code, 'unsafe_remote_status');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('failure evidence stores screenshot, html, and metadata without a live browser', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fanqie-evidence-'));
  try {
    const page = {
      screenshot: async ({ path: file }) => fs.writeFile(file, 'PNG', 'utf8'),
      content: async () => '<html><body>failure</body></html>',
      url: () => 'https://fanqienovel.com/failure',
    };
    const result = await captureFanqieFailure(page, root, binding, chapters[0], new Error('页面变化'));
    assert.equal((await fs.readFile(result.htmlFile, 'utf8')).includes('failure'), true);
    const metadata = JSON.parse(await fs.readFile(result.jsonFile, 'utf8'));
    assert.equal(metadata.error, '页面变化');
    assert.equal(metadata.chapterNumber, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
