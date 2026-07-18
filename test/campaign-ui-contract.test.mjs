import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('local dashboard exposes six-lane campaign status and guarded lifecycle actions', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const [html, client, server] = await Promise.all([
    fs.readFile(path.join(root, 'ui', 'index.html'), 'utf8'),
    fs.readFile(path.join(root, 'ui', 'app.js'), 'utf8'),
    fs.readFile(path.join(root, 'local-ui.mjs'), 'utf8'),
  ]);
  for (const id of [
    'tab-campaign', 'campaign-lanes', 'campaign-tick', 'campaign-tick-publish',
    'campaign-metrics-apply', 'campaign-decision-apply', 'campaign-enroll-apply',
  ]) assert.equal(html.includes(`id="${id}"`), true, `missing ${id}`);
  assert.equal(server.includes('/api/campaign/status'), true);
  assert.equal(server.includes("['tick', 'bootstrap', 'enroll', 'metrics', 'decide']"), true);
  assert.equal(client.includes("target === 'campaign'"), true);
  assert.equal(client.includes('runCampaignTick'), true);
  assert.equal(client.includes('确认应用续写/淘汰决策'), true);
});
