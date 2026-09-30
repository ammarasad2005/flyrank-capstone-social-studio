-- Initial schema (Postgres). Ported from the SQLite capstone schema.
-- The stored post is the single source of truth; everything hangs off it.

CREATE TABLE posts (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_type text NOT NULL CHECK (source_type IN ('url','markdown')),
  source_url  text,
  title       text NOT NULL,
  content_md  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE variants (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id          integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  platform         text NOT NULL,
  content          text NOT NULL,
  hashtags         text NOT NULL DEFAULT '[]',   -- JSON array
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','approved','rejected','published')),
  rejection_reason text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE slots (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id   integer NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  adapter      text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','publishing','published','failed','canceled')),
  claimed_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Publish history AND the idempotency guard in one table.
-- UNIQUE idempotency_key makes a second successful publish for a variant+slot impossible.
CREATE TABLE publish_attempts (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id      integer NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  slot_id         integer NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  adapter         text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_flight','succeeded','failed','uncertain')),
  external_id     text,
  external_url    text,
  preview         text,
  error           text,
  attempt_no      integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Mock adapters' own idempotent store (UNIQUE idempotency_key = one post per key).
CREATE TABLE mock_posts (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  adapter         text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_variants_post ON variants(post_id);
CREATE INDEX idx_slots_due     ON slots(status, scheduled_at);
CREATE INDEX idx_attempts_slot ON publish_attempts(slot_id);
