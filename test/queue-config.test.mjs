import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadQueueConfig, parseQueueArgs, validateQueueConfig } from '../lib/queue/config.mjs';

test('queue argument parsing remains isolated from the runner', () => {
  assert.deepEqual(parseQueueArgs(['node', 'gpts-queue.mjs', '--config', 'x.json', '--book', '书一', '--dry-run']), {
    configPath: 'x.json', dryRun: true, force: false, limit: 0, perNovelLimit: 0,
    bookFilters: ['书一'], resetState: false,
  });
});

test('queue config loading normalizes paths and validates invariants', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-config-'));
  try {
    const file = path.join(root, 'config-chai.json');
    await fs.writeFile(file, JSON.stringify({
      gptUrl: 'https://chatgpt.com/g/test', cdpUrl: 'http://127.0.0.1:9222',
      inputDir: 'input', outputDir: 'output', promptTemplate: '{{content}}', chaptersPerPrompt: 1,
    }), 'utf8');
    const cfg = await loadQueueConfig(file, root);
    assert.equal(cfg.inputDir, path.join(root, 'input'));
    assert.equal(cfg.stage, 'chai');
    assert.doesNotThrow(() => validateQueueConfig(cfg, false));
    assert.throws(() => validateQueueConfig({ ...cfg, chaptersPerPrompt: 2 }, false), /must be 1/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
