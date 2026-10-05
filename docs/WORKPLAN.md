# Social Media Studio — Implementation Workplan (Tier 0 → Tier 2)

A thorough, trackable plan to take the current capstone to a production, multi-tenant,
multi-platform product. **Tier 3 (hyperscale/enterprise) is intentionally out of scope** for
this delivery and parked in `PRODUCTION-ROADMAP.md` as later improvisation.

- **Scope of this plan:** Tier 0 (harden the core), Tier 1 (multi-user SaaS + real platforms),
  Tier 2 (product depth).
- **How to read it:** each Tier → **Epics** → **numbered tasks** with checkboxes. Every epic
  has an Objective, Deliverables, Acceptance Criteria, Dependencies, and an Effort size.
- **Effort sizes:** S ≈ 1–2 days · M ≈ 3–5 days · L ≈ 1–2 weeks · XL ≈ 3–4 weeks (assume 1–3
  engineers; a solo builder should read the calendar as ~2–3× longer).
- **Indicative calendar (small team):** Tier 0 ≈ 4 weeks · Tier 1 ≈ 8–10 weeks · Tier 2 ≈
  6–8 weeks. Total ≈ **4.5–5.5 months**.

---

## 0. Foundational conventions (do first, applies to everything)

These are cheap and prevent rework across all tiers.

- [x] **F1 — Adopt TypeScript.** `src/`, `tests/`, and CI scripts are TypeScript; `tsc --noEmit` is a gate.
- [x] **F2 — Definition of Done:** PRs run lint, typecheck, tests, audit, secret scan, and real-Postgres checks; docs/evidence are updated. Direct pushes to `main` are blocked by branch protection.
- [~] **F3 — Branching & commits:** short-lived PR branches and phased conventional commits are used. Merge commits are retained to preserve the phased history rather than squash-merged.
- [~] **F4 — Environments:** local + prod are active. Staging was re-evaluated (2026-10-02) and remains deferred: this solo capstone has no onboarded customer data, while each PR runs disposable real-Postgres/Redis validation. Render's native PR preview environments require Pro and are separately billed; a persistent staging service would also need isolated DB, queue, secrets, and alert routing. Revisit before customer-data onboarding or if production risk materially changes; PR checks are not a staging environment.
- [x] **F5 — Architecture Decision Records** (`docs/adr/`): key choices are recorded in ADRs 0001–0005; new major choices need an ADR.

---

# TIER 0 — Harden the core (make the current design production-safe)

*Objective: same feature set, but operable, observable, and safe to run for money. ~4 weeks.*

## Epic T0-A — Postgres + migrations + concurrent claim
**Objective:** replace SQLite with Postgres and make the claim safe for N workers.
**Effort: L**

- [x] A1. Neon pooled Postgres selected and in production (`DATABASE_URL`); decision in ADR-0001.
- [~] A2. Ordered SQL migrations are implemented and now atomic/serialized, but the project deliberately keeps the small raw-SQL migrator instead of Drizzle/Prisma; see ADR-0004.
- [x] A3. Repository uses async `pg` in production (PGlite locally/tests).
- [x] A4. Due-slot claims use `FOR UPDATE SKIP LOCKED`; a real-Postgres multi-claimer test runs in CI.
- [x] A5. UNIQUE idempotency keys and `ON CONFLICT DO NOTHING` remain in place; the real-Postgres CI smoke test verifies duplicate reservation reuse.
- [x] A6. `timestamptz`, CHECK constraints, indexes for every current FK, and `updated_at` triggers on mutable timestamped tables are covered by migration 003 and tests.

**Acceptance status:** the HTTP/unit suite remains hermetic on PGlite. Disposable real-Postgres CI verifies migration reruns, current FK indexes and timestamp triggers, concurrent claims, and duplicate attempt reservation; a real-Redis/real-Postgres job also hard-kills a BullMQ worker after a mock send and verifies restart recovery without a duplicate. Running the entire HTTP suite against PostgreSQL remains a follow-up if the rubric requires it.
**Depends on:** F1.

## Epic T0-B — Separate, scalable worker + real job engine
**Objective:** the scheduler is its own service with retries, backoff, and visibility.
**Effort: L**

