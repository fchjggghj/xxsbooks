import test from 'node:test';
import assert from 'node:assert/strict';
import { claimConversation, isConversationUrl, releaseNovelConversation } from '../lib/conversation-registry.mjs';

test('recognizes only concrete ChatGPT conversation URLs', () => {
  assert.equal(isConversationUrl('https://chatgpt.com/c/abc123'), true);
  assert.equal(isConversationUrl('https://chatgpt.com/g/custom-gpt'), false);
});

test('prevents two books from claiming the same conversation', () => {
  const state = { novelConversations: {}, conversationOwners: {} };
  claimConversation(state, 'https://chatgpt.com/c/abc123', { stage: 'xie', novelKey: '书A' });
  assert.throws(
    () => claimConversation(state, 'https://chatgpt.com/c/abc123', { stage: 'xie', novelKey: '书B' }),
    /belongs to xie\/书A/,
  );
});

test('releasing one book removes only its ownership record', () => {
  const state = { novelConversations: { 书A: 'https://chatgpt.com/c/abc123' }, conversationOwners: {} };
  claimConversation(state, state.novelConversations.书A, { stage: 'chai', novelKey: '书A' });
  releaseNovelConversation(state, 'chai', '书A');
  assert.deepEqual(state.novelConversations, {});
  assert.deepEqual(state.conversationOwners, {});
});
