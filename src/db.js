import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DATABASE_PATH || 'data/studio.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // durability + concurrent reads
db.pragma('foreign_keys = ON');

// ── Schema ───────────────────────────────────────────────────────────────────
// The stored post is the single source of truth. Everything hangs off it.
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL CHECK (source_type IN ('url','markdown')),
    source_url  TEXT,
    title       TEXT NOT NULL,
    content_md  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS variants (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id          INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    platform         TEXT NOT NULL,
    content          TEXT NOT NULL,
    hashtags         TEXT NOT NULL DEFAULT '[]',   -- JSON array
    status           TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','approved','rejected','published')),
    rejection_reason TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS slots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    variant_id    INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
    adapter       TEXT NOT NULL,
    scheduled_at  TEXT NOT NULL,                    -- ISO 8601 UTC
    status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','publishing','published','failed','canceled')),
    claimed_at    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Publish history AND the idempotency guard in one table.
  -- The UNIQUE idempotency_key makes a second successful publish for the same
  -- variant+slot impossible at the database layer.
  CREATE TABLE IF NOT EXISTS publish_attempts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    variant_id      INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
    slot_id         INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL UNIQUE,
    adapter         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','succeeded','failed')),
    external_id     TEXT,
    external_url    TEXT,
    preview         TEXT,
    error           TEXT,
    attempt_no      INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_variants_post   ON variants(post_id);
  CREATE INDEX IF NOT EXISTS idx_slots_due       ON slots(status, scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_attempts_slot   ON publish_attempts(slot_id);
`);

export default db;
