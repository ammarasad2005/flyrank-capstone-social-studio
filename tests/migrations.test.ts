import assert from 'node:assert/strict';
import test, { after } from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const { db, migrate } = await import('../src/db.js');

const expected = ['001_init.sql', '002_retry_dlq.sql', '003_fk_indexes_and_updated_at.sql'];

async function appliedMigrations(): Promise<string[]> {
  const { rows } = await db.query('SELECT name FROM _migrations ORDER BY name');
  return rows.map((row) => row.name);
}

test('versioned migrations apply in order and rerun safely', async () => {
  assert.deepEqual(await appliedMigrations(), expected);
  await migrate(db);
  assert.deepEqual(await appliedMigrations(), expected);

  const { rows: tables } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('posts', 'variants', 'slots', 'publish_attempts')
      ORDER BY table_name`,
  );
  assert.deepEqual(tables.map((row) => row.table_name), ['posts', 'publish_attempts', 'slots', 'variants']);

  const expectedIndexes = [
    'idx_attempts_slot',
    'idx_attempts_variant',
    'idx_slots_due',
    'idx_slots_variant',
    'idx_variants_post',
  ];
  const { rows: indexes } = await db.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('idx_attempts_slot', 'idx_attempts_variant', 'idx_slots_due', 'idx_slots_variant', 'idx_variants_post')
      ORDER BY indexname`,
  );
  assert.deepEqual(indexes.map((row) => row.indexname), expectedIndexes);

  const { rows: triggers } = await db.query(
    `SELECT event_object_table, trigger_name FROM information_schema.triggers
      WHERE trigger_schema = 'public'
        AND trigger_name IN ('variants_set_updated_at', 'publish_attempts_set_updated_at')
      ORDER BY trigger_name`,
  );
  assert.deepEqual(triggers, [
    { event_object_table: 'publish_attempts', trigger_name: 'publish_attempts_set_updated_at' },
    { event_object_table: 'variants', trigger_name: 'variants_set_updated_at' },
  ]);

  const { rows: posts } = await db.query(
    `INSERT INTO posts (source_type, title, content_md) VALUES ('markdown', 'trigger test', 'body') RETURNING id`,
  );
  const { rows: variants } = await db.query(
    `INSERT INTO variants (post_id, platform, content, status)
     VALUES ($1, 'mock_x', 'before', 'approved') RETURNING id`,
    [posts[0].id],
  );
  const { rows: slots } = await db.query(
    `INSERT INTO slots (variant_id, adapter, scheduled_at)
     VALUES ($1, 'mock_x', now()) RETURNING id`,
    [variants[0].id],
  );
  const { rows: attempts } = await db.query(
    `INSERT INTO publish_attempts (variant_id, slot_id, idempotency_key, adapter)
     VALUES ($1, $2, $3, 'mock_x') RETURNING id`,
    [variants[0].id, slots[0].id, `migration-trigger:${variants[0].id}:${slots[0].id}`],
  );

  const stale = '2000-01-01T00:00:00.000Z';
  await db.query('UPDATE variants SET content = $1, updated_at = $2 WHERE id = $3', ['after', stale, variants[0].id]);
  await db.query('UPDATE publish_attempts SET status = $1, updated_at = $2 WHERE id = $3', ['in_flight', stale, attempts[0].id]);
  const { rows: updated } = await db.query(
    `SELECT v.updated_at AS variant_updated_at, a.updated_at AS attempt_updated_at
       FROM variants v CROSS JOIN publish_attempts a
      WHERE v.id = $1 AND a.id = $2`,
    [variants[0].id, attempts[0].id],
  );
  assert.ok(new Date(updated[0].variant_updated_at).getTime() > Date.parse(stale), 'variant trigger refreshes updated_at');
  assert.ok(new Date(updated[0].attempt_updated_at).getTime() > Date.parse(stale), 'attempt trigger refreshes updated_at');
});

after(async () => db.close());