- [x] B1. Extract the scheduler into a standalone worker entrypoint (`src/worker.ts`,
  `npm run worker`) deployable independently from the API; the web process runs the queue
  inline only for the default in-process driver.
- [x] B2. Engine chosen (ADR-0002): **BullMQ on Upstash Redis**, behind a `PublishQueue`
  abstraction with `QUEUE_DRIVER=inprocess|bull` so the engine is swappable. Inngest remains a
  fallback if issues arise.
- [x] B3. Publishing modelled as jobs: a repeatable "scan due slots" job enqueues per-slot
  jobs; the shared `processSlot()` (wrapping `publishSlot()`) is the handler for both drivers.
- [x] B4. **Retry policy:** exponential backoff + jitter (`RETRY_BASE_MS·2^(n-1)`, capped),
  `RETRY_MAX_ATTEMPTS`, per-attempt rows in `publish_attempts`. Implemented as DB domain logic
  (`repo.recordSlotFailure`) so both drivers share one model; tested on PGlite (no broker).
- [x] B5. **Dead-letter** state on `slots` (`dead_letter`, never re-claimed) + alert on arrival
  (`src/notify.ts`: log + optional `ALERT_WEBHOOK_URL`). Uncertain non-idempotent sends are
  dead-lettered immediately (no retry).
- [x] B6. **Graceful shutdown:** SIGTERM/SIGINT stop the poller/worker and close the queue
  cleanly in both `src/server.ts` and `src/worker.ts`.

**Acceptance:** a disposable real-Postgres/Redis CI test hard-kills the BullMQ worker after an idempotent mock send commits, then verifies startup recovery finishes the slot with exactly one mock post. The existing domain tests cover retry/backoff/dead-letter decisions; the external alert drill remains in T0-C.
**Depends on:** T0-A.

## Epic T0-C — Observability & operability
**Objective:** you can see, debug, and alert on the system. **Effort: M**

- [x] C1. Structured logging with **pino** (`src/observability/logger.ts`): JSON logs, a
  generated/propagated `x-request-id` per request (pino-http), and slot/adapter/outcome on
  publish events. `org id` deferred to T1.
- [x] C2. **Sentry** error tracking (`src/observability/sentry.ts`), wired into the Express
  error handler and processSlot() dead-letters. Optional: active only when `SENTRY_DSN` is set
  (safe no-op otherwise), so it runs in API and worker alike.
- [x] C3. Metrics via **prom-client** at `GET /metrics` (Prometheus text; scrapeable by
  Grafana Cloud / Better Stack): publish success rate & outcome, adapter latency
  (`publish_duration_seconds`), retries, dead-letter arrivals, queue depth (`slots_pending`),
  HTTP latency. The endpoint supports an optional 32+ character Bearer token for hosted
  scraping. (Chose a self-contained /metrics endpoint over a full OTel collector to fit the
  free tier — see ADR-0003.)
- [x] C4. Full cross-queue correlation: BullMQ producer spans inject Sentry `sentry-trace`,
  `baggage`, and W3C `traceparent` into slot-job data; worker spans resume the carrier, and
  producer/consumer logs include the same trace id. A test verifies correlation across a
  serialization boundary. The periodic DB scan is the root because slot publishing is
  decoupled from the original scheduling HTTP request; `SENTRY_TRACES_SAMPLE_RATE` controls
  whether Sentry retains spans.
- [x] C5. `/health` (liveness) + `/ready` (readiness: DB always, Redis when QUEUE_DRIVER=bull)
  returning 503 + a per-check breakdown; documented for the deploy platform.
- [~] C6. Alerting rules authored and corrected for low/no-traffic windows (`observability/prometheus/alerts.yml`, documented in `docs/OBSERVABILITY.md`); the importable Grafana dashboard is `observability/grafana/social-media-studio.json`. A safe offline failure drill proves retries → DLQ → Sentry transport + webhook stub. The owner-to-agent setup sequence is `docs/GRAFANA-CLOUD-HANDOFF-HANDBOOK.md`. Hosted scrape/dashboard import and live external Sentry/Slack delivery remain pending Grafana access, owner configuration of the optional `/metrics` Bearer token, and an approved test target.

