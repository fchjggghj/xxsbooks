import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadBookCatalog, settingsForBook } from '../lib/book-catalog.mjs';

test('explicit catalog isolates unconfigured books and applies per-stage ranges', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xxsbooks-catalog-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, '001.json'), JSON.stringify({
    name: '书A',
    stages: { xie: { chapterRange: { start: 1, end: 60 } } },
  }));
  const catalog = await loadBookCatalog({ bookConfigDir: dir, bookCatalogMode: 'explicit' });
  assert.deepEqual(settingsForBook(catalog, '书A', 'xie').chapterRange, { start: 1, end: 60 });
  assert.equal(settingsForBook(catalog, '未配置书', 'xie').enabled, false);
});
