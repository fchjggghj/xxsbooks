import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAssistantText } from '../lib/assistant-text.mjs';

test('preserves paragraph breaks and removes the leading edit control artifact', () => {
  const raw = '编辑\r\n第40章：新的世界\r\n\r\n第一段。\r\n\r\n第二段。';
  assert.equal(
    normalizeAssistantText(raw),
    '第40章：新的世界\n\n第一段。\n\n第二段。',
  );
});

test('does not remove ordinary uses of 编辑', () => {
  assert.equal(normalizeAssistantText('责任编辑说：“继续。”'), '责任编辑说：“继续。”');
});

test('normalizes excessive blank lines without flattening the reply', () => {
  assert.equal(normalizeAssistantText('标题\n\n\n\n正文'), '标题\n\n正文');
});
