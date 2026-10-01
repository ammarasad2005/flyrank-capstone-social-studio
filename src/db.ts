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
export type ExecFn = (sql: string) => Promise<void>;

export interface Db {
  query: QueryFn;
  /** Run fn inside a transaction; both query and script-exec are bound to it. */
  withTx: <T>(fn: (q: QueryFn, exec: ExecFn) => Promise<T>) => Promise<T>;
  /** Execute a multi-statement SQL script (used by the migrator). */
  exec: ExecFn;
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
    const withTx = async <T>(fn: (q: QueryFn, exec: ExecFn) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const q: QueryFn = (text, params) => client.query(text, params).then((r: any) => ({ rows: r.rows }));
        const exec: ExecFn = (sql) => client.query(sql).then(() => undefined);
        const out = await fn(q, exec);
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
  const withTx = async <T>(fn: (q: QueryFn, exec: ExecFn) => Promise<T>): Promise<T> =>
    pg.transaction(async (tx: any) => {
      const q: QueryFn = (text, params) => tx.query(text, params ?? []).then((r: any) => ({ rows: r.rows }));
      const exec: ExecFn = (sql) => tx.exec(sql).then(() => undefined);
      return fn(q, exec);
    });
  const exec = (sql: string) => pg.exec(sql).then(() => undefined);
  return { query, withTx, exec, close: () => pg.close() };
}

export async function migrate(db: Db): Promise<void> {
  const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  // A transaction-scoped advisory lock prevents multiple web/worker processes from
  // applying the same migration at once. DDL and its ledger entry commit atomically.
  await db.withTx(async (query, exec) => {
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', ['social-media-studio:migrations']);
    await exec(`CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const applied = new Set((await query('SELECT name FROM _migrations')).rows.map((row) => row.name));
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await exec(sql);
      await query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
    }
  });
}

// Initialise once at import time (top-level await) so importers get a ready DB.
export const db: Db = await createDb();
await migrate(db);