**Acceptance:** a forced adapter failure shows up in Sentry + a dashboard + an alert.
**Current status:** Sentry and Slack are configured in Render; a Sentry capture-path smoke was sent and the webhook accepted a setup notification. Sprint 6 adds and tests queue trace propagation and an offline retry → DLQ → Sentry/webhook-stub path. No hosted Grafana account/API access or designated live alert target is available in this workspace, and the optional `/metrics` Bearer token is not configured in production, so external dashboard provisioning and live event delivery remain unverified.
**Depends on:** T0-A (ids), T0-B (queue metrics).

## Epic T0-D — CI/CD + config + secrets hygiene
**Objective:** safe, automated delivery. **Effort: M**

- [x] D1. CI runs lint, `tsc`, PGlite tests, `npm audit`, Gitleaks, disposable real-Postgres migration/claim/idempotency checks, and a disposable real-Postgres/Redis BullMQ restart-recovery test. `main` requires all three checks on PRs; direct pushes and admin bypass are blocked.
- [~] D2. **Reaffirmed after review (2026-10-02):** no persistent staging service/manual promote for this capstone. Disposable real-Postgres/Redis CI is the current pre-merge environment; `main` auto-deploys to prod. Revisit before customer-data onboarding or if production risk materially changes.
- [x] D3. **Config validation** with **zod** (`src/config.ts`) — coerces types, applies defaults, and fails fast at boot on invalid env.
- [x] D4. Production credentials are stored as Render service-scoped environment variables; rotation is documented in `docs/SECRETS-ROTATION.md`.
- [x] D5. Startup migrations are transactionally applied under an advisory lock; real-Postgres CI verifies migration reruns, schema hygiene, concurrent claims, idempotency reservations, and BullMQ restart recovery against disposable Redis. Recovery/expand-contract policy is in `docs/RELEASES.md`.

**Acceptance:** required PR checks block merge. Staging promotion remains deferred; migrations are applied automatically during service startup before the listener opens.
**Depends on:** F1, T0-A.

> **Tier 0 exit criteria:** Postgres-backed, multi-worker, retrying, observable service with CI/CD
> and all capstone probes green. This is "operable with the same features."
>
> **Current status:** Sprint 5's A6 migration/PGlite coverage and real BullMQ crash-recovery check passed with the required PR #10 CI checks (`build-test`, `postgres-concurrency`, and `gitleaks`). Sprint 6 implements and locally tests queue trace propagation, corrected alert expressions, an importable Grafana dashboard, and a safe offline failure drill; PR #11's `build-test`, `postgres-concurrency`, and `gitleaks` checks passed on implementation commit `2198a06`. Tier 0 remains open until the hosted scrape/dashboard is provisioned and a live Sentry/Slack alert is verified with an approved target. The raw-SQL migrator is an accepted ADR-0004 deviation; D2/F4 staging remains deferred after the 2026-10-02 review.

---

# TIER 1 — Multi-user SaaS + real platforms

*Objective: multiple customers, their own connected accounts, real networks. ~8–10 weeks.*
*This is the largest tier; sequence tenancy → auth → accounts → adapters → media.*

## Epic T1-A — Multi-tenancy (do this before customer data exists)
**Objective:** hard data isolation between organizations. **Effort: L**

- [ ] A1. Schema: add `organizations`, `users`, `memberships(org_id,user_id,role)`. Add
  `org_id` (FK) to `posts`, `variants`, `slots`, `publish_attempts`, and connected accounts.
- [ ] A2. Enforce isolation: **Postgres Row-Level Security** keyed on a per-request
  `app.current_org`, *and/or* a mandatory `org_id` filter in every repo query (belt + braces).
- [ ] A3. Migration/backfill plan for existing rows (assign to a default org).
- [ ] A4. Tenancy tests: org A can never read/act on org B's rows (negative tests).

**Acceptance:** a cross-tenant access attempt is denied at the DB layer; all queries scoped.
**Depends on:** T0-A.

## Epic T1-B — AuthN + AuthZ + audit
**Objective:** real users, roles mapped to the review workflow, full auditability.
**Effort: L**

- [ ] B1. Auth provider (ADR): **Clerk or WorkOS** (orgs/teams built-in, fastest) *or*
  self-hosted (Lucia + oslo) if avoiding vendor lock-in. SSO/SAML is a Tier-3 concern.
