import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildFanqieAccountRegistry, importExternalResources } from '../lib/external-resources.mjs';

test('account import preserves an existing ref by normalized Profile path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xxs-external-'));
  try {
    const project = path.join(root, 'project');
    const accountsRoot = path.join(root, 'accounts');
    const profiles = path.join(accountsRoot, 'Profiles');
    await fs.mkdir(path.join(project, 'config', 'local'), { recursive: true });
    await fs.mkdir(path.join(profiles, 'fanqie-01'), { recursive: true });
    await fs.mkdir(path.join(profiles, 'fanqie-02'), { recursive: true });
    await fs.writeFile(path.join(accountsRoot, '番茄账号 01【甲】.lnk'), 'placeholder');
    await fs.writeFile(path.join(accountsRoot, '番茄账号 01.lnk'), 'placeholder');
    await fs.writeFile(path.join(accountsRoot, '番茄账号 02.lnk'), 'placeholder');
    await fs.writeFile(path.join(project, 'config', 'local', 'fanqie-accounts.json'), JSON.stringify({
      schemaVersion: 1,
      accounts: {
        stable: { label: '旧名', profileDir: path.join(profiles, 'fanqie-01'), cdpPort: 9444 },
      },
    }));

    const result = await buildFanqieAccountRegistry(project, accountsRoot);
    assert.equal(result.discovered, 2);
    assert.equal(result.preserved, 1);
    assert.equal(result.imported[0].ref, 'stable');
    assert.equal(result.imported[0].cdpPort, 9444);
    assert.match(result.imported[0].shortcutPath, /【甲】\.lnk$/u);
    assert.equal(result.imported[1].ref, 'fanqie-02');
    assert.equal(result.imported[1].cdpPort, 9334);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('external resource import is preview-only unless apply is explicit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xxs-external-preview-'));
  try {
    const project = path.join(root, 'project');
    const materials = path.join(root, 'materials');
    await fs.mkdir(materials, { recursive: true });
    const preview = await importExternalResources(project, { materialRoot: materials });
    assert.equal(preview.readOnly, true);
    await assert.rejects(fs.access(path.join(project, 'config', 'local', 'material-sources.json')));
    const applied = await importExternalResources(project, { materialRoot: materials, apply: true });
    assert.equal(applied.applied, true);
    await fs.access(path.join(project, 'config', 'local', 'material-sources.json'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
