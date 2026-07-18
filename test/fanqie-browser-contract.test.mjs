import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fanqieChapterManageUrl } from '../lib/fanqie-browser.mjs';
import { parseFanqieManagerFixture, validateFanqiePageContractHtml } from '../lib/fanqie-page-contract.mjs';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fanqie');

async function fixture(name) {
  return fs.readFile(path.join(fixtureDir, name), 'utf8');
}

test('offline Fanqie page fixtures satisfy the expected UI contracts', async () => {
  assert.deepEqual(validateFanqiePageContractHtml(await fixture('chapter-manager.html'), 'manager').missing, []);
  assert.deepEqual(validateFanqiePageContractHtml(await fixture('editor.html'), 'editor').missing, []);
  assert.deepEqual(validateFanqiePageContractHtml(await fixture('publish-settings.html'), 'publish').missing, []);
  assert.deepEqual(validateFanqiePageContractHtml('<html></html>', 'publish').missing, [
    'publish_settings', 'ai_disclosure', 'schedule', 'confirm_publish',
  ]);
});

test('chapter manager fixture extracts remote identity and status', async () => {
  const rows = parseFanqieManagerFixture(await fixture('chapter-manager.html'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].remoteChapterId, '900000000000000002');
  assert.equal(rows[0].status, '审核中');
  assert.equal(rows[1].title, '第1章 第一天');
});

test('chapter manager URL keeps the bound work identity', () => {
  const url = fanqieChapterManageUrl({ workId: '123', workTitle: '带 空格：书名' });
  assert.equal(url, 'https://fanqienovel.com/main/writer/chapter-manage/123&%E5%B8%A6%20%E7%A9%BA%E6%A0%BC%EF%BC%9A%E4%B9%A6%E5%90%8D?type=1');
});
