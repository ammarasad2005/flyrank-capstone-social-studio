// PROBE 6: swap a target purely via config (ADAPTER_OVERRIDE) — no code change.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.SCHEDULER_ENABLED = 'false';
process.env.USE_AI = 'false';
process.env.PLATFORMS = 'mastodon,mock_x,mock_linkedin';
process.env.ADAPTER_OVERRIDE = 'mastodon=mock_x';

const { createApp } = await import('../src/app.js');

let server: any;
let base: string;
before(async () => {
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const api = (method: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
const json = (r: Response): Promise<any> => r.json() as Promise<any>;

test('a mastodon slot publishes through the mock when ADAPTER_OVERRIDE reroutes it', async () => {
  const post = await json(await api('POST', '/posts', {
    title: 'Swap', markdown: '# Swap\n\nSame business logic, different target.',
  }));
  const gen = await json(await api('POST', `/posts/${post.id}/generate`, {}));
  const v = gen.created.find((x: any) => x.platform === 'mastodon');

  await api('POST', `/variants/${v.id}/approve`);
  const slot = await json(await api('POST', `/variants/${v.id}/schedule`, { adapter: 'mastodon' }));
  assert.equal(slot.adapter, 'mastodon');

  const out = await json(await api('POST', `/slots/${slot.id}/publish`));
  assert.match(out.attempt.external_url, /^mock:\/\/mock_x\//, 'published through the X mock');

  const mocks = await json(await api('GET', '/mock-posts'));
  assert.equal(mocks.length, 1);
  assert.equal(mocks[0].adapter, 'mock_x');
});
