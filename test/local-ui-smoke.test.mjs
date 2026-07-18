import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForUrl(url) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error(`UI did not become ready: ${url}`);
}

test('local UI serves the Fanqie dashboard and local-only status API', { timeout: 15_000 }, async () => {
  const port = await availablePort();
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'xxsbooks-ui-'));
  const profileDir = path.join(project, 'profile');
  await fs.mkdir(path.join(project, 'config', 'books'), { recursive: true });
  await fs.mkdir(path.join(project, 'config', 'local'), { recursive: true });
  await fs.mkdir(path.join(project, '书籍', '测试书', '正文'), { recursive: true });
  await fs.writeFile(path.join(project, 'config-xie.json'), JSON.stringify({ bookConfigDir: 'config/books', bookCatalogMode: 'explicit', volumeMode: false }), 'utf8');
  await fs.writeFile(path.join(project, 'config', 'local', 'fanqie-accounts.json'), JSON.stringify({
    schemaVersion: 1, accounts: { test: { label: '测试账号', profileDir, profileName: 'Default', cdpPort: 19333 } },
  }), 'utf8');
  await fs.writeFile(path.join(project, 'config', 'books', '001.json'), JSON.stringify({
    name: '测试书', enabled: true, fanqie: {
      schemaVersion: 1, accountRef: 'test', workId: '123456789', workTitle: '测试作品', sourceDir: '正文',
      aiUsed: false, schedule: { firstChapter: 1, firstDate: '2099-01-01', chaptersPerDay: 1, time: '00:00' },
    },
  }), 'utf8');
  await fs.writeFile(path.join(project, '书籍', '测试书', '正文', '0001.md'), `第1章 测试章节\n\n${'正文内容'.repeat(400)}`, 'utf8');
  const child = spawn(process.execPath, [path.join(root, 'local-ui.mjs'), '--port', String(port)], {
    cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, XXSBOOKS_PROJECT_ROOT: project },
  });
  try {
    const page = await waitForUrl(`http://127.0.0.1:${port}/`);
    assert.equal((await page.text()).includes('id="tab-fanqie"'), true);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/fanqie/local-status`)).json();
    assert.equal(status.ok, true);
    assert.equal(status.books.length, 1);
  } finally {
    if (child.exitCode == null) child.kill();
    await new Promise((resolve) => {
      if (child.exitCode != null) resolve();
      else child.once('exit', resolve);
    });
    await fs.rm(project, { recursive: true, force: true });
  }
});
