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
    ['001_init.sql', '002_retry_dlq.sql', '003_fk_indexes_and_updated_at.sql'],
  );

  const indexRows = await db.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('idx_attempts_slot', 'idx_attempts_variant', 'idx_slots_due', 'idx_slots_variant', 'idx_variants_post')
      ORDER BY indexname`,
  );
  assert.deepEqual(indexRows.rows.map((row) => row.indexname), [
    'idx_attempts_slot', 'idx_attempts_variant', 'idx_slots_due', 'idx_slots_variant', 'idx_variants_post',
  ]);

  const triggerRows = await db.query(
    `SELECT event_object_table, trigger_name FROM information_schema.triggers
      WHERE trigger_schema = 'public'
        AND trigger_name IN ('variants_set_updated_at', 'publish_attempts_set_updated_at')
      ORDER BY trigger_name`,
  );
  assert.deepEqual(triggerRows.rows, [
    { event_object_table: 'publish_attempts', trigger_name: 'publish_attempts_set_updated_at' },
    { event_object_table: 'variants', trigger_name: 'variants_set_updated_at' },
  ]);

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

  const stale = '2000-01-01T00:00:00.000Z';
  await db.query('UPDATE variants SET updated_at = $1 WHERE id = $2', [stale, variant.id]);
  await db.query('UPDATE publish_attempts SET updated_at = $1 WHERE id = $2', [stale, duplicateReservations[0].id]);
  const timestamps = await db.query(
    `SELECT v.updated_at AS variant_updated_at, a.updated_at AS attempt_updated_at
       FROM variants v CROSS JOIN publish_attempts a
      WHERE v.id = $1 AND a.id = $2`,
    [variant.id, duplicateReservations[0].id],
  );
  assert.ok(new Date(timestamps.rows[0].variant_updated_at).getTime() > Date.parse(stale), 'variant trigger must touch updated_at');
  assert.ok(new Date(timestamps.rows[0].attempt_updated_at).getTime() > Date.parse(stale), 'attempt trigger must touch updated_at');

  console.log(`Postgres checks passed: migration rerun/schema hygiene; ${dueSlots} due slots claimed once; duplicate reservation reused.`);
} finally {
  try {
    if (postId !== undefined) await db.query('DELETE FROM posts WHERE id = $1', [postId]);
  } finally {
    await db.close();
  }
}
