import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  alignCampaignAccounts,
  bootstrapCampaign,
  campaignCycles,
  campaignStatus,
  decideCampaignLane,
  enrollCampaignBook,
  loadCampaignState,
  recordCampaignMetrics,
  splitNovelText,
} from '../lib/campaign.mjs';
import { runCampaignTick } from '../campaign-control.mjs';

const campaignConfig = {
  schemaVersion: 1,
  name: '测试投放',
  timeZone: 'Asia/Shanghai',
  laneCount: 6,
  initialChapters: 60,
  continuationChapters: 60,
  cycleStartDays: [1, 11, 21],
  stageLabels: { chai: '拆改编', xie: '写' },
  accountPolicy: { oneActiveBookPerAccount: true, preferInitializedProfiles: true },
  performance: {
    mode: 'manual', requiredMetrics: ['readers', 'readThroughRate'],
    thresholds: { readers: null, readThroughRate: null, followers: null, revenueCny: null }, minimumPasses: 2,
  },
};

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xxs-campaign-'));
  await fs.mkdir(path.join(root, 'config', 'books'), { recursive: true });
  await fs.mkdir(path.join(root, 'config', 'local'), { recursive: true });
  await fs.writeFile(path.join(root, 'config', 'campaign.json'), JSON.stringify(campaignConfig));
  const accounts = {};
  for (let number = 1; number <= 6; number++) {
    const profileDir = path.join(root, 'profiles', `fanqie-${String(number).padStart(2, '0')}`);
    await fs.mkdir(path.join(profileDir, 'Default', 'Network'), { recursive: true });
    await fs.writeFile(path.join(profileDir, 'Local State'), '{}');
    await fs.writeFile(path.join(profileDir, 'Default', 'Preferences'), '{}');
    await fs.writeFile(path.join(profileDir, 'Default', 'Network', 'Cookies'), '');
    accounts[`account-${number}`] = { label: `账号${number}`, sourceAccountId: `fanqie-${String(number).padStart(2, '0')}`, profileDir, profileName: 'Default', cdpPort: 9400 + number };
  }
  await fs.writeFile(path.join(root, 'config', 'local', 'fanqie-accounts.json'), JSON.stringify({ schemaVersion: 1, accounts }));
  for (let number = 1; number <= 6; number++) {
    const name = `测试书${number}`;
    const bookDir = path.join(root, '书籍', name);
    for (const sub of ['原文', '拆分', '正文']) await fs.mkdir(path.join(bookDir, sub), { recursive: true });
    for (let chapter = 1; chapter <= (number === 1 ? 120 : 60); chapter++) {
      await fs.writeFile(path.join(bookDir, '原文', `${String(chapter).padStart(4, '0')}.txt`), `第${chapter}章 标题\n正文`);
      if (chapter <= 60) {
        await fs.writeFile(path.join(bookDir, '拆分', `${String(chapter).padStart(4, '0')}.md`), '拆改编');
        await fs.writeFile(path.join(bookDir, '正文', `${String(chapter).padStart(4, '0')}.md`), `第${chapter}章 标题\n正文内容`);
      }
    }
    await fs.writeFile(path.join(root, 'config', 'books', `${String(number).padStart(3, '0')}.json`), JSON.stringify({
      name, enabled: true,
      stages: { chai: { enabled: true, chapterRange: { start: 1, end: 60 } }, xie: { enabled: true, chapterRange: { start: 1, end: 60 } } },
      ...(number === 1 ? { fanqie: { enabled: true, accountRef: 'account-1', workId: '10001', workTitle: name } } : {}),
    }));
  }
  return root;
}

test('campaign calendar has three ten-day decision points and splitter preserves titles', () => {
  const cycles = campaignCycles('2026-07', campaignConfig);
  assert.deepEqual(cycles.map((item) => [item.startDate, item.evaluateOn]), [
    ['2026-07-01', '2026-07-11'], ['2026-07-11', '2026-07-21'], ['2026-07-21', '2026-08-01'],
  ]);
  const chapters = splitNovelText('简介\n第1章第一章\n正文一\n第2章 第二章\n正文二');
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, '第1章第一章');
  assert.match(chapters[1].text, /^第2章 第二章\n/u);
});