- [ ] B2. Roles: `viewer`, `author`, `reviewer/approver`, `admin`. Map to endpoints:
  authors create/edit variants; only reviewers `approve`/`reject`; only reviewers+ schedule.
- [ ] B3. Authorization middleware on every route (org membership + role check).
- [ ] B4. **API keys** for programmatic access (per-org, scoped, revocable).
- [ ] B5. **Audit log** table + middleware: who did what (approve/edit/schedule/publish/connect),
  when, from where. Immutable, queryable.

**Acceptance:** an `author` gets 403 on approve; every state change appears in the audit log.
**Depends on:** T1-A.

## Epic T1-C — Connected accounts + OAuth token lifecycle
**Objective:** each org connects its own social accounts; tokens are encrypted and refreshed.
**This is the pivotal shift from the capstone's single global credential.** **Effort: XL**

- [ ] C1. Schema: `connected_accounts(id, org_id, platform, external_account_id, display_name,
  access_token_enc, refresh_token_enc, scopes, expires_at, status)`.
- [ ] C2. **Encrypt tokens at rest** — libsodium sealed boxes or AWS KMS envelope encryption;
  keys in the secrets manager, never in the DB.
- [ ] C3. OAuth connect flows (per platform): authorize → callback → store tokens; handle PKCE
  where required.
- [ ] C4. **Token lifecycle:** proactive refresh before expiry, handle revocation/expiry
  gracefully (mark account `needs_reauth`, notify, pause its scheduled slots).
- [ ] C5. **Adapter seam change:** `SocialPublisher.publish(ctx)` now receives a per-account
  credential resolved from `connected_accounts` instead of `config`. The seam itself is
  unchanged — this is exactly what it was designed for. Update `getAdapter()` to build
  per-account instances (or pass creds per call).
- [ ] C6. A slot now references a `connected_account_id` (not just an adapter string). Update
  scheduling + the review flow accordingly.

**Acceptance:** two orgs each connect their own account; publishing uses the correct per-account
token; a revoked token pauses only that account's slots and notifies the owner.
**Depends on:** T1-A, T1-B, T0-D (secrets).

## Epic T1-D — Real platform adapters
**Objective:** publish to the networks businesses actually use. **Effort: XL (ongoing)**
Build behind the existing seam, one adapter per sub-task, ranked by demand.

- [ ] D1. **X / Twitter API v2** (note paid tiers + rate limits). Idempotency: no native key →
  reuse the `in_flight`/`uncertain` at-most-once path already built for Telegram.
- [ ] D2. **LinkedIn** (personal + organization pages; UGC/Posts API; OAuth + app review).
- [ ] D3. **Meta Graph API** — Facebook Pages + Instagram (business accounts, app review, media
  containers for IG).
- [ ] D4. **Bluesky** (AT Protocol) and **Threads** — cheaper wins, growing demand.
- [ ] D5. Per-adapter: rate-limit handling, error taxonomy (retryable vs terminal), the
  `idempotent` flag set correctly, contract tests with recorded responses.
- [ ] D6. Extend **constraint profiles** (`src/profiles.js`) per real platform (length, media
  rules, mentions, hashtags) so bad variants are still blocked pre-review.

**Acceptance:** each adapter passes contract tests + a live smoke publish to a test account;
swapping/adding one requires no business-logic change (seam holds).
**Depends on:** T1-C.

## Epic T1-E — Media pipeline
**Objective:** images/video, the core of real social. **Effort: L**

- [ ] E1. Object storage (Cloudflare R2 / S3) + CDN; signed upload URLs.
- [ ] E2. Validation + transcoding (image resize/format, video encode), thumbnails, alt text.
- [ ] E3. Per-platform media constraints enforced (size/aspect/format/count) as media validators
  alongside the text validators.
- [ ] E4. Attach media to variants; adapters upload media per platform's flow (e.g. IG
  containers, X media upload) before posting.

**Acceptance:** a post with an image publishes correctly to a real platform with valid media;
an oversized/invalid asset is blocked pre-review with a named reason.
**Depends on:** T1-C, T1-D.

> **Tier 1 exit criteria:** multiple orgs, role-gated review, per-account OAuth publishing to
> ≥2 real paid platforms with media, all isolated and audited.

---

# TIER 2 — Product depth (what makes people pay and stay)

