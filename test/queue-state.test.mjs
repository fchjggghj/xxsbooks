import test from 'node:test';
import assert from 'node:assert/strict';
import { firstRunnableTask, mergeStateTasks } from '../lib/queue-state.mjs';

const cfg = { skipExisting: true };
const opts = { force: false };

function task(id = '书A:0001', novelKey = '书A') {
  return {
    id,
    localId: id.split(':').at(-1),
    index: 0,
    novelKey,
    novelName: novelKey,
    volumeName: '',
    inputFiles: [{ relativePath: `${novelKey}/原文/0001.txt` }],
    outputPath: `${novelKey}/拆分/0001.md`,
  };
}

function emptyState() {
  return { tasks: {} };
}

test('existing output is marked done during state merge', () => {
  const item = task();
  const state = emptyState();

  mergeStateTasks(cfg, state, [item], opts, { exists: () => true, now: () => 'now' });

  assert.equal(state.tasks[item.id].status, 'done');
  assert.equal(state.tasks[item.id].restartRequired, false);
});

test('one-time novel restart overrides an existing output', () => {
  const item = task();
  const state = { tasks: { [item.id]: { status: 'done', sent: true } } };

  mergeStateTasks(cfg, state, [item], opts, {
    exists: () => true,
    now: () => 'now',
    restartNovelKeys: new Set([item.novelKey]),
  });

  assert.equal(state.tasks[item.id].status, 'pending');
  assert.equal(state.tasks[item.id].restartRequired, true);
  assert.equal(state.tasks[item.id].sent, true);
});

test('restart-required task remains runnable even when its output exists', () => {
  const item = task();
  const state = { tasks: { [item.id]: { status: 'pending', restartRequired: true } } };

  const runnable = firstRunnableTask(cfg, state, [item], opts, { exists: () => true });

  assert.equal(runnable, item);
});

test('completed task with an existing output is skipped', () => {
  const item = task();
  const state = { tasks: { [item.id]: { status: 'done', restartRequired: false } } };

  const runnable = firstRunnableTask(cfg, state, [item], opts, { exists: () => true });

  assert.equal(runnable, null);
});

test('book-scoped merge preserves tasks belonging to other books', () => {
  const scoped = task('书A:0001', '书A');
  const state = {
    tasks: {
      '书B:0001': { id: '书B:0001', novelKey: '书B', status: 'done' },
    },
  };
  mergeStateTasks(cfg, state, [scoped], opts, {
    exists: () => false,
    now: () => 'now',
    preserveExisting: true,
  });
  assert.equal(state.tasks['书B:0001'].status, 'done');
  assert.equal(state.tasks['书A:0001'].status, 'pending');
});
