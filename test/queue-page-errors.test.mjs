import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPageError, QueueError } from '../lib/queue/page-errors.mjs';

test('queue page error classifier is isolated from browser orchestration', async () => {
  const rate = await detectPageError({ evaluate: async () => 'You have reached your usage limit' });
  assert.equal(rate instanceof QueueError, true);
  assert.equal(rate.kind, 'rate_limit');
  const safety = await detectPageError({ evaluate: async () => 'This may violate our content policy' });
  assert.equal(safety.kind, 'safety');
  assert.equal(await detectPageError({ evaluate: async () => 'ordinary reply' }), null);
});
