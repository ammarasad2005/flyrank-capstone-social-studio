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

- [ ] **F1 — Adopt TypeScript.** Migrate `src/` incrementally (allowJs, then file-by-file).
  Types pay off the moment the schema and adapters multiply. **(M)**
- [ ] **F2 — Definition of Done:** every task ships with tests, docs updated, passes CI, and is
  behind a feature flag if user-facing. No direct-to-`main`; PRs only.
- [ ] **F3 — Branching & commits:** trunk-based, short-lived branches, conventional-commit
  messages, squash-merge. Keep the phased, readable history habit from the capstone.
- [ ] **F4 — Environments:** `local` → `staging` → `prod`, each with isolated data + secrets.
- [ ] **F5 — Architecture Decision Records** (`docs/adr/`): one short ADR per major choice
  (Postgres, queue engine, auth provider, frontend framework).

---

# TIER 0 — Harden the core (make the current design production-safe)

*Objective: same feature set, but operable, observable, and safe to run for money. ~4 weeks.*

## Epic T0-A — Postgres + migrations + concurrent claim
**Objective:** replace SQLite with Postgres and make the claim safe for N workers.
**Effort: L**

- [ ] A1. Choose Postgres host (Neon or the existing Supabase project) + connection pooling
  (PgBouncer/Neon pooler). Write ADR.
- [ ] A2. Introduce a migration tool — **Drizzle** (recommended: gives TS types too) or Prisma.
  Convert the `CREATE TABLE IF NOT EXISTS` schema in `src/db.js` into versioned migrations.
- [ ] A3. Port `src/repo.js` from `better-sqlite3` (sync) to `pg` (async). Repo interface stays
  the same shape so routes/publisher barely change; make repo functions `async`.
- [ ] A4. Replace the SQLite atomic claim (`repo.claimDueSlot`) with
  `SELECT ... FROM slots WHERE status='pending' AND scheduled_at<=now() FOR UPDATE SKIP LOCKED
  LIMIT n` → update to `publishing`. This is the change that unlocks **multiple workers**.
- [ ] A5. Keep the UNIQUE `idempotency_key` on `publish_attempts` and `mock_posts` (Postgres
  UNIQUE + `ON CONFLICT DO NOTHING`). Re-verify the idempotency tests pass against Postgres.
- [ ] A6. Data-model cleanups enabled by Postgres: real `timestamptz`, enums as native types or
  CHECKs, foreign-key indexes, `created_at/updated_at` triggers.

**Acceptance:** all existing probes + `npm test` pass against Postgres; two worker instances
can run simultaneously without double-publishing (new concurrency test).
**Depends on:** F1.

## Epic T0-B — Separate, scalable worker + real job engine
**Objective:** the scheduler is its own service with retries, backoff, and visibility.
**Effort: L**

- [ ] B1. Extract the scheduler (`src/scheduler.js`) into a standalone worker entrypoint
  (`src/worker.js`) deployable independently from the API.
- [ ] B2. Choose the engine (ADR): **BullMQ on Upstash Redis** (you have Upstash) *or*
  **Inngest** (you have Inngest keys). Recommendation: BullMQ for fine-grained control of
  per-account concurrency; Inngest if you prefer managed durable execution.
- [ ] B3. Model publishing as a job: a "scan due slots" repeatable job enqueues per-slot
  publish jobs; `publishSlot()` becomes the job handler (it's already the single choke point —
  minimal change).
- [ ] B4. **Retry policy:** exponential backoff + jitter, max attempts, per-attempt logging into
  `publish_attempts` (`attempt_no` already exists), classify errors as retryable vs terminal.
- [ ] B5. **Dead-letter queue** for terminally-failed slots + an alert when one lands there.
- [ ] B6. **Graceful shutdown:** on SIGTERM stop claiming, finish/mark in-flight jobs, close DB
  and queue cleanly. Verify the durability guarantee under a normal rolling deploy, not just a
  crash.

