import test from 'node:test';
import assert from 'node:assert/strict';
import { filterFilesByChapterRange, matchesBookFilter } from '../lib/task-scope.mjs';

test('book filters match either the book or volume task key', () => {
  const novel = { novelName: '书A', novelKey: '书A/第一卷' };
  assert.equal(matchesBookFilter(['书A'], novel), true);
  assert.equal(matchesBookFilter(['书A/第一卷'], novel), true);
  assert.equal(matchesBookFilter(['书B'], novel), false);
});

test('chapter range is applied independently to each book task list', () => {
  const files = [1, 60, 61].map((chapter) => ({ inputPath: `${String(chapter).padStart(4, '0')}.md` }));
  assert.deepEqual(
    filterFilesByChapterRange(files, { start: 1, end: 60 }).map((file) => file.inputPath),
    ['0001.md', '0060.md'],
  );
});
