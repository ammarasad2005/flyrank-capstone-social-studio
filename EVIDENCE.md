# EVIDENCE

One proof per requirement. The HTTP/unit suite runs against PGlite (in-process Postgres)
with Express on Node 20; production uses managed Neon Postgres on Render. Reproduce local
checks with `npm test`; the dedicated disposable-real-Postgres migration/concurrency check
runs in GitHub Actions.

---

## PROBE 1 — Ingest a post → variants that all obey their platform rules

```
$ POST /posts  {title, markdown}
{ "id": 1, "source_type": "markdown", "title": "How we cut build times in half", ... }

$ POST /posts/1/generate  {}
{
  "created": [
    { "id": 1, "platform": "mastodon",      "len": 124, "status": "draft" },
    { "id": 2, "platform": "mock_x",        "len": 119, "status": "draft" },
    { "id": 3, "platform": "mock_linkedin", "len": 153, "status": "draft" }
  ],
  "blocked": []
}
```

Every generated variant is within its profile (mastodon ≤ 500, mock_x ≤ 280,
mock_linkedin ≤ 3000) and passed validation before being stored.

---

## PROBE 2 — A rule-breaking variant is blocked, and the error names the rule

```
$ POST /variants   { post_id:1, platform:"mock_x", content: <300 chars> + " #a #b #c #d #e" }
HTTP 422
{
  "error": "variant violates its platform constraint profile",
  "violations": [
    "mock_x: exceeds max length 280 (was 315)",
    "mock_x: too many hashtags — 5 > 3"
  ],
  "stats": { "length": 315, "hashtags": 5, "maxLength": 280, "maxHashtags": 3 }
}
```

The bad variant never reaches review — it is rejected at creation with the specific
rules it broke. Tone/emoji rules are enforced the same way (see the LinkedIn profile:
no emoji, no ALL-CAPS shouting).

---

## PROBE 3 — Scheduling an unapproved variant is refused with a 4xx

```
$ POST /variants/1/schedule   { adapter:"mastodon" }     (variant 1 is still "draft")
HTTP 409
{ "error": "only approved variants can be scheduled — this variant is \"draft\"" }
```

Only variants in status `approved` can be scheduled. Editing an approved variant sends
it back to `draft`, so an unreviewed edit can't sneak through either.

---

## PROBE 4 — Approve + schedule → a real message lands with the link

**Verified live** against Telegram (bot `@flyrank_studio_bot`, public channel
`@my_flyrank_demo`). Secrets live in `.env` / host env vars, never committed.

```
$ POST /posts        -> post 1 "How we cut build times in half"
$ POST /posts/1/generate -> created: telegram(1), mock_x(2), mock_linkedin(3)
$ POST /variants/1/approve                                   -> 200
$ POST /variants/1/schedule { adapter:"telegram", at:"2026-09-27T12:16:23Z" }  -> 201 slot pending

# the durable scheduler fired on its own on the next tick after `at`:
scheduler: started, tick=1500ms
scheduler: slot 1 -> published via telegram

$ GET /history
[
  {
    "id": 1, "variant_id": 1, "slot_id": 1,
    "idempotency_key": "1:1",
    "adapter": "telegram",
    "status": "succeeded",
    "external_id": "3",
    "external_url": "https://t.me/my_flyrank_demo/3",
    "preview": "How we cut build times in half\n\nWe profiled the pipeline, cached dependencies, and parallelised the test matrix. CI dropped from 22 minutes to under 10.\n\n#Build #Times #Half"
  }
]
```

👉 The live message: **https://t.me/my_flyrank_demo/3** — a real post with its permalink.
Mastodon works identically via `{"adapter":"mastodon"}`.

Also verified against the **deployed** service at
`https://flyrank-social-studio.onrender.com` (full ingest → generate → approve → schedule →
scheduler-published) → **https://t.me/my_flyrank_demo/4**.

---

## PROBE 5 — Kill/retry mid-publish → exactly one post

**Repeated publish of one slot (mock target):**

```
$ POST /slots/1/publish  ×3
  call 1 -> reused=False  external_id=mock-mock_x-1
  call 2 -> reused=True   external_id=mock-mock_x-1
  call 3 -> reused=True   external_id=mock-mock_x-1
  GET /mock-posts count -> 1
```

**Repeated publish of the REAL Telegram slot from PROBE 4** (verified live — no second
message appeared in the channel):

```
$ POST /slots/1/publish  ×3   (slot already succeeded)
  call 1 -> reused=True  already_done=True  ext=3
  call 2 -> reused=True  already_done=True  ext=3
  call 3 -> reused=True  already_done=True  ext=3
  GET /history: succeeded attempts for 1:1 = 1
```

