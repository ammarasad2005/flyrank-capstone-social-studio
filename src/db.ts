// Database driver abstraction + a tiny migrator.
//
// One interface, two backends chosen by env:
//   • DATABASE_URL set  -> node-postgres (Neon / Supabase / RDS)  [production]
//   • otherwise         -> PGlite, an in-process Postgres (WASM)  [local / tests / demo]
//
// Both speak the SAME Postgres SQL, so the concurrent claim (FOR UPDATE SKIP LOCKED)
// and idempotency (ON CONFLICT / UNIQUE) behave identically. This is the T0-A cutover:
// SQLite is gone; everything is Postgres.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface QueryResult {
  rows: any[];
}
export type QueryFn = (text: string, params?: any[]) => Promise<QueryResult>;

export interface Db {
  query: QueryFn;
  /** Run fn inside a transaction; the passed query fn is bound to that transaction. */
  withTx: <T>(fn: (q: QueryFn) => Promise<T>) => Promise<T>;
  /** Execute a multi-statement SQL script (used by the migrator). */
  exec: (sql: string) => Promise<void>;
  close: () => Promise<void>;
}

async function createDb(): Promise<Db> {
  if (process.env.DATABASE_URL) {
    // ---- production: node-postgres ----
    const pgMod = await import('pg');
    const pg = (pgMod as any).default ?? pgMod;
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 10),
      ssl: process.env.PGSSL === 'disable' ? undefined : { rejectUnauthorized: false },
    });
    const query: QueryFn = (text, params) => pool.query(text, params).then((r: any) => ({ rows: r.rows }));
    const withTx = async <T>(fn: (q: QueryFn) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const q: QueryFn = (text, params) => client.query(text, params).then((r: any) => ({ rows: r.rows }));
        const out = await fn(q);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    };
    const exec = (sql: string) => pool.query(sql).then(() => undefined);
    return { query, withTx, exec, close: () => pool.end() };
  }

  // ---- local / tests / demo: PGlite (in-process Postgres) ----
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.DATABASE_PATH || 'data/pg';
  const pg: any = dir === ':memory:' ? new PGlite() : new PGlite(dir);
  await pg.waitReady;
  const query: QueryFn = (text, params) => pg.query(text, params ?? []).then((r: any) => ({ rows: r.rows }));
  const withTx = async <T>(fn: (q: QueryFn) => Promise<T>): Promise<T> =>
    pg.transaction(async (tx: any) => {
      const q: QueryFn = (text, params) => tx.query(text, params ?? []).then((r: any) => ({ rows: r.rows }));
      return fn(q);
    });
  const exec = (sql: string) => pg.exec(sql).then(() => undefined);
  return { query, withTx, exec, close: () => pg.close() };
}

async function migrate(db: Db): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await db.query('SELECT name FROM _migrations')).rows.map((r) => r.name));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await db.exec(sql);
    await db.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
  }
}

// Initialise once at import time (top-level await) so importers get a ready DB.
export const db: Db = await createDb();
await migrate(db);
