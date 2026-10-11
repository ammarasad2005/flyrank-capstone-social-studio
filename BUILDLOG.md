# BUILDLOG — honest AI-usage log

This capstone was built with an AI coding assistant. This log records where AI genuinely
helped, where it was wrong or unhelpful, and what I decided myself. The point of the
capstone is judgement, so here is the honest version.

## Where AI helped

- **Boilerplate & shape.** Express routers, the SQLite schema, and the repo layer were
  drafted fast with AI. Straightforward and mostly correct on the first pass.
- **Getting the idempotency argument crisp.** AI was useful as a sounding board for
  *why* the two-layer design (UNIQUE app-key + adapter-native dedupe) is safe against a
  crash *between* the network send and the DB commit. Talking it through is what led to
  the durable-restart test that actually simulates that exact window.
- **Docs.** The README architecture diagram and the constraint/idempotency tables were
  drafted with AI, then trimmed by hand to match what the code actually does.

## Where AI was wrong or I overrode it

- **First idempotency sketch was too weak.** The initial version only checked "is there a
  succeeded attempt?" at the app layer. That does **not** survive a crash after the send
  but before the commit — the retry would post again. I pushed back and added the
  adapter-level guarantee (Mastodon's `Idempotency-Key` header; UNIQUE `mock_posts` key)
  so both layers are idempotent. Only then does exactly-once actually hold.
- **`mock_posts.created` detection.** The mock's first draft tried to infer "was this a
  duplicate?" with an awkward sentinel. I replaced it with the honest signal — the SQLite
  `INSERT OR IGNORE` `changes` count (`created: info.changes === 1`).
- **better-sqlite3 booleans.** AI wanted to bind JS booleans directly; SQLite doesn't have
  a boolean type in better-sqlite3, so statuses are TEXT enums instead — cleaner anyway.
- **Docker/Redis stack.** An early suggestion assumed a Redis-backed queue. The target
  environment has no Docker/Redis, so I kept everything in-process on SQLite with an
  atomic-claim scheduler. This is a real limitation (single node) and is stated in the
  README rather than hidden.
- **AI variant generation is optional on purpose.** AI proposed making generation the
  centrepiece. But the *graded* property is enforcement, not authorship — a bad AI variant
  must still be blocked. So generation defaults to deterministic templates; Gemini is an
  opt-in (`USE_AI=true`) that flows through the exact same validation gate.

## Decisions I made myself

- The four-table model (`posts / variants / slots / publish_attempts`) plus `mock_posts`,
  and the `variant:slot` idempotency key.
- The `SocialPublisher` seam and the `ADAPTER_OVERRIDE` swap mechanism, so PROBE 6 is a
  pure config change.
- Phased commits, each phase runnable and verified before the next (see git history):
  Phase 1 design + scaffold → Phase 2 ingest + generate → Phase 3 review + schedule →
  Phase 4 adapters + idempotent publish → Phase 5 durable scheduler + tests + docs.
- Writing the crash-restart test to simulate the precise failure window rather than a
  vague "call it twice" — that's the test that actually proves durability.

## Late change: Telegram as the real target

I'd built Mastodon as the real target first, but couldn't create an account (sign-ups were
closed on the instances I could reach). Rather than fake PROBE 4, I added a real
**Telegram** Bot API adapter — which surfaced a genuinely interesting problem the AI's first
idempotency design had glossed over: **Telegram's `sendMessage` has no idempotency key.**
So "just retry on restart" would double-post. I added a claim-before-send `in_flight` state
and made the orchestrator adapter-aware: idempotent targets (Mastodon/mocks) are safely
re-sent, non-idempotent ones (Telegram) are refused and flagged `uncertain` rather than
risked. Both paths are now tested. Mastodon stayed in as a second real adapter — which is
exactly the point of the seam.

## Sprint 4 — CI, security, and migration safety

- AI helped set up ESLint, CI jobs, Dependabot, Gitleaks, a disposable PostgreSQL test, and
  the migration runbook. I kept the checks aligned with the actual Render/Neon deployment.
- The migration runner was strengthened to apply DDL and ledger updates in one transaction
  under a transaction-scoped advisory lock. A real-Postgres test now checks repeatable
  migrations, concurrent due-slot claims, and duplicate idempotency reservations.
- I kept the existing parameterized SQL repository and small SQL migrator rather than
  introducing Drizzle/Prisma solely for this sprint. That is an explicit deviation from the
  suggested ORM path, not a claim that the ORM checkbox is complete.
- A review assistant incorrectly said the repository had no real-Postgres code path. I
  inspected `src/db.ts`: it already supported `pg` and boot migrations; the actual gap was
  connecting production to Neon and testing the concurrent path. I corrected the workplan.
- The production secrets remain in Render, not the public repository. Staging is deferred by
  owner decision; PR checks are not described as a staging environment.

## Sprint 5 — Database integrity and queue durability

- Added migration 003 for the two remaining current-schema foreign-key indexes and database-enforced `updated_at` triggers on variants and publish attempts. PGlite and real-Postgres checks cover migration reruns, index/trigger presence, and timestamp updates.
- Added a disposable PostgreSQL + Redis CI drill that hard-kills a BullMQ worker after the idempotent mock target records its post, then restarts the worker and verifies exactly one mock post and a succeeded slot. The crash failpoint is test-only; the harness refuses non-loopback DB/Redis endpoints, requires an explicit disposable-queue reset flag, and blanks external adapters and alert integrations.
- Local lint, typecheck, the 17-test PGlite suite, audit, and actionlint pass. The disposable real-service drill is configured as a required PR CI step because the local sandbox has no PostgreSQL/Redis services.

## Sprint 6 — Observability closeout (in progress)

- Re-evaluated staging on 2026-10-02. It remains deferred for this solo capstone: there is no customer data, each PR now tests disposable real Postgres/Redis, and a staging copy would duplicate DB/queue state, secrets, alert routing, and compute. Render's native PR previews are Pro-only and billable; revisit before onboarding or after a production incident.
- Added Sentry producer and consumer spans around the BullMQ hop, using W3C trace context and OpenTelemetry messaging attributes. Each job carries `sentry-trace`, `baggage`, and `traceparent`; producer/consumer logs share a trace id. A test verifies the trace survives JSON serialization. The recurring DB scan is the trace root because publishing is asynchronous from scheduling HTTP.
- Added an offline forced-failure drill: credential-less Telegram throws before platform fetch, while PGlite, an in-memory Sentry transport, and a webhook stub verify retries, dead-letter metrics, Sentry capture, and alert payload without external network calls.
- Added an importable Grafana reliability dashboard and setup instructions. Corrected success/error-rate PromQL for low traffic and no-traffic windows.
- Added optional Bearer protection for `/metrics` (minimum 32-character token, timing-safe comparison) because Grafana Cloud's Metrics Endpoint setup requires scrape credentials. The production token remains unset; no production environment was changed.
- Added `observability/prometheus/alerts.yml` for direct Grafana rule import and a step-by-step owner-to-agent handoff handbook covering merge/deploy ordering, token setup, scrape, dashboard, alerts, safe tests, and the non-secret handoff packet.
- Hosted Grafana scrape/dashboard provisioning and a live external Sentry/Slack event remain unverified because no Grafana account/API access or approved live test target is available. `SENTRY_TRACES_SAMPLE_RATE` remains opt-in at 0; no production environment was changed.

## Next planned work

- Complete C6 once Grafana Cloud access is available: configure the hosted `/metrics` scrape, import the dashboard/alerts, and verify a live failure alert in an approved test channel.
- The full HTTP suite against PostgreSQL remains optional unless the grading rubric requires it. Then start Tier 1-A: organizations, memberships, row-level data isolation, and negative cross-tenant tests before adding customer-facing auth or accounts.
