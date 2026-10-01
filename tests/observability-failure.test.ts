import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Sentry from '@sentry/node';
import type { NodeOptions } from '@sentry/node';

// A fully offline dead-letter drill: PGlite for state, a credential-less Telegram
// adapter that fails before fetch, an in-memory Sentry transport, and a stub webhook.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DATABASE_PATH = ':memory:';
process.env.SCHEDULER_ENABLED = 'false';
process.env.USE_AI = 'false';
process.env.PLATFORMS = 'telegram';
process.env.RETRY_MAX_ATTEMPTS = '3';
process.env.RETRY_BASE_MS = '10';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';
process.env.MASTODON_BASE_URL = '';
process.env.MASTODON_ACCESS_TOKEN = '';
process.env.ALERT_WEBHOOK_URL = 'https://alerts.invalid/test-webhook';
process.env.SENTRY_DSN = 'https://public@example.invalid/1';
process.env.SENTRY_TRACES_SAMPLE_RATE = '1';

const originalFetch = globalThis.fetch;
const webhookCalls: Array<{ url: string; body: string }> = [];
globalThis.fetch = async (input, init) => {
  webhookCalls.push({
    url: input instanceof URL ? input.toString() : String(input),
    body: String(init?.body ?? ''),
  });
  return new Response(null, { status: 204 });
};

const sentryEnvelopes: unknown[] = [];
const testTransport: NonNullable<NodeOptions['transport']> = () => ({
  send: async (envelope) => {
    sentryEnvelopes.push(envelope);
    return { statusCode: 200 };
  },
  flush: async () => true,
});

const { initSentry } = await import('../src/observability/sentry.js');
assert.equal(initSentry({ transport: testTransport }), true);
const { db } = await import('../src/db.js');
const repo = await import('../src/repo.js');
const { processSlot } = await import('../src/process-slot.js');
const { register } = await import('../src/observability/metrics.js');

after(async () => {
  globalThis.fetch = originalFetch;
  await db.close();
  await Sentry.flush(1_000);
  await Sentry.close(1_000);
});

test('forced credential-less publish failure reaches DLQ, Sentry, and the Slack-style webhook without platform network', async () => {
  const post = await repo.insertPost({ source_type: 'markdown', title: 'Offline failure drill', content_md: 'Safe test fixture.' });
  const variant = await repo.insertVariant({
    post_id: post.id,
    platform: 'telegram',
    content: 'This must never reach Telegram.',
    status: 'approved',
  });
  const slot = await repo.insertSlot({
    variant_id: variant.id,
    adapter: 'telegram',
    scheduled_at: new Date(Date.now() - 1_000).toISOString(),
  });

  const log = { ...console, warn: () => {}, error: () => {} } as unknown as Console;
  const results = [];
  for (let attempt = 0; attempt < 3; attempt += 1) results.push(await processSlot(slot.id, log));
  const result = results[results.length - 1];
  assert.deepEqual(results.map((item) => item.outcome), ['retry_scheduled', 'retry_scheduled', 'dead_letter']);
  assert.equal(result.reason?.includes('telegram'), true);
  assert.equal((await repo.getSlot(slot.id))?.status, 'dead_letter');
  assert.equal((await repo.listDeadLetters()).length, 1);

  await Sentry.flush(1_000);
  assert.ok(sentryEnvelopes.length > 0, 'Sentry event was accepted by the in-memory transport');
  assert.ok(
    sentryEnvelopes.some((envelope) => JSON.stringify(envelope).includes('telegram adapter not configured')),
    'Sentry transport receives the forced adapter exception',
  );
  assert.equal(webhookCalls.length, 1, 'one dead-letter webhook was sent to the local stub');
  assert.equal(webhookCalls[0].url, 'https://alerts.invalid/test-webhook');
  const alert = JSON.parse(webhookCalls[0].body);
  assert.equal(alert.slot_id, slot.id);
  assert.equal(alert.adapter, 'telegram');
  assert.match(alert.text, /dead-lettered/);
  assert.equal(webhookCalls.some((call) => call.url.includes('api.telegram.org')), false, 'no Telegram request was made');

  const metrics = await register.metrics();
  const deadLetterMetric = metrics.split('\n').find((line) =>
    line.startsWith('publish_dead_letters_total{')
      && line.includes('adapter="telegram"')
      && line.includes('reason="max_attempts"'),
  );
  assert.match(deadLetterMetric ?? '', / 1$/);
  const retryMetric = metrics.split('\n').find((line) =>
    line.startsWith('publish_retries_total{') && line.includes('adapter="telegram"'),
  );
  assert.match(retryMetric ?? '', / 2$/);
});
