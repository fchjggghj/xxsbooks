import test from 'node:test';
import assert from 'node:assert/strict';
import { firstNonEmptyLine, replaceReplyTitle } from '../lib/chapter-title.mjs';

test('reads the original title from the first non-empty source line', () => {
  assert.equal(firstNonEmptyLine('\uFEFF\n第1章原来的标题\n正文'), '第1章原来的标题');
});

test('replaces a generated chapter title without changing the body', () => {
  const result = replaceReplyTitle('第1章：AI概括标题\n\n第一段。\n', '第1章原来的标题');
  assert.equal(result, '第1章原来的标题\n\n第一段。\n');
});

test('prepends the required title when the reply omitted it', () => {
  assert.equal(replaceReplyTitle('正文直接开始。', '第一章原来的标题'), '第一章原来的标题\n\n正文直接开始。\n');
});