**Acceptance:** killing a worker mid-batch resumes with no dup (existing durable test, now
against the queue); a flaky adapter is retried with backoff then dead-lettered + alerted.
**Depends on:** T0-A.

## Epic T0-C — Observability & operability
**Objective:** you can see, debug, and alert on the system. **Effort: M**

- [ ] C1. Structured logging with **pino** (request ids, slot/variant ids, org id later).
- [ ] C2. **Sentry** for error tracking in API + worker.
- [ ] C3. Metrics via **OpenTelemetry → Prometheus/Grafana** (or Grafana Cloud / Better Stack):
  publish success rate, queue depth, adapter latency + error rate per platform, scheduler lag.
- [ ] C4. Tracing across web → queue → worker → adapter.
- [ ] C5. `/health` (liveness) + `/ready` (readiness: DB + queue reachable) endpoints; wire to
  the deploy platform.
- [ ] C6. Alerting rules: publish success-rate drop, queue backlog, DLQ arrivals, adapter 5xx spike.

**Acceptance:** a forced adapter failure shows up in Sentry + a dashboard + an alert.
**Depends on:** T0-A (ids), T0-B (queue metrics).

## Epic T0-D — CI/CD + config + secrets hygiene
**Objective:** safe, automated delivery. **Effort: M**

- [ ] D1. **GitHub Actions CI:** on PR run `npm test`, ESLint, `tsc --noEmit`, and a dependency
  + secret scan (Dependabot + gitleaks). Block merge on failure.
- [ ] D2. **CD:** auto-deploy `main` → staging; manual promote → prod (Render for now; revisit
  Fly.io/Railway when web+worker split needs it).
- [ ] D3. **Config validation** with zod/envalid — fail fast on missing/invalid env.
- [ ] D4. **Secrets manager** for prod (Doppler / AWS Secrets Manager / Render env groups);
  remove long-lived secrets from local `.env` habits. Document rotation.
- [ ] D5. Run DB migrations automatically on deploy (with a safe, reversible strategy).

**Acceptance:** a red test blocks merge; a push to `main` lands on staging automatically with
migrations applied.
**Depends on:** F1, T0-A.

> **Tier 0 exit criteria:** Postgres-backed, multi-worker, retrying, observable service with CI/CD
> and all capstone probes green. This is "operable with the same features."

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
| 1 | TS migration + Postgres + migrations | F1, T0-A |
| 2 | Worker/queue + retries + CI | T0-B, T0-D |
| 3 | Observability + graceful shutdown; **Tier 0 done** | T0-C, finish T0-B |
| 4 | Tenancy + schema backfill | T1-A |
| 5 | Auth/RBAC + audit | T1-B |
| 6–7 | Connected accounts + OAuth + encryption | T1-C |
| 8–9 | Real adapters (X, LinkedIn) + profiles | T1-D |
| 10 | Media pipeline; **Tier 1 done** | T1-E |
| 11–12 | Dashboard UI | T2-A |
| 13 | Advanced scheduling + rate-aware pacing | T2-C |
| 14 | Analytics | T2-B |
| 15 | AI quality + compliance | T2-D |
| 16 | Collaboration + notifications; **Tier 2 done** | T2-E |

---

## Testing strategy (per tier)

- **Tier 0:** keep `node:test`; add a **concurrency test** (2 workers, no double-publish) and a
  **queue durability** test (kill worker mid-job). Contract test the migration.
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
| Scope creep across 16 sprints | Ship each tier behind flags; enforce epic exit criteria before moving on |
| Exactly-once regressions during the DB/queue moves | Re-run durability + concurrency tests as gates on T0-A and T0-B |

---

## What carries over unchanged (the spine)

The three capstone decisions this whole plan is built around — **the `SocialPublisher` adapter
seam**, **the idempotency ledger (`publish_attempts` + claim-before-send + in_flight/uncertain)**,
and **the review gate** — survive every tier. Most tasks above *extend* them rather than replace
them, which is why this is an evolution, not a rewrite.