**Crash *after* the network send but *before* recording success** (automated in
`tests/durable-restart.test.ts`): the slot is left in `publishing`, the attempt row is
still `pending`, and one mock post already exists. On restart the scheduler reclaims the
slot and re-runs it:

```
ok - IDEMPOTENT adapter: crash after send, restart re-runs and does NOT double-post
   assert listMockPosts().length === 1     // STILL one post
   assert attempt.status === 'succeeded'   // converged
   assert slot.status === 'published'       // converged

ok - NON-IDEMPOTENT adapter (telegram): an in-flight crash is NOT retried (no duplicate)
   assert out.skipped === true             // refused to re-send
   assert attempt.status === 'uncertain'   // flagged, not duplicated
```

No duplicate is possible: the key `variant:slot` is UNIQUE at the app layer, the attempt is
marked `in_flight` *before* the send, and on restart an idempotent target (Mastodon/mocks)
is safely re-sent while a non-idempotent one (Telegram) is refused rather than risked.

---

## PROBE 6 — Swap the adapter via config, no code change

```
# .env:  ADAPTER_OVERRIDE=mastodon=mock_x
$ POST /variants/1/schedule  { adapter:"mastodon" }   -> slot adapter = "mastodon"
$ POST /slots/1/publish
  published external_url = mock://mock_x/1   (went through the mock, no Mastodon creds used)
```

The slot still targets `mastodon`, but the registry reroutes it to the X mock purely from
the environment. Zero edits to ingestion, review, scheduling, or publish logic. The same
mechanism reroutes the real Telegram target (`ADAPTER_OVERRIDE=telegram=mock_x`).

---

## Stretch — Automated test suite for the scary cases

```
$ npm test
# tests 17
# pass 17
# fail 0
```

Covering: blocked variant (`integration`), refused schedule (`integration`), duplicate
publish (`integration` + `durable-restart`), adapter swap (`adapter-swap`), concurrent
claim safety (`concurrency`), durable crash-restart for **both** an idempotent and a
non-idempotent target (`durable-restart`), the Sprint-2 failure paths below, and the
Sprint-3 observability endpoints (`observability`).

---

## Sprint 2 — Retry, backoff & dead-letter (`tests/retry-deadletter.test.ts`)

```
$ npm test  (retry-deadletter)
ok - failing send retries with backoff, then dead-letters at max attempts
ok - backoff grows and gates claimDueSlot until next_attempt_at passes
ok - uncertain non-idempotent crash is dead-lettered immediately (no retry)
```

A publish that keeps failing (Telegram adapter with no credentials — throws offline, no
network) is retried: `slots.attempts` climbs and `next_attempt_at` is pushed out with
exponential backoff, so `claimDueSlot()` holds the slot back until its window passes. After
`RETRY_MAX_ATTEMPTS` the slot flips to `dead_letter` (never re-claimed) and exactly one alert
fires. A non-idempotent send whose outcome is unknown after a crash is dead-lettered
immediately — it is **never** retried, so it can't double-post. The whole model runs on
PGlite with no broker, so it's identical whether `QUEUE_DRIVER=inprocess` or `bull`.

---

## Sprint 3 — Observability (`tests/observability.test.ts`)

```
$ npm test  (observability)
ok - GET /health is live and sets a request-id header on normal routes
ok - GET /ready reports DB + queue checks (inprocess: queue ok)
ok - GET /metrics exposes Prometheus text with our custom series
ok - a successful publish increments publish_attempts_total{outcome="succeeded"}
```

`GET /health` is liveness; `GET /ready` checks the DB (and Redis when
`QUEUE_DRIVER=bull`), returning `503` + a per-check breakdown otherwise. `GET /metrics`
serves Prometheus text including `publish_attempts_total`, `publish_duration_seconds`,
`publish_retries_total`, `publish_dead_letters_total`, `slots_pending`, and
`http_request_duration_seconds`. Publishing a slot increments the succeeded counter for
that adapter. Every request is logged as structured JSON with an `x-request-id`. Full
runbook + alert rules: `docs/OBSERVABILITY.md`.

---

## Sprint 4 — CI, secret scanning, and migration safety

**PR #5** ([checks](https://github.com/ammarasad2005/flyrank-capstone-social-studio/pull/5/checks), `feat/sprint-4-ci-security-migrations`) ran all required GitHub checks successfully:

```
build-test:          success (install, lint, typecheck, 17 PGlite tests, npm audit)
postgres-concurrency: success (real PostgreSQL service, migration rerun, concurrent claims, duplicate idempotency reservation)
gitleaks:            success (full-history secret scan)
```

Local verification on the same code:

