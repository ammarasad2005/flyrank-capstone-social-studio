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

const repo = await import('../src/repo.js');
const { getAdapter } = await import('../src/adapters/index.js');
const { publishSlot } = await import('../src/publisher.js');

function fixtureApprovedSlot() {
  const post = repo.insertPost({ source_type: 'markdown', title: 'Durable', content_md: '# Durable\n\nbody' });
  const variant = repo.insertVariant({
    post_id: post.id, platform: 'mock_x', content: 'A durable little post about retries', status: 'approved',
  });
  const slot = repo.insertSlot({
    variant_id: variant.id, adapter: 'mock_x', scheduled_at: new Date().toISOString(),
  });
  return { post, variant, slot };
}

test('crash after send, before commit: restart re-runs and does NOT double-post', async () => {
  const { variant, slot } = fixtureApprovedSlot();
  const key = `${variant.id}:${slot.id}`;

  // ---- simulate the crashed worker's partial state ----
  repo.setSlotStatus(slot.id, 'publishing');                 // claimed
  repo.insertPendingAttempt({ variant_id: variant.id, slot_id: slot.id, idempotency_key: key, adapter: 'mock_x' });
  // the network call had already landed at the target:
  await getAdapter('mock_x').publish({ idempotencyKey: key, variant });
  assert.equal(repo.listMockPosts().length, 1, 'the pre-crash send created one mock post');
  assert.equal(repo.findAttemptByKey(key).status, 'pending', 'attempt not yet recorded as done');

  // ---- restart: the scheduler reclaims 'publishing' -> 'pending' and re-runs ----
  const stuck = repo.reclaimStuckSlots();
  assert.equal(stuck.length, 1, 'one stuck slot found on restart');
  for (const s of stuck) repo.setSlotStatus(s.id, 'pending');

  const out = await publishSlot(slot.id);

  // ---- exactly-once guarantees ----
  assert.equal(repo.listMockPosts().length, 1, 'STILL exactly one mock post (no duplicate)');
  assert.equal(out.reused, true, 're-run recognised the target already had the post');
  assert.equal(repo.findAttemptByKey(key).status, 'succeeded', 'attempt converged to succeeded');
  assert.equal(repo.getSlot(slot.id).status, 'published', 'slot converged to published');
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
