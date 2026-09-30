// T0-B: retry-with-backoff then dead-letter. Uses the telegram adapter WITHOUT
// credentials — it throws before any network call, so the failure path is exercised
// deterministically and offline. processSlot() owns the retry/dead-letter decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.SCHEDULER_ENABLED = 'false';
process.env.USE_AI = 'false';
process.env.PLATFORMS = 'telegram,mock_x,mock_linkedin';
process.env.RETRY_MAX_ATTEMPTS = '3';
process.env.RETRY_BASE_MS = '10';
// no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID => adapter.publish() throws immediately

const repo = await import('../src/repo.js');
const { processSlot } = await import('../src/process-slot.js');

// a log that swallows output but records DLQ alerts for assertions
function makeLog() {
  const dlq: string[] = [];
  const log = {
    ...console,
    log: () => {},
    warn: () => {},
    error: (m: any) => { if (String(m).includes('[DLQ]')) dlq.push(String(m)); },
  } as unknown as Console;
  return { log, dlq };
}

async function fixtureTelegramSlot() {
  const post = await repo.insertPost({ source_type: 'markdown', title: 'R', content_md: '# R\n\nbody' });
  const variant = await repo.insertVariant({ post_id: post.id, platform: 'telegram', content: 'retry me', status: 'approved' });
  const slot = await repo.insertSlot({ variant_id: variant.id, adapter: 'telegram', scheduled_at: new Date(Date.now() - 1000).toISOString() });
  return slot;
}

test('failing send retries with backoff, then dead-letters at max attempts', async () => {
  const { log, dlq } = makeLog();
  const slot = await fixtureTelegramSlot();

  // attempt 1 -> retry
  let res = await processSlot(slot.id, log);
  assert.equal(res.outcome, 'retry_scheduled');
  let cur = (await repo.getSlot(slot.id))!;
  assert.equal(cur.status, 'pending');
  assert.equal(cur.attempts, 1);
  assert.ok(cur.next_attempt_at, 'a backoff time was scheduled');
  assert.ok(cur.last_error && cur.last_error.includes('telegram'), 'error captured');

  // attempt 2 -> retry
  res = await processSlot(slot.id, log);
  assert.equal(res.outcome, 'retry_scheduled');
  assert.equal((await repo.getSlot(slot.id))!.attempts, 2);

  // attempt 3 (== max) -> dead-letter + alert
  res = await processSlot(slot.id, log);
  assert.equal(res.outcome, 'dead_letter');
  cur = (await repo.getSlot(slot.id))!;
  assert.equal(cur.status, 'dead_letter');
  assert.equal(cur.attempts, 3);
  assert.equal(cur.next_attempt_at, null);
  assert.equal(dlq.length, 1, 'exactly one DLQ alert fired');

  // a dead-lettered slot is never claimed again
  const claimed = await repo.claimDueSlot();
  assert.equal(claimed, null, 'dead_letter slots are not re-claimed');
  assert.equal((await repo.listDeadLetters()).length, 1);
});

test('backoff grows and gates claimDueSlot until next_attempt_at passes', async () => {
  const { log } = makeLog();
  const slot = await fixtureTelegramSlot();
  await processSlot(slot.id, log); // fail once -> next_attempt_at in the future
  const cur = (await repo.getSlot(slot.id))!;
  assert.equal(cur.status, 'pending');
  // next_attempt_at is in the future (base 10ms * 2^0 + jitter), so not yet due
  const notYet = await repo.claimDueSlot();
  assert.equal(notYet, null, 'slot is held back by its backoff window');
});

test('uncertain non-idempotent crash is dead-lettered immediately (no retry)', async () => {
  const { log, dlq } = makeLog();
  const slot = await fixtureTelegramSlot();
  const key = `${slot.variant_id}:${slot.id}`;

  // simulate a crash mid-send: attempt left in_flight for a non-idempotent adapter
  await repo.setSlotStatus(slot.id, 'publishing');
  const a = await repo.insertPendingAttempt({ variant_id: slot.variant_id, slot_id: slot.id, idempotency_key: key, adapter: 'telegram' });
  await repo.markAttemptInFlight(a.id);

  const res = await processSlot(slot.id, log);
  assert.equal(res.outcome, 'dead_letter');
  assert.equal(res.reason, 'uncertain');
  assert.equal((await repo.getSlot(slot.id))!.status, 'dead_letter');
  assert.equal((await repo.findAttemptByKey(key))!.status, 'uncertain');
  assert.equal(dlq.length, 1);
});
