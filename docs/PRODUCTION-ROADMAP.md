# From Capstone to Product — Production Roadmap

An honest map of what to build to take Social Media Studio from a correct capstone to a
service that can run real business operations at scale. Every item is tied to a **specific
gap in the current code** so this is actionable, not generic.

---

## 0. Where it stands today (honest snapshot)

**What's genuinely solid and worth keeping** — these are the load-bearing design decisions
a rewrite would keep:

- **The adapter seam** (`SocialPublisher` + registry). Adding a platform is one file; swapping
  is config. This is exactly the right abstraction and scales conceptually to 20 platforms.
- **The idempotency ledger** (`publish_attempts`, UNIQUE `variant:slot`, claim-before-send,
  `in_flight`/`uncertain`). The hard part of "publish exactly once" is designed correctly,
  including the honest per-adapter idempotent/non-idempotent distinction.
- **The review gate** (`draft → approved → rejected → published`, only approved schedulable).
  This is the skeleton of a real approval product.
- **Single source of truth** (`posts`) and the clean data model.

**What is capstone-grade and must change for production:**

| Area | Today | Why it breaks at scale |
|---|---|---|
| Datastore | SQLite, single file | One writer, no concurrency, no HA, no PITR backups |
| Scheduler | in-process `setInterval` | Dies with the web process; can't scale to N workers |
| Tenancy | none | Can't serve multiple customers; no data isolation |
| Auth | none — open API | Anyone can post as anyone |
| Secrets | one global set in `.env` | Real product needs per-account OAuth tokens, encrypted |
| Platforms | 1 real (Telegram) + 2 mocks | Business needs X, LinkedIn, Meta, etc. |
| Media | text only | Real social is images/video first |
| Observability | `console.log` | Can't operate, debug, or meet an SLA |
| Delivery | manual push + Render | No CI, no migrations, no staging |
| Retry policy | park as `failed` | No backoff, no dead-letter, no alerting |

---

## Tier 0 — Harden the core (make the *current* design production-safe)

*Goal: the same feature set, but operable and trustworthy. ~2–4 weeks.*

1. **Postgres + real migrations.** Replace SQLite with managed Postgres (Neon/Supabase/RDS).
   Move the atomic claim to `SELECT ... FOR UPDATE SKIP LOCKED` so **multiple workers** can
   drain the queue safely. Introduce a migration tool (Drizzle / Prisma / node-pg-migrate) —
   `CREATE TABLE IF NOT EXISTS` is not a migration strategy.
2. **Split web and worker into separate processes/deployments.** The scheduler should be its
   own horizontally-scalable service, not a `setInterval` inside the API. Consider a real job
   system: **BullMQ** (Redis — you already have Upstash), or a durable-execution engine like
   **Inngest** (you already have Inngest keys) or Temporal. This gives retries, backoff,
   concurrency limits, and visibility for free.
3. **Retry policy that's real:** exponential backoff + jitter, capped attempts, a
   **dead-letter queue**, and alerting when a slot lands there. Today a failed publish just
   parks; production needs "try 5× over an hour, then page someone."
4. **Graceful shutdown / draining.** On SIGTERM, stop claiming, let in-flight publishes
   finish (or mark them so restart handles them). Critical for the durability guarantee under
   normal deploys, not just crashes.
5. **Observability from day one:** structured JSON logging (pino), metrics (Prometheus /
   OpenTelemetry), error tracking (Sentry), and tracing across web → queue → worker → adapter.
   Dashboards for publish success rate, queue depth, adapter latency/error rate.
6. **CI/CD.** GitHub Actions: on every PR run `npm test`, lint (ESLint), type-check, and a
   dependency/secret scan. Block merge on red. Auto-deploy `main` to staging, promote to prod.
7. **Config hardening.** Fail-fast validation of every env var (zod/envalid); a real
   secrets manager (Doppler / AWS Secrets Manager / Vault) instead of `.env` in production.

---

## Tier 1 — Turn it into a real multi-user SaaS

*Goal: multiple customers, real accounts, real platforms. This is the bulk of the product.*

8. **Multi-tenancy.** Add `organizations`, `users`, `memberships`. Scope every table by
   `org_id` and enforce isolation (Postgres Row-Level Security, or a rigorously-applied query
   layer). This touches the whole schema — do it before you have customers, not after.
9. **AuthN + AuthZ.** User auth (session or JWT; or Auth0/Clerk/WorkOS to buy it). Map the
   existing review workflow to **roles**: `viewer`, `author`, `reviewer/approver`, `admin`.
   Add an **audit log** (who approved/edited/published what, when) — non-negotiable for teams.
10. **Connected accounts + OAuth.** The biggest shift from the capstone: instead of one global
    token in `.env`, each org connects its own social accounts via OAuth. Build the
    connect/refresh/revoke lifecycle, store tokens **encrypted at rest** (KMS envelope
    encryption), and handle token expiry and re-auth gracefully. The `SocialPublisher` seam
    stays — but adapters now take a per-account credential, not a process-wide one.
11. **Real platform adapters** (ranked by typical demand): **X/Twitter API v2**, **LinkedIn**
    (personal + organization pages), **Meta Graph API** (Facebook Pages + Instagram),
    **Bluesky**, **Threads**, **Mastodon** (already have it), then YouTube/TikTok/Pinterest/
    Google Business as needed. Each brings OAuth, its own rate limits, media rules, and
    breaking API changes — **this is the largest ongoing engineering cost of the whole
    product.** Budget for it as a permanent function, not a one-time task.
