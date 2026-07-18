import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  importMaterialToBook,
  indexMaterialCatalog,
  materialLocalStatus,
  searchMaterialCatalog,
} from '../lib/material-catalog.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xxs-material-'));
  const project = path.join(root, 'project');
  const source = path.join(root, 'library');
  await fs.mkdir(path.join(project, 'config', 'local'), { recursive: true });
  await fs.mkdir(path.join(project, '书籍', '测试书'), { recursive: true });
  await fs.mkdir(path.join(source, 'S'), { recursive: true });
  await fs.writeFile(path.join(source, 'S', '0017_快穿：反派学习系统【女】71万.txt'), '素材正文', 'utf8');
  await fs.writeFile(path.join(source, '别的题材.md'), '内容', 'utf8');
  await fs.writeFile(path.join(project, 'config', 'local', 'material-sources.json'), JSON.stringify({
    schemaVersion: 1,
    sources: { main: { label: '测试库', root: source, mode: 'read-only', extensions: ['.txt', '.md'] } },
  }));
  return { root, project, source };
}

test('material index stores metadata and search uses filename tags', async () => {
  const item = await fixture();
  try {
    const indexed = await indexMaterialCatalog(item.project, true);
    assert.equal(indexed.fileCount, 2);
    assert.equal(indexed.applied, true);
    const status = await materialLocalStatus(item.project);
    assert.equal(status.indexed, true);
    assert.equal(status.fileCount, 2);
    const search = await searchMaterialCatalog(item.project, '快穿 女');
    assert.equal(search.totalMatches, 1);
    assert.equal(search.items[0].title, '快穿：反派学习系统');
    assert.deepEqual(search.items[0].tags, ['女']);
  } finally {
    await fs.rm(item.root, { recursive: true, force: true });
  }
});

test('selected material import previews, copies once, and rejects traversal/overwrite', async () => {
  const item = await fixture();
  try {
    const options = { sourceId: 'main', relativePath: 'S/0017_快穿：反派学习系统【女】71万.txt', book: '测试书' };
    const preview = await importMaterialToBook(item.project, options);
    assert.equal(preview.readOnly, true);
    await assert.rejects(fs.access(preview.destination));
    const applied = await importMaterialToBook(item.project, { ...options, apply: true });
    assert.equal(await fs.readFile(applied.destination, 'utf8'), '素材正文');
    await assert.rejects(() => importMaterialToBook(item.project, { ...options, apply: true }), /拒绝覆盖/u);
    await assert.rejects(() => importMaterialToBook(item.project, { ...options, relativePath: '../escape.txt' }), /越界/u);
  } finally {
    await fs.rm(item.root, { recursive: true, force: true });
  }
});
