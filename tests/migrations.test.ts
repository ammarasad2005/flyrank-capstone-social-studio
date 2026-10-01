import assert from 'node:assert/strict';
import test, { after } from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const { db, migrate } = await import('../src/db.js');

const expected = ['001_init.sql', '002_retry_dlq.sql'];

async function appliedMigrations(): Promise<string[]> {
  const { rows } = await db.query('SELECT name FROM _migrations ORDER BY name');
  return rows.map((row) => row.name);
}

test('versioned migrations apply in order and rerun safely', async () => {
  assert.deepEqual(await appliedMigrations(), expected);
  await migrate(db);
  assert.deepEqual(await appliedMigrations(), expected);

  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('posts', 'variants', 'slots', 'publish_attempts')
      ORDER BY table_name`,
  );
  assert.deepEqual(rows.map((row) => row.table_name), ['posts', 'publish_attempts', 'slots', 'variants']);
});

after(async () => db.close());