12. **Media pipeline.** Object storage (S3/R2) + CDN, image/video validation and transcoding,
    alt text, per-platform size/aspect/format enforcement (extend the constraint profiles to
    cover media, not just text), thumbnails.
13. **Platform-specific features** the profiles don't model yet: threads/carousels, first
    comment, mentions, polls, link previews, scheduling to specific page vs. profile.

---

## Tier 2 — Product depth (what makes people pay and stay)

14. **A real UI.** Today it's API-only. Build a dashboard: composer with live per-platform
    preview + the constraint validation inline, a **content calendar**, an **approval inbox**,
    a media library, and connected-accounts management.
15. **Analytics & reporting.** Pull metrics back from platforms (impressions, engagement,
    clicks), per-post and per-campaign; best-time-to-post insights; link tracking with
    UTM/short links. This needs the *read* side of each platform API + webhooks.
16. **Advanced scheduling.** Time-zone-aware slots, optimal-time suggestions, recurring
    campaigns, campaign-level orchestration (stagger a post across platforms), rate-limit-aware
    pacing per account, bulk import, pause/resume, queues per account.
17. **AI content quality.** Beyond templates: brand-voice/style-guide conditioning per org,
    multi-variant A/B generation, hashtag research, localization/translation, image generation,
    and **compliance checks** (banned words, FTC/ad-disclosure rules) as first-class validators
    alongside the length/tone rules you already enforce.
18. **Approval chains + collaboration.** Multi-step approvals, inline comments, suggested edits,
    and notifications (email/Slack) for "needs review / failed / published."

---

## Tier 3 — Scale & enterprise readiness

19. **Horizontal scale & performance.** Stateless web tier behind a load balancer; N workers
    with concurrency caps; caching (Redis) for hot reads; table partitioning/archival for
    `publish_attempts` and analytics (these grow forever); read replicas.
20. **Reliability engineering.** Define SLOs (e.g. 99.9% publish success, p95 publish latency),
    alerting + on-call, incident runbooks, **circuit breakers** for flaky platform APIs, chaos
    testing of the exactly-once guarantees under real concurrency.
21. **Backups & DR.** Automated Postgres backups, point-in-time recovery, tested restores,
    data-retention policy, multi-AZ (and multi-region if the SLA demands it).
22. **Compliance & trust.** GDPR/CCPA (data export + deletion), platform-ToS compliance to
    avoid customer account bans, content moderation, privacy policy + DPA, and **SOC 2** if you
    sell to mid-market/enterprise.
23. **Commercial layer.** Billing/subscriptions (Stripe), plan quotas (accounts/seats/posts per
    month) enforced in code, usage metering, self-serve onboarding, docs, and support tooling.

---

## Cross-cutting: security & testing (do continuously, not as a phase)

- **Security:** encrypt tokens at rest; rate-limit + abuse protection on the API; input
  validation and output encoding; least-privilege OAuth scopes; secret rotation (you already
  owe this on your own keys); dependency scanning (Dependabot) + SAST; security headers + CORS;
  webhook signature verification.
- **Testing:** keep the `node:test` suite, add **contract tests** against each platform API
  (recorded/replayed responses so CI doesn't hit live APIs), load tests for the scheduler,
  chaos tests for crash/duplicate scenarios at concurrency, and end-to-end tests through the UI.
- **TypeScript.** Migrate off plain JS — at this surface area, types pay for themselves fast.

---

## Capacity planning — a concrete example

Say **10,000 orgs × 5 accounts × 10 posts/day = 500,000 publishes/day ≈ 6/sec average, with
bursts** (everyone schedules 9am local). That load says:

- Postgres with `FOR UPDATE SKIP LOCKED` + a Redis-backed queue handles this comfortably; the
  in-process SQLite scheduler does **not** (single writer, single process).
- The real bottleneck becomes **per-platform rate limits**, not your infra — so rate-aware
  pacing per connected account (Tier 2 #16) is what actually protects throughput and prevents
  account bans. Design the queue around per-account tokens/leaky-buckets, not a global rate.
- `publish_attempts` grows ~180M rows/year → partition by month + archive. Plan this early.

---

## The honest hard parts (where the real cost is)

1. **Platform integrations are a treadmill.** APIs change, deprecate, and gate features behind
   paid tiers and app-review. This is a permanent staffed function, not a milestone.
2. **OAuth token lifecycle + encryption** across many providers is fiddly and security-critical.
3. **Rate limits and account-ban risk** — get pacing wrong and you get customers suspended.
4. **Multi-tenancy + RLS retrofits are painful** — do tenancy before customer data exists.
5. **Analytics ingestion** (pulling metrics back) is a whole second data pipeline.

---

## Suggested sequencing

- **Next 2 weeks (highest leverage):** Postgres + migrations + `SKIP LOCKED`; split the worker;
  real backoff + DLQ; structured logging + Sentry; CI running the tests. This makes the
  *existing* product genuinely operable.
- **Next quarter:** multi-tenancy + auth/RBAC + audit log; connected-accounts OAuth with
  encrypted tokens; the first two real paid adapters (X + LinkedIn) with media support; a basic
  dashboard.
- **After product-market signal:** analytics, advanced scheduling, AI quality, billing, SOC 2.

> Keep the three things the capstone got right — the adapter seam, the idempotency ledger, and
> the review gate — as the spine. Everything above hangs off them.