```
$ npm run lint                         -> pass
$ npm run typecheck                    -> pass
$ npm test                             -> 17 pass, 0 fail
$ npm audit --audit-level=high         -> 0 vulnerabilities
$ actionlint .github/workflows/ci.yml  -> pass
$ gitleaks git --log-opts=--all        -> full reachable history scanned, no leaks
```

GitHub branch protection on `main` now requires `build-test`, `postgres-concurrency`, and
`gitleaks`; PRs are required, checks must be up to date, administrators cannot bypass the
rule, and force-push/deletion are disabled. Approval count is zero so the owner can merge
self-authored PRs after CI passes.

The migration runner holds one transaction-scoped advisory lock while applying all pending
SQL and recording `_migrations`. The new PostgreSQL CI script inserts eight due slots,
starts twelve concurrent claimers, asserts eight unique claims and four empty results, then
races duplicate attempt reservations and asserts one stored row. Its disposable rows are
removed before the job exits. See `docs/RELEASES.md` and ADR-0004 for limits and recovery policy.

---

## Sprint 5 — Database integrity and queue durability

Migration `003_fk_indexes_and_updated_at.sql` adds indexes for the remaining current-schema
foreign keys (`slots.variant_id`, `publish_attempts.variant_id`) and `BEFORE UPDATE` triggers
for `variants.updated_at` and `publish_attempts.updated_at`. The PGlite migration test checks
ledger reruns, the complete current FK-index set, trigger presence, and that each trigger
replaces a deliberately stale timestamp.

Local verification:

```
$ npm run lint                         -> pass
$ npm run typecheck                    -> pass
$ npm test                             -> 17 pass, 0 fail
$ npm audit --audit-level=high         -> 0 vulnerabilities
$ actionlint .github/workflows/ci.yml  -> pass
```

PR #10's required checks passed:

```
build-test:          success (install, lint, typecheck, 17 PGlite tests, dependency audit)
postgres-concurrency: success (Postgres migration/schema checks, concurrent claims,
                     duplicate reservation, plus BullMQ restart recovery with Redis)
gitleaks:            success (full-history scan)
```

The BullMQ recovery drill runs against disposable PostgreSQL and Redis services. It starts
a real worker process, lets the `mock_x` target commit its idempotent mock post, then hard-kills
the worker before success is recorded. A new worker reclaims the `publishing` slot and
completes it; the test asserts one mock post and a succeeded attempt, then removes its rows
and test queue. No social API or alert endpoint is called: test child processes have those
credentials blanked, and the harness refuses non-loopback DB/Redis endpoints unless the CI
step explicitly opts into resetting the disposable queue.

---

## Sprint 6 — Queue tracing and alert-path evidence (implementation in progress)

Local verification on 2026-10-02 (Asia/Karachi):

```
$ npm run lint                         -> pass
$ npm run typecheck                    -> pass
$ npm test                             -> 22 pass, 0 fail
$ npm audit --audit-level=high         -> 0 vulnerabilities
$ git diff --check                     -> pass
```

`tests/tracing.test.ts` serializes a Sentry/W3C trace carrier across a simulated BullMQ
boundary, verifies the worker span stays in the same trace with a new span id, and rejects
malformed headers. `tests/observability-failure.test.ts` forces three offline Telegram
failures with credentials blanked, verifies two retry increments then dead-lettering, checks
that the actual exception reached an in-memory Sentry transport and one alert reached a local
webhook stub, and asserts no Telegram network request occurred. `tests/grafana-dashboard.test.ts`
validates the importable seven-panel dashboard and required reliability signals; the dashboard
JSON also parses and its panel rectangles do not overlap. `tests/metrics-auth.test.ts` verifies
the optional `/metrics` Bearer gate rejects missing/wrong tokens and accepts the configured
32+ character token. `observability/prometheus/alerts.yml` parses as YAML and contains the five
Prometheus alert rules; `docs/GRAFANA-CLOUD-HANDOFF-HANDBOOK.md` records the owner setup order,
safety boundaries, and non-secret handoff fields.

C4 queue propagation and the dashboard/offline C6 artifacts are implemented. PR #11's
required checks passed on implementation commit `2198a06`: `build-test`,
`postgres-concurrency` (disposable PostgreSQL/Redis recovery), and `gitleaks`. Hosted Grafana
scraping/dashboard import and a live Sentry/Slack event remain unverified because this
workspace has no Grafana account/API access or approved external test target. Staging was
re-evaluated on 2026-10-02 and remains deferred under ADR-0005. No production configuration was
changed; `METRICS_AUTH_TOKEN` is still unset (so `/metrics` remains public) and Sentry trace
sampling remains opt-in at 0.
