import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the real-Postgres concurrency check.');
}

const { db, migrate } = await import('../src/db.js');
const { claimDueSlot, insertPendingAttempt, insertPost, insertSlot, insertVariant } = await import('../src/repo.js');

const dueSlots = 8;
let postId: number | undefined;

try {
  // Importing db runs migrations once; the second run proves repeatability on a real PG.
  await migrate(db);
  const migrationRows = await db.query('SELECT name FROM _migrations ORDER BY name');
  assert.deepEqual(
    migrationRows.rows.map((row) => row.name),
    ['001_init.sql', '002_retry_dlq.sql'],
  );

  const post = await insertPost({
    source_type: 'markdown',
    title: 'Postgres concurrency smoke test',
    content_md: 'Disposable CI-only row; deleted before the check exits.',
  });
  postId = post.id;
  const variant = await insertVariant({
    post_id: post.id,
    platform: 'mock_x',
    content: 'concurrency smoke test',
    status: 'approved',
  });
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  const slots = [];
  for (let i = 0; i < dueSlots; i += 1) {
    slots.push(await insertSlot({ variant_id: variant.id, adapter: 'mock_x', scheduled_at: dueAt }));
  }

  // More concurrent claimers than rows force real, separate pg clients to contend.
  const claims = await Promise.all(
    Array.from({ length: dueSlots + 4 }, () => claimDueSlot()),
  );
  const claimed = claims.filter((slot) => slot !== null);
  const claimedIds = claimed.map((slot) => slot!.id);
  assert.equal(claimed.length, dueSlots, 'each due slot should be claimed exactly once');
  assert.equal(new Set(claimedIds).size, dueSlots, 'two claimers must not receive the same slot');
  assert.deepEqual(
    [...claimedIds].sort((a, b) => a - b),
    slots.map((slot) => slot.id).sort((a, b) => a - b),
  );
  assert.equal(claims.filter((slot) => slot === null).length, 4, 'extra claimers should find no due work');

  const key = `pg-ci:${post.id}:${slots[0].id}`;
  const reservation = {
    variant_id: variant.id,
    slot_id: slots[0].id,
    idempotency_key: key,
    adapter: 'mock_x',
  };
  const duplicateReservations = await Promise.all([
    insertPendingAttempt(reservation),
    insertPendingAttempt(reservation),
  ]);
  assert.equal(duplicateReservations[0].id, duplicateReservations[1].id, 'duplicate reservations must reuse one row');
  const storedAttempts = await db.query('SELECT id FROM publish_attempts WHERE idempotency_key = $1', [key]);
  assert.equal(storedAttempts.rows.length, 1, 'the unique key must prevent duplicate attempt rows');

  console.log(`Postgres checks passed: migrations rerun safely; ${dueSlots} due slots claimed once; duplicate attempt reused.`);
} finally {
  try {
    if (postId !== undefined) await db.query('DELETE FROM posts WHERE id = $1', [postId]);
  } finally {
    await db.close();
  }
}