*Objective: the surface and intelligence that turn a pipeline into a product. ~6–8 weeks.*

## Epic T2-A — Dashboard UI
**Objective:** replace API-only with a real app. **Effort: XL**

- [ ] A1. Frontend stack (ADR): **Next.js (App Router) + React + Tailwind**, calling the core
  API/worker. Auth integrated with T1-B.
- [ ] A2. **Composer** with live per-platform preview + inline constraint validation (surface
  the same `validateVariant` violations in the UI before submit).
- [ ] A3. **Content calendar** (schedule view: pending/published/failed slots, drag to
  reschedule).
- [ ] A4. **Approval inbox** for reviewers (approve/reject/comment) — the review workflow made
  visual.
- [ ] A5. **Connected-accounts** management UI (connect/disconnect/reauth, status).
- [ ] A6. **Media library**.

**Acceptance:** a non-technical user can ingest → generate → review → schedule → see it publish,
without touching the API.
**Depends on:** Tier 1.

## Epic T2-B — Analytics & reporting
**Objective:** show performance; close the loop. **Effort: L**

- [ ] B1. Ingest metrics from platform *read* APIs + webhooks (impressions, engagement, clicks).
- [ ] B2. Per-post and per-campaign dashboards; export (CSV/PDF).
- [ ] B3. Link tracking (UTM + short links) with click attribution.
- [ ] B4. Best-time-to-post insights derived from historical performance.

**Acceptance:** a published post shows real engagement numbers within the platform's data delay.
**Depends on:** T1-C/D (accounts + adapters), T2-A (to display).

## Epic T2-C — Advanced scheduling
**Objective:** scheduling that respects reality. **Effort: L**

- [ ] C1. **Time-zone-aware** slots (store tz per account/campaign).
- [ ] C2. **Recurring** campaigns + templates; **campaign-level orchestration** (stagger one
  message across platforms).
- [ ] C3. **Rate-limit-aware pacing** per connected account (leaky-bucket per account, not a
  global rate) — protects throughput and prevents account bans.
- [ ] C4. Bulk import/scheduling; pause/resume campaigns; optimal-time auto-slotting.

**Acceptance:** scheduling 50 posts across 3 accounts respects each account's rate limit and
lands them at correct local times; pausing a campaign halts only its slots.
**Depends on:** T0-B (queue), T1-C (accounts).

## Epic T2-D — AI content quality + compliance
**Objective:** generation worth using, safely. **Effort: M**

- [ ] D1. Brand-voice/style-guide conditioning per org (system prompt + examples per brand).
- [ ] D2. Multi-variant A/B generation; hashtag research; localization/translation.
- [ ] D3. Optional image generation for posts.
- [ ] D4. **Compliance validators** as first-class rules alongside length/tone: banned words,
  FTC/ad-disclosure requirements, per-industry rules — a bad variant is still blocked pre-review.

**Acceptance:** generated variants match a configured brand voice and are blocked when they
violate a compliance rule, with the rule named (extends the PROBE 2 behavior).
**Depends on:** existing generator/validator; T1-A (per-org config).

## Epic T2-E — Collaboration & notifications
**Objective:** teams, not solo users. **Effort: M**

- [ ] E1. Multi-step approval chains; inline comments + suggested edits on variants.
- [ ] E2. Notifications (email + Slack) for needs-review / failed / published.
- [ ] E3. Activity feed per org (reads from the audit log).

**Acceptance:** a two-step approval blocks publish until both approve; reviewers get notified.
**Depends on:** T1-B (roles + audit), T2-A (UI).

> **Tier 2 exit criteria:** a non-technical team can plan, generate (on-brand + compliant),
> review through an approval chain, schedule intelligently, publish to real platforms with
> media, and see performance — all in a UI.

---

## Dependency map (critical path)

```
F1 (TypeScript)
      │
      ▼
T0-A Postgres/claim ──► T0-B worker/queue ──► T0-C observability
      │                        │
      └──► T0-D CI/CD ◄────────┘
      │
      ▼
T1-A tenancy ──► T1-B auth/RBAC ──► T1-C connected accounts/OAuth ──► T1-D real adapters ──► T1-E media
                                                    │
                                                    ▼
                                   T2-A UI ──► T2-B analytics
                                        │        T2-C scheduling (needs T0-B + T1-C)
                                        └──► T2-D AI quality ──► T2-E collaboration
```

