# ADR 0002 — Pluggable queue driver, with retry/backoff/dead-letter as DB domain logic

Status: Accepted · Sprint 2 (T0-B, T0-D)

## Context

Sprint 1 shipped a durable, DB-backed in-process scheduler: an atomic
`claimDueSlot()` (`FOR UPDATE SKIP LOCKED`) plus an idempotency key made publishing
exactly-once and multi-worker-safe. Two gaps remained for a production posture:

1. **Failure handling.** A failed send just marked the slot `failed` and stopped.
   There was no retry, no backoff, and no place for permanently-failing work to land.
2. **Scale.** A single in-process poller is fine for one web dyno, but there was no
   path to a horizontally-scaled worker fleet with a real broker.

We also wanted the environment boundary hardened (a typo in `PLATFORMS` or a missing
`REDIS_URL` should fail loudly at boot, not deep in a request).

## Decision

**1. A `PublishQueue` abstraction with two interchangeable drivers.**
`src/queue/{types,inprocess,bull}.ts` implement `{ start(); stop() }`.
- `inprocess` (default): the Sprint-1 poller, refactored behind the interface.
  No broker; runs and is fully tested anywhere. Multiple processes stay safe via
  `SKIP LOCKED`.
- `bull`: BullMQ over Redis (Upstash). A repeatable *scan* job claims due slots with
  the **same** SKIP-LOCKED query and enqueues one *slot* job each; the worker runs
  every slot through the shared `processSlot()`.

`QUEUE_DRIVER` picks the driver; `bull.ts` is imported lazily so nothing touches
Redis unless it's actually selected. `src/worker.ts` is a standalone entrypoint so
the queue can scale independently of the web process.

**2. Retry/backoff/dead-letter live in the database, not in the broker.**
Migration `002_retry_dlq.sql` adds `attempts`, `next_attempt_at`, `last_error` to
`slots` and a `dead_letter` status. `repo.recordSlotFailure()` bumps `attempts` and
either reschedules with exponential backoff + jitter (`next_attempt_at = now() +
base·2^(n-1)`, capped) or dead-letters at the max, all inside one transaction.
`claimDueSlot()` filters on `next_attempt_at`, so the backoff window is enforced by
the same query for both drivers.

This is deliberately **engine-agnostic** rather than using BullMQ-native retries:
the retry semantics are identical no matter which driver runs, and — crucially — the
whole failure model is unit-testable on PGlite with **no broker at all**.

**3. `processSlot()` owns the state machine.** `publishSlot()` now only records
history and throws on failure; `processSlot()` translates that into slot state
(published / retry_scheduled / dead_letter). At-most-once adapters whose outcome is
*uncertain* after a crash are dead-lettered immediately — never retried — because a
retry could double-post.

**4. Config validated with zod (`T0-D`).** `src/config.ts` parses `process.env`
through a schema that coerces types and applies defaults; invalid config throws a
readable error at boot (including `QUEUE_DRIVER=bull` with no `REDIS_URL`).

## Consequences

- One retry/DLQ model, two drivers, identical behaviour; the scary paths
  (retry→dead-letter, uncertain crash) are covered by offline tests.
- Prod stays on `inprocess` (already multi-worker-safe). Switching to `bull` needs
  only a `rediss://` endpoint and `npm run worker` — no code change.
- BullMQ isn't exercised in CI (no Redis in the sandbox); it's validated by
  `tsc`. The in-process driver carries the test suite.
- **Upstash caveat:** BullMQ/ioredis need the Redis **TCP/TLS** endpoint
  (`rediss://…:6379`), *not* the REST URL/token used by `@upstash/redis`.
