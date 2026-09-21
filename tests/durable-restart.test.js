// The durable-restart / crash-mid-publish probe.
//
// We simulate a worker that sent the post to the target (mock post created, attempt
// row still 'pending') and then DIED before recording success, leaving the slot in
// 'publishing'. On "restart" we run publishSlot() again — exactly-once must hold:
// no second mock post, the attempt converges to 'succeeded', the slot to 'published'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_PATH = `/tmp/sms-durable-${randomUUID()}.db`;
process.env.SCHEDULER_ENABLED = 'false';
process.env.USE_AI = 'false';
process.env.PLATFORMS = 'mastodon,mock_x,mock_linkedin';

const repo = await import('../src/repo.js');
const { getAdapter } = await import('../src/adapters/index.js');
const { publishSlot } = await import('../src/publisher.js');

function fixtureApprovedSlot(adapter = 'mock_x') {
  const post = repo.insertPost({ source_type: 'markdown', title: 'Durable', content_md: '# Durable\n\nbody' });
  const variant = repo.insertVariant({
    post_id: post.id, platform: 'mock_x', content: 'A durable little post about retries', status: 'approved',
  });
  const slot = repo.insertSlot({
    variant_id: variant.id, adapter, scheduled_at: new Date().toISOString(),
  });
  return { post, variant, slot };
}

test('IDEMPOTENT adapter: crash after send, restart re-runs and does NOT double-post', async () => {
  const { variant, slot } = fixtureApprovedSlot('mock_x');
  const key = `${variant.id}:${slot.id}`;

  // ---- simulate the crashed worker's partial state: send was in-flight ----
  repo.setSlotStatus(slot.id, 'publishing');                 // slot claimed
  const a = repo.insertPendingAttempt({ variant_id: variant.id, slot_id: slot.id, idempotency_key: key, adapter: 'mock_x' });
  repo.markAttemptInFlight(a.id);                             // send was issued...
  await getAdapter('mock_x').publish({ idempotencyKey: key, variant }); // ...and had landed
  assert.equal(repo.listMockPosts().length, 1, 'the pre-crash send created one mock post');
  assert.equal(repo.findAttemptByKey(key).status, 'in_flight', 'attempt left in-flight by the crash');

  // ---- restart: scheduler reclaims 'publishing' -> 'pending' and re-runs ----
  const stuck = repo.reclaimStuckSlots();
  assert.equal(stuck.length, 1, 'one stuck slot found on restart');
  for (const s of stuck) repo.setSlotStatus(s.id, 'pending');

  const out = await publishSlot(slot.id);

  // ---- exactly-once: idempotent target safely re-sent, still one post ----
  assert.equal(repo.listMockPosts().length, 1, 'STILL exactly one mock post (no duplicate)');
  assert.equal(out.reused, true, 're-run recognised the target already had the post');
  assert.equal(repo.findAttemptByKey(key).status, 'succeeded', 'attempt converged to succeeded');
  assert.equal(repo.getSlot(slot.id).status, 'published', 'slot converged to published');
});

test('NON-IDEMPOTENT adapter (telegram): an in-flight crash is NOT retried (no duplicate)', async () => {
  const { variant, slot } = fixtureApprovedSlot('telegram');
  const key = `${variant.id}:${slot.id}`;

  // Simulate: the Telegram send was issued (message may or may not have landed), then crash.
  repo.setSlotStatus(slot.id, 'publishing');
  const a = repo.insertPendingAttempt({ variant_id: variant.id, slot_id: slot.id, idempotency_key: key, adapter: 'telegram' });
  repo.markAttemptInFlight(a.id);

  // Restart re-runs the slot. Because telegram is non-idempotent, we must NOT re-send.
  const out = await publishSlot(slot.id); // no network call happens (guard short-circuits)

  assert.equal(out.skipped, true, 're-run refused to re-send a non-idempotent in-flight message');
  assert.equal(out.reason, 'uncertain');
  assert.equal(repo.findAttemptByKey(key).status, 'uncertain', 'attempt flagged uncertain, not duplicated');
});

test('plain duplicate publish calls also produce exactly one post', async () => {
  const { slot } = fixtureApprovedSlot();
  await publishSlot(slot.id);
  await publishSlot(slot.id);
  await publishSlot(slot.id);
  const key = `${slot.variant_id}:${slot.id}`;
  const attempts = repo.listAttempts().filter((a) => a.idempotency_key === key && a.status === 'succeeded');
  assert.equal(attempts.length, 1, 'one succeeded attempt for the slot');
});
