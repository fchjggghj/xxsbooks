import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('local dashboard exposes material status, search, index and guarded selected import', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const [html, client, server] = await Promise.all([
    fs.readFile(path.join(root, 'ui', 'index.html'), 'utf8'),
    fs.readFile(path.join(root, 'ui', 'app.js'), 'utf8'),
    fs.readFile(path.join(root, 'local-ui.mjs'), 'utf8'),
  ]);
  for (const id of ['tab-materials', 'material-index', 'material-search', 'material-results', 'material-import-preview', 'material-import-apply']) {
    assert.equal(html.includes(`id="${id}"`), true, `missing ${id}`);
  }
  assert.equal(server.includes('/api/material/local-status'), true);
  assert.equal(server.includes('/api/material/search'), true);
  assert.equal(server.includes('/api/material/index'), true);
  assert.equal(server.includes('/api/material/import'), true);
  assert.equal(client.includes("target === 'materials'"), true);
  assert.equal(client.includes('window.confirm(`把所选素材复制到《${book}》的素材目录？`)'), true);
});