**Hard rule:** T1-A (tenancy) must land before any real customer data. T1-C (OAuth accounts)
gates every real adapter.

---

## Suggested sprint plan (2-week sprints)

| Sprint | Focus | Epics |
|---|---|---|
| 1 | TypeScript, Postgres, and migrations | F1, T0-A foundation |
| 2 | Worker/queue, retries, and dead-letter behavior | T0-B foundation |
| 3 | Logging, metrics, health probes, and shutdown | T0-C foundation |
| 4 | CI, secret scanning, and safe startup migrations | T0-D |
| 5 | FK indexes/`updated_at` triggers; real BullMQ worker-crash recovery | T0-A, T0-B closeout |
| 6 | Cross-queue trace correlation; hosted dashboard and forced-failure proof; **Tier 0 done** | T0-C closeout |
| 7 | Tenancy schema, default-org backfill, and isolation tests | T1-A |
| 8 | Auth/RBAC, API keys, and audit | T1-B |
| 9–10 | Connected accounts, credential protection, OAuth where supported | T1-C |
| 11–12 | Account-scoped real adapters and platform profiles | T1-D |
| 13 | Media pipeline; **Tier 1 done** | T1-E |
| 14–15 | Dashboard UI | T2-A |
| 16 | Advanced scheduling + rate-aware pacing | T2-C |
| 17 | Analytics | T2-B |
| 18 | AI quality + compliance | T2-D |
| 19 | Collaboration + notifications; **Tier 2 done** | T2-E |

---

## Testing strategy (per tier)

- **Tier 0:** keep `node:test`; CI covers real-Postgres claim contention and migration contracts,
  plus a disposable real-Redis BullMQ test that kills a worker after a mock send and verifies
  recovery without a duplicate. Keep the domain retry/dead-letter tests hermetic on PGlite.
- **Tier 1:** **tenancy negative tests** (cross-org denied), authz matrix tests (role × endpoint),
  **contract tests per adapter** with recorded API responses (CI never hits live), token-refresh
  and revocation tests, media-validation tests.
- **Tier 2:** component/e2e tests for the UI (Playwright), analytics-ingestion tests, rate-limit
  pacing tests, compliance-validator tests, approval-chain tests.
- **Always:** load test the scheduler at target throughput; chaos-test exactly-once under
  concurrency before each tier's exit.

---

## Cutover / migration playbooks (the risky transitions)

1. **SQLite → Postgres (T0-A):** stand up Postgres, run migrations, dual-write or one-shot
   export/import (dev data is disposable; for any real data, snapshot + verify counts), switch
   `repo` implementation behind a flag, cut over, keep SQLite readable for rollback one release.
2. **Global creds → per-account OAuth (T1-C):** ship `connected_accounts` + OAuth first with the
   old env-cred path still working (feature flag), migrate the demo Telegram to a connected
   account, then remove the env-cred code path.
3. **API-only → UI (T2-A):** the UI is a pure client of the existing API — no big-bang; build it
   alongside, dogfood, then make it the default entry point.

---

## Top risks & mitigations

| Risk | Mitigation |
|---|---|
| Platform APIs change / gate features behind paid tiers + app review | Treat integrations as a permanent function; start LinkedIn/Meta app review early (weeks of lead time) |
| Rate limits → customer account bans | Per-account rate-aware pacing (T2-C) *before* onboarding many accounts |
| Multi-tenancy retrofit pain | Do T1-A before real data; RLS + mandatory scoping + negative tests |
| OAuth token security | Encrypt at rest (KMS/libsodium), least-privilege scopes, rotation, revocation handling |
| Scope creep across 19 sprints | Ship each tier behind flags; enforce epic exit criteria before moving on |
| Exactly-once regressions during the DB/queue moves | Re-run durability + concurrency tests as gates on T0-A and T0-B |

---

## What carries over unchanged (the spine)

The three capstone decisions this whole plan is built around — **the `SocialPublisher` adapter
seam**, **the idempotency ledger (`publish_attempts` + claim-before-send + in_flight/uncertain)**,
and **the review gate** — survive every tier. Most tasks above *extend* them rather than replace
them, which is why this is an evolution, not a rewrite.
