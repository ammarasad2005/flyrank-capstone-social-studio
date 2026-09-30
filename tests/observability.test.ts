// T0-C: liveness/readiness/metrics endpoints, and that a publish is reflected in the
// Prometheus metrics. Boots the real Express app against an in-memory PGlite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.SCHEDULER_ENABLED = 'false';
process.env.USE_AI = 'false';
process.env.PLATFORMS = 'mock_x,mock_linkedin';

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

const json = (r: Response): Promise<any> => r.json() as Promise<any>;
const api = (method: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

test('GET /health is live and sets a request-id header on normal routes', async () => {
  const res = await api('GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { status: 'ok' });
  // request id is echoed on a logged route
  const root = await api('GET', '/');
  assert.ok(root.headers.get('x-request-id'), 'x-request-id present');
});

test('GET /ready reports DB + queue checks (inprocess: queue ok)', async () => {
  const res = await api('GET', '/ready');
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.status, 'ready');
  assert.equal(body.driver, 'inprocess');
  assert.equal(body.checks.db, 'ok');
  assert.equal(body.checks.queue, 'ok');
});

test('GET /metrics exposes Prometheus text with our custom series', async () => {
  const res = await api('GET', '/metrics');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/plain/);
  const body = await res.text();
  for (const name of [
    'publish_attempts_total',
    'publish_duration_seconds',
    'publish_retries_total',
    'publish_dead_letters_total',
    'slots_pending',
    'http_request_duration_seconds',
  ]) {
    assert.ok(body.includes(name), `metrics include ${name}`);
  }
});

test('a successful publish increments publish_attempts_total{outcome="succeeded"}', async () => {
  const post = await json(await api('POST', '/posts', { title: 'Obs', markdown: '# Obs\n\nA post to prove metrics increment on publish.' }));
  const gen = await json(await api('POST', `/posts/${post.id}/generate`, {}));
  const variant = gen.created.find((v: any) => v.platform === 'mock_x') ?? gen.created[0];
  await api('POST', `/variants/${variant.id}/approve`);
  const slot = await json(await api('POST', `/variants/${variant.id}/schedule`, {
    adapter: 'mock_x',
    scheduled_at: new Date().toISOString(),
  }));
  const pub = await json(await api('POST', `/slots/${slot.id}/publish`));
  assert.ok(pub, 'publish returned');

  const metrics = await (await api('GET', '/metrics')).text();
  const line = metrics
    .split('\n')
    .find((l) => l.startsWith('publish_attempts_total') && l.includes('adapter="mock_x"') && l.includes('outcome="succeeded"'));
  assert.ok(line, 'a succeeded publish_attempts_total series for mock_x exists');
  const value = Number(line!.trim().split(/\s+/).pop());
  assert.ok(value >= 1, `counter value ${value} >= 1`);
});
