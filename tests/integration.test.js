// End-to-end HTTP tests for the scary cases (stretch goal). Each test file runs in
// its own process, so we point it at a throwaway DB and boot the real Express app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_PATH = `/tmp/sms-int-${randomUUID()}.db`;
process.env.SCHEDULER_ENABLED = 'false';
process.env.USE_AI = 'false';
process.env.PLATFORMS = 'mastodon,mock_x,mock_linkedin';

const { createApp } = await import('../src/app.js');

let server;
let base;
before(async () => {
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const api = (method, path, body) =>
  fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

async function ingestAndGenerate() {
  const post = await (await api('POST', '/posts', {
    title: 'Test post',
    markdown: '# Test post\n\nA short body about shipping software faster and safer.',
  })).json();
  const gen = await (await api('POST', `/posts/${post.id}/generate`, {})).json();
  return { post, gen };
}

test('PROBE 1: ingest -> every generated variant obeys its platform profile', async () => {
  const { gen } = await ingestAndGenerate();
  assert.ok(gen.created.length >= 2, 'expected multiple valid variants');
  assert.equal(gen.blocked.length, 0, 'template variants must not be blocked');
  // each variant is within its platform max length
  const limits = { mastodon: 500, mock_x: 280, mock_linkedin: 3000 };
  for (const v of gen.created) {
    assert.ok(v.content.length <= limits[v.platform], `${v.platform} within length`);
  }
});

test('PROBE 2: a rule-breaking manual variant is blocked, naming the rule', async () => {
  const { post } = await ingestAndGenerate();
  const res = await api('POST', '/variants', {
    post_id: post.id,
    platform: 'mock_x',
    content: 'x'.repeat(300) + ' #a #b #c #d #e',
  });
  assert.equal(res.status, 422, 'over-limit variant must be rejected');
  const body = await res.json();
  const joined = body.violations.join(' | ');
  assert.match(joined, /max length/i, 'violation names the length rule');
  assert.match(joined, /hashtag/i, 'violation names the hashtag rule');
});

test('PROBE 3: scheduling an UNAPPROVED variant is refused with a 4xx + message', async () => {
  const { gen } = await ingestAndGenerate();
  const v = gen.created[0]; // status: draft
  const res = await api('POST', `/variants/${v.id}/schedule`, { adapter: v.platform });
  assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
  const body = await res.json();
  assert.match(body.error, /approved/i, 'error explains only approved variants schedule');
});

test('PROBE 5: repeated publish of one slot produces exactly one post', async () => {
  const { gen } = await ingestAndGenerate();
  const v = gen.created.find((x) => x.platform === 'mock_x');
  await api('POST', `/variants/${v.id}/approve`);
  const slot = await (await api('POST', `/variants/${v.id}/schedule`, { adapter: 'mock_x' })).json();

  // fire the publish endpoint three times
  const results = [];
  for (let i = 0; i < 3; i++) {
    results.push(await (await api('POST', `/slots/${slot.id}/publish`)).json());
  }
  assert.equal(results[0].reused, false, 'first publish actually posts');
  assert.equal(results[1].reused, true, 'second publish is an idempotent no-op');
  assert.equal(results[2].reused, true, 'third publish is an idempotent no-op');

  const history = await (await api('GET', '/history')).json();
  const succeeded = history.filter((a) => a.idempotency_key === `${v.id}:${slot.id}` && a.status === 'succeeded');
  assert.equal(succeeded.length, 1, 'exactly one succeeded attempt for this slot');
});
