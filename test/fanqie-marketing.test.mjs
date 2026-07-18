import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  classifyFanqieMarketingSubmission,
  loadFanqieMarketingConfig,
  syncFanqieMarketingFiles,
} from '../lib/fanqie-marketing.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xxsbooks-marketing-'));
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.mkdir(path.join(root, '书籍', '测试书', '正文'), { recursive: true });
  await fs.mkdir(path.join(root, '书籍', '测试书', '封面'), { recursive: true });
  await fs.writeFile(path.join(root, '书籍', '测试书', '封面', 'cover.png'), 'png');
  const raw = {
    observedAt: '2026-07-19', benchmark: 'https://fanqienovel.com/rank/0_1_24', books: {
      '001': {
        localBook: '测试书', accountRef: 'account-01', workId: '12345678', workTitle: '测试作品', authorName: '测试作者',
        coverPath: '书籍/测试书/封面/cover.png', protagonists: ['姜浅予'], mainCategory: '快穿',
        tags: { 主题: ['幻想言情'], 角色: ['女强'], 情节: ['打脸'] }, intro: '【快穿】\n这是简介。',
      },
    },
  };
  await fs.writeFile(path.join(root, 'config', 'fanqie-marketing.json'), JSON.stringify(raw));
  return root;
}

test('营销配置同步封面与说明到正文目录', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = await loadFanqieMarketingConfig(root);
  const result = await syncFanqieMarketingFiles(root, { config });
  assert.equal(result.count, 1);
  assert.equal(await fs.readFile(path.join(root, '书籍', '测试书', '正文', '番茄封面.png'), 'utf8'), 'png');
  const info = await fs.readFile(path.join(root, '书籍', '测试书', '正文', '番茄书籍信息.md'), 'utf8');
  assert.match(info, /番茄书名：测试作品/u);
  assert.match(info, /主题：幻想言情/u);
  assert.match(info, /这是简介/u);
});
test('营销提交能区分已显示、审核锁定和不确定状态', async () => {
  const root = await fixture();
  try {
    const entry = Object.values((await loadFanqieMarketingConfig(root)).books)[0];
    const visibleBody = ['快穿', '幻想言情', '女强', '打脸', '姜浅予', entry.intro].join('\n');
    assert.equal(classifyFanqieMarketingSubmission({ body: visibleBody, entry }).status, 'visible');
    assert.equal(classifyFanqieMarketingSubmission({ body: '旧简介', entry, editDisabled: true }).status, 'pending_review');
    assert.equal(classifyFanqieMarketingSubmission({ body: '旧简介', entry }).status, 'uncertain');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
