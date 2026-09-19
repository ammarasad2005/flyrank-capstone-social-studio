// PROBE 6: swap a target purely via config (ADAPTER_OVERRIDE) — no code change.
// This env MUST be set before the modules that read it are imported.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_PATH = `/tmp/sms-swap-${randomUUID()}.db`;
process.env.SCHEDULER_ENABLED = 'false';
process.env.USE_AI = 'false';
process.env.ADAPTER_OVERRIDE = 'mastodon=mock_x'; // reroute the real target to a mock

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

test('a mastodon slot publishes through the mock when ADAPTER_OVERRIDE reroutes it', async () => {
  const post = await (await api('POST', '/posts', {
    title: 'Swap', markdown: '# Swap\n\nSame business logic, different target.',
  })).json();
  const gen = await (await api('POST', `/posts/${post.id}/generate`, {})).json();
  const v = gen.created.find((x) => x.platform === 'mastodon');

  await api('POST', `/variants/${v.id}/approve`);
  const slot = await (await api('POST', `/variants/${v.id}/schedule`, { adapter: 'mastodon' })).json();
  assert.equal(slot.adapter, 'mastodon', 'slot is recorded against the mastodon platform');

  // Publishing does NOT hit the network (no Mastodon creds) — it goes to the mock.
  const out = await (await api('POST', `/slots/${slot.id}/publish`)).json();
  assert.match(out.attempt.external_url, /^mock:\/\/mock_x\//, 'published through the X mock');

  const mocks = await (await api('GET', '/mock-posts')).json();
  assert.equal(mocks.length, 1, 'exactly one mock post recorded');
  assert.equal(mocks[0].adapter, 'mock_x');
});
