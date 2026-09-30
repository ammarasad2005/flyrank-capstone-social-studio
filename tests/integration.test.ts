// End-to-end HTTP tests for the scary cases. Each test file runs in its own process,
// pointed at a throwaway in-memory PGlite (real Postgres), booting the real Express app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.SCHEDULER_ENABLED = 'false';
process.env.USE_AI = 'false';
process.env.PLATFORMS = 'mastodon,mock_x,mock_linkedin';

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

async function ingestAndGenerate() {
  const post = await json(await api('POST', '/posts', {
    title: 'Test post',
    markdown: '# Test post\n\nA short body about shipping software faster and safer.',
  }));
  const gen = await json(await api('POST', `/posts/${post.id}/generate`, {}));
  return { post, gen };
}

test('PROBE 1: ingest -> every generated variant obeys its platform profile', async () => {
  const { gen } = await ingestAndGenerate();
  assert.ok(gen.created.length >= 2, 'expected multiple valid variants');
  assert.equal(gen.blocked.length, 0, 'template variants must not be blocked');
  const limits: Record<string, number> = { mastodon: 500, mock_x: 280, mock_linkedin: 3000 };
  for (const v of gen.created) assert.ok(v.content.length <= limits[v.platform], `${v.platform} within length`);
});

test('PROBE 2: a rule-breaking manual variant is blocked, naming the rule', async () => {
  const { post } = await ingestAndGenerate();
  const res = await api('POST', '/variants', {
    post_id: post.id, platform: 'mock_x', content: 'x'.repeat(300) + ' #a #b #c #d #e',
  });
  assert.equal(res.status, 422);
  const body = await json(res);
  const joined = body.violations.join(' | ');
  assert.match(joined, /max length/i);
  assert.match(joined, /hashtag/i);
});

test('PROBE 3: scheduling an UNAPPROVED variant is refused with a 4xx + message', async () => {
  const { gen } = await ingestAndGenerate();
  const v = gen.created[0];
  const res = await api('POST', `/variants/${v.id}/schedule`, { adapter: v.platform });
  assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
  const body = await json(res);
  assert.match(body.error, /approved/i);
});

test('PROBE 5: repeated publish of one slot produces exactly one post', async () => {
  const { gen } = await ingestAndGenerate();
  const v = gen.created.find((x: any) => x.platform === 'mock_x');
  await api('POST', `/variants/${v.id}/approve`);
  const slot = await json(await api('POST', `/variants/${v.id}/schedule`, { adapter: 'mock_x' }));

  const results: any[] = [];
  for (let i = 0; i < 3; i++) results.push(await json(await api('POST', `/slots/${slot.id}/publish`)));
  assert.equal(results[0].reused, false, 'first publish actually posts');
  assert.equal(results[1].reused, true, 'second is idempotent no-op');
  assert.equal(results[2].reused, true, 'third is idempotent no-op');

  const history = await json(await api('GET', '/history'));
  const succeeded = history.filter((a: any) => a.idempotency_key === `${v.id}:${slot.id}` && a.status === 'succeeded');
  assert.equal(succeeded.length, 1, 'exactly one succeeded attempt');
});
