// The durable-restart / crash-mid-publish probe. Simulates a worker that sent the post
// (attempt in_flight) then died, and verifies exactly-once on restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.SCHEDULER_ENABLED = 'false';
process.env.USE_AI = 'false';
process.env.PLATFORMS = 'mastodon,mock_x,mock_linkedin';

const repo = await import('../src/repo.js');
const { getAdapter } = await import('../src/adapters/index.js');
const { publishSlot } = await import('../src/publisher.js');

async function fixtureApprovedSlot(adapter = 'mock_x') {
  const post = await repo.insertPost({ source_type: 'markdown', title: 'Durable', content_md: '# Durable\n\nbody' });
  const variant = await repo.insertVariant({
    post_id: post.id, platform: 'mock_x', content: 'A durable little post about retries', status: 'approved',
  });
  const slot = await repo.insertSlot({ variant_id: variant.id, adapter, scheduled_at: new Date().toISOString() });
  return { post, variant, slot };
}

test('IDEMPOTENT adapter: crash after send, restart re-runs and does NOT double-post', async () => {
  const { variant, slot } = await fixtureApprovedSlot('mock_x');
  const key = `${variant.id}:${slot.id}`;

  await repo.setSlotStatus(slot.id, 'publishing');
  const a = await repo.insertPendingAttempt({ variant_id: variant.id, slot_id: slot.id, idempotency_key: key, adapter: 'mock_x' });
  await repo.markAttemptInFlight(a.id);
  await getAdapter('mock_x').publish({ idempotencyKey: key, variant });
  assert.equal((await repo.listMockPosts()).length, 1, 'pre-crash send created one mock post');
  assert.equal((await repo.findAttemptByKey(key))!.status, 'in_flight');

  const stuck = await repo.reclaimStuckSlots();
  assert.equal(stuck.length, 1);
  for (const s of stuck) await repo.setSlotStatus(s.id, 'pending');

  const out = await publishSlot(slot.id);

  assert.equal((await repo.listMockPosts()).length, 1, 'STILL exactly one mock post');
  assert.equal(out.reused, true);
  assert.equal((await repo.findAttemptByKey(key))!.status, 'succeeded');
  assert.equal((await repo.getSlot(slot.id))!.status, 'published');
});

test('NON-IDEMPOTENT adapter (telegram): an in-flight crash is NOT retried (no duplicate)', async () => {
  const { variant, slot } = await fixtureApprovedSlot('telegram');
  const key = `${variant.id}:${slot.id}`;

  await repo.setSlotStatus(slot.id, 'publishing');
  const a = await repo.insertPendingAttempt({ variant_id: variant.id, slot_id: slot.id, idempotency_key: key, adapter: 'telegram' });
  await repo.markAttemptInFlight(a.id);

  const out = await publishSlot(slot.id); // guard short-circuits — no network call

  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'uncertain');
  assert.equal((await repo.findAttemptByKey(key))!.status, 'uncertain');
});

test('plain duplicate publish calls also produce exactly one post', async () => {
  const { slot } = await fixtureApprovedSlot('mock_x');
  await publishSlot(slot.id);
  await publishSlot(slot.id);
  await publishSlot(slot.id);
  const key = `${slot.variant_id}:${slot.id}`;
  const attempts = (await repo.listAttempts()).filter((x: any) => x.idempotency_key === key && x.status === 'succeeded');
  assert.equal(attempts.length, 1);
});
