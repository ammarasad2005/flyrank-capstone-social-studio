import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.SCHEDULER_ENABLED = 'false';
process.env.USE_AI = 'false';
process.env.PLATFORMS = 'mock_x,mock_linkedin';
process.env.METRICS_AUTH_TOKEN = 'local-test-token-for-metrics-1234567890';

const { createApp } = await import('../src/app.js');
const token = process.env.METRICS_AUTH_TOKEN;
let server: any;
let base: string;

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('GET /metrics requires the configured bearer token and accepts the correct token', async () => {
  const missing = await fetch(`${base}/metrics`);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('www-authenticate'), 'Bearer');

  const wrong = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${token}-wrong` } });
  assert.equal(wrong.status, 401);

  const allowed = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(allowed.status, 200);
  assert.match(allowed.headers.get('content-type') || '', /text\/plain/);
  assert.match(await allowed.text(), /publish_attempts_total/);
});
