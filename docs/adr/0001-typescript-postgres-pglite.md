# ADR 0001 — TypeScript + Postgres (PGlite dev, node-postgres prod)

**Status:** accepted · **Date:** 2026-09 · **Sprint:** Tier 0 (T0-A, F1)

## Context

The capstone used plain JavaScript + SQLite (`better-sqlite3`) with an in-process
scheduler. SQLite is single-writer and single-process, which caps us at one worker and
gives no HA/backups — the Tier 0 goal is to make the same features production-safe.

## Decision

1. **TypeScript** across `src/` and `tests/` (F1). Runtime via `tsx` (no build step needed
   for now); `tsc --noEmit` is the type gate in CI.
2. **Postgres** everywhere (T0-A), selected at runtime by env:
   - `DATABASE_URL` set → **node-postgres** pool (Neon / Supabase / RDS) for production.
   - otherwise → **PGlite**, an in-process WASM Postgres, for local/dev/test/demo.
   Both speak identical Postgres SQL, so the concurrent claim and idempotency behave the
   same in tests and prod.
3. The slot claim moves to **`FOR UPDATE SKIP LOCKED`**, which is what unlocks running
   **multiple workers** without double-publishing.
4. Migrations are plain, ordered `.sql` files applied by a tiny idempotent migrator on
   boot (recorded in `_migrations`). Driver-agnostic and reviewable.

## Consequences

- Tests run fast and hermetically on PGlite (`:memory:`, isolated per file) — no external
  Postgres needed in CI — while prod uses a real managed Postgres via one env var.
- The repo layer became `async`; routes/publisher/scheduler now await it.
- **Follow-up:** add a CI job that runs a dedicated concurrency test against a real
  networked Postgres service to validate multi-connection `SKIP LOCKED` contention (PGlite
  is single-connection, so it validates the claim *logic*, not true contention).
- An ORM (e.g. Drizzle) can be layered on later for typed queries; raw parameterized SQL
  was chosen now to keep the port small and the SQL explicit.