test('bootstrap assigns six unique initialized accounts and derives pipeline gates', async () => {
  const root = await makeFixture();
  try {
    const result = await bootstrapCampaign(root, { month: '2026-07', cycle: 2, apply: true });
    assert.equal(result.state.activeCycle.id, '2026-07-C2');
    assert.equal(new Set(Object.values(result.state.lanes).map((lane) => lane.accountRef)).size, 6);
    assert.equal(result.state.lanes['1'].accountRef, 'account-1');
    const status = await campaignStatus(root, { today: '2026-07-19' });
    assert.equal(status.lanes[0].phase, 'ready_to_publish');
    assert.equal(status.lanes.slice(1).every((lane) => lane.phase === 'awaiting_fanqie_binding'), true);
    assert.equal(status.lanes.every((lane) => lane.pipeline.xie.complete), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('campaign account alignment previews and repairs lane bindings from book configs', async () => {
  const root = await makeFixture();
  try {
    await bootstrapCampaign(root, { month: '2026-07', cycle: 2, apply: true });
    const bookFile = path.join(root, 'config', 'books', '002.json');
    const book = JSON.parse(await fs.readFile(bookFile, 'utf8'));
    book.fanqie = { enabled: true, accountRef: 'account-2', workId: '10002', workTitle: book.name };
    await fs.writeFile(bookFile, JSON.stringify(book));
    const stateFile = path.join(root, '书籍', '.state', 'campaign', 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.lanes['2'].accountRef = 'account-6';
    await fs.writeFile(stateFile, JSON.stringify(state));
    const preview = await alignCampaignAccounts(root, {});
    assert.deepEqual(preview.changes, [{ lane: 2, book: '测试书2', from: 'account-6', to: 'account-2' }]);
    assert.equal((await loadCampaignState(root)).state.lanes['2'].accountRef, 'account-6');
    await alignCampaignAccounts(root, { apply: true });
    assert.equal((await loadCampaignState(root)).state.lanes['2'].accountRef, 'account-2');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('campaign tick previews the highest-priority safe stage without launching it', async () => {
  const root = await makeFixture();
  try {
    await bootstrapCampaign(root, { month: '2026-07', cycle: 2, apply: true });
    await fs.rm(path.join(root, '书籍', '测试书2', '拆分', '0060.md'));
    const tick = await runCampaignTick(root, {});
    assert.equal(tick.action, 'start_chai');
    assert.deepEqual(tick.books, ['测试书2']);
    assert.equal(tick.applied, false);
    assert.equal(tick.args.includes('--apply'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('continue decision extends the same book target by sixty chapters', async () => {
  const root = await makeFixture();
  try {
    await bootstrapCampaign(root, { month: '2026-07', cycle: 2, apply: true });
    await recordCampaignMetrics(root, { lane: 1, readers: 1000, readThroughRate: 35, apply: true });
    const preview = await decideCampaignLane(root, { lane: 1, decision: 'continue', reason: '数据达标', today: '2026-07-21' });
    assert.equal(preview.nextTargetChapters, 120);
    await decideCampaignLane(root, { lane: 1, decision: 'continue', reason: '数据达标', today: '2026-07-21', apply: true });
    const state = (await loadCampaignState(root)).state;
    assert.equal(state.lanes['1'].current.targetChapters, 120);
    assert.equal(state.lanes['1'].current.cycle.id, '2026-07-C3');
    const config = JSON.parse(await fs.readFile(path.join(root, 'config', 'books', '001.json'), 'utf8'));
    assert.equal(config.stages.chai.chapterRange.end, 120);
    assert.equal(config.stages.xie.chapterRange.end, 120);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('replace releases a lane and enrolls a material novel into the pending cycle', async () => {
  const root = await makeFixture();
  try {
    const library = path.join(root, 'library');
    await fs.mkdir(library, { recursive: true });
    const novel = Array.from({ length: 70 }, (_, index) => `第${index + 1}章 新章${index + 1}\n这是第${index + 1}章正文`).join('\n');
    await fs.writeFile(path.join(library, 'new.txt'), novel);
    await fs.writeFile(path.join(root, 'config', 'local', 'material-sources.json'), JSON.stringify({ schemaVersion: 1, sources: { main: { root: library, mode: 'read-only', extensions: ['.txt'] } } }));
    await bootstrapCampaign(root, { month: '2026-07', cycle: 2, apply: true });
    await recordCampaignMetrics(root, { lane: 2, readers: 10, readThroughRate: 1, apply: true });
    await decideCampaignLane(root, { lane: 2, decision: 'replace', reason: '数据未达标', today: '2026-07-21', apply: true });
    let state = (await loadCampaignState(root)).state;
    assert.equal(state.lanes['2'].current, null);
    assert.equal(state.lanes['2'].pendingCycle.id, '2026-07-C3');
    const enrolled = await enrollCampaignBook(root, { lane: 2, sourceId: 'main', relativePath: 'new.txt', book: '素材新书', apply: true });
    assert.equal(enrolled.detectedChapters, 70);
    state = (await loadCampaignState(root)).state;
    assert.equal(state.lanes['2'].current.cycle.id, '2026-07-C3');
    assert.equal(state.lanes['2'].accountRef, 'account-2');
    assert.equal((await fs.readdir(path.join(root, '书籍', '素材新书', '原文'))).length, 60);
    const oldConfig = JSON.parse(await fs.readFile(path.join(root, 'config', 'books', '002.json'), 'utf8'));
    assert.equal(oldConfig.enabled, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
