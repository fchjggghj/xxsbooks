import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseFanqieControlArgs } from '../fanqie-control.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('local dashboard exposes guarded Fanqie controls without auto-publishing', async () => {
  const [html, client, server] = await Promise.all([
    fs.readFile(path.join(root, 'ui', 'index.html'), 'utf8'),
    fs.readFile(path.join(root, 'ui', 'app.js'), 'utf8'),
    fs.readFile(path.join(root, 'local-ui.mjs'), 'utf8'),
  ]);
  for (const id of [
    'tab-fanqie', 'fanqie-book', 'fanqie-refresh-local', 'fanqie-remote-status',
    'fanqie-upload-preview', 'fanqie-reconcile-preview', 'fanqie-confirmation', 'fanqie-upload-apply',
  ]) assert.equal(html.includes(`id="${id}"`), true, `missing #${id}`);
  assert.equal(client.includes('PUBLISH ${body.book}'), true);
  assert.equal(client.includes('window.confirm(question)'), true);
  assert.equal(server.includes('/api/fanqie/local-status'), true);
  assert.equal(server.includes('二次确认文字不匹配'), true);
  assert.equal(client.includes("target === 'fanqie'"), true);
  assert.equal(client.includes("runFanqieCommand('upload', true)"), true);
});

test('Fanqie control accepts help before a command', () => {
  assert.equal(parseFanqieControlArgs(['--help']).help, true);
});
