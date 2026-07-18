import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createControlStatusRuntime } from '../lib/control/status.mjs';

test('control status summary is independent from command routing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'control-status-'));
  try {
    const output = path.join(root, 'done.md');
    await fs.writeFile(output, '完成', 'utf8');
    const runtime = createControlStatusRuntime(root, { chai: 'config-chai.json', xie: 'config-xie.json' });
    const summary = runtime.summarizeStage({
      stage: 'chai', statePath: path.join(root, 'state.json'), logPath: path.join(root, 'run.log'),
      state: { currentTaskId: null, tasks: {
        one: { id: 'one', status: 'done', outputFile: output },
        two: { id: 'two', status: 'pending', outputFile: path.join(root, 'missing.md') },
      } },
    });
    assert.deepEqual(summary.counts, { done: 1, failed: 0, pending: 1, running: 0, other: 0 });
    assert.equal(summary.complete, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
