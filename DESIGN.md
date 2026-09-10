# Design — Social Media Studio

*Phase 1 gate. One page of thinking to save a week of rework. Written before any
feature code.*

## Problem

Turn **one** blog post into a **scheduled, multi-platform** social campaign. The
API calls are the easy part. The real product is a **publishing system that
survives the real world**:

- a retry after a timeout must **not** publish twice (idempotency — the heart of
  the grade);
- each platform's rules (length, tone, hashtags) are **enforced by code**, not by
  hope;
- a worker that dies mid-batch **resumes** with zero duplicate posts (durable
  scheduling);
- the app never knows which platform it publishes to — a new platform is a **new
  adapter, not a rewrite** (the adapter seam).

## Non-goal (explicit)

**No image generation, no analytics/engagement tracking, and no real Instagram, X,
or LinkedIn accounts.** Those three are represented by *mock* adapters. One real
free target (Mastodon) plus the mocks is enough to prove the architecture.

## Data model

The stored **post** is the single source of truth; all generation reads only from
it. Everything else hangs off it.

| Table | Key columns | Purpose |
| --- | --- | --- |
| `posts` | `id`, `source_type` (`url`\|`markdown`), `source_url`, `title`, `content_md`, `created_at` | The ingested post. Source of truth. |
| `variants` | `id`, `post_id`→posts, `platform`, `content`, `hashtags`, `status` (`draft`\|`approved`\|`rejected`\|`published`), `rejection_reason`, `created_at`, `updated_at` | One platform-specific version. |
| `slots` | `id`, `variant_id`→variants, `adapter`, `scheduled_at`, `status` (`pending`\|`publishing`\|`published`\|`failed`\|`canceled`), `claimed_at`, `created_at` | The calendar. One row = one intended publish. |
| `publish_attempts` | `id`, `variant_id`, `slot_id`→slots, `idempotency_key` **UNIQUE**, `adapter`, `status` (`pending`\|`succeeded`\|`failed`), `external_id`, `external_url`, `error`, `attempt_no`, `created_at` | Publish history **and** the idempotency guard. |

**Constraint profiles** and the **adapter registry** live in *code* (they are
rules and integrations, not data), so a reviewer can read the enforcement and a new
platform is a code file, not a migration.

### Idempotency mechanism (exactly-once)

`idempotency_key = "<variant_id>:<slot_id>"` — unique per variant *and* slot.

1. **UNIQUE constraint** on `publish_attempts.idempotency_key` makes a second
   *successful* record for the same variant+slot impossible at the DB layer.
2. Before sending, the publisher checks for an existing `succeeded` attempt with
   that key → if found, it returns that result and **sends nothing**.
3. For the real target, the **Mastodon `Idempotency-Key` HTTP header** carries the
   same key, so even a crash *between send and record* cannot double-post — Mastodon
   itself de-duplicates. Mock adapters de-dupe by key in their own store.

Belt **and** braces: app-layer guard + DB constraint + platform-native header.

### Durable scheduling (resumable)

The **job store is the SQLite DB**, so it survives a restart. A worker loop:

1. finds `slots` that are **due** (`scheduled_at <= now`), `pending`, whose variant
   is `approved`;
2. **claims** each atomically (`UPDATE ... SET status='publishing' WHERE
   status='pending'`) — only one claimer wins;
3. publishes through the adapter, records the attempt, and marks the slot
   `published`.

On startup the worker also re-scans slots stuck in `publishing` (a crash
mid-publish) and re-runs them — the idempotency key guarantees no duplicate.

## API surface

| Method & path | Purpose |
| --- | --- |
| `POST /posts` | Ingest a post (`{url}` or `{markdown, title}`), store it. |
| `GET /posts/:id` | Fetch a stored post. |
| `POST /posts/:id/generate` | Generate one variant per configured platform (templates or AI); only valid variants are stored. |
| `GET /variants` / `GET /variants/:id` | List / read variants. |
| `POST /variants` | Manually create a variant — **validated**; a rule-breaking one returns `422` naming the rule. |
| `PATCH /variants/:id` | Edit content — re-validated before saving. |
| `POST /variants/:id/approve` / `reject` | Review workflow. |
| `POST /variants/:id/schedule` | Schedule an **approved** variant (`{at, adapter}`); unapproved → `409`/`422` + error. |
| `GET /slots` | The calendar of scheduled publishes. |
| `GET /history` | The publish history (every attempt + result). |
| `GET /health` | Liveness. |

## Adapter seam

```
interface SocialPublisher {
  id: string
  publish({ idempotencyKey, variant, post }) -> { externalId, externalUrl, preview }
}
```

Implementations, chosen by the `adapter` string on a slot (config, not code):

- `mastodon`  → **MastodonPublisher** (real, free, OAuth token + Idempotency-Key header)
- `mock_x`    → **MockXPublisher** (records what it *would* post; renders a preview)
- `mock_linkedin` → **MockLinkedInPublisher** (same, LinkedIn-style)

Business logic depends on the interface only. Swapping `mastodon` → `mock_x` on a
slot changes **zero** business logic (PROBE 6).

## Constraint profiles (enforced by code)

| Platform | max length | max hashtags | tone rule |
| --- | --- | --- | --- |
| `mastodon` | 500 | 4 | neutral (no ALL-CAPS shouting) |
| `mock_x` | 280 | 3 | casual (≤1 link) |
| `mock_linkedin` | 3000 | 5 | professional (no emoji, no ALL-CAPS shouting) |

Validation returns every violation with a message that **names the broken rule**,
e.g. `"mock_x: exceeds max length 280 (was 312)"`.

## Build phases → gates

1. **Design** → this document.
2. **Ingestion + generation** → one post → two different valid variants; a
   rule-breaking variant blocked with a named rule.
3. **Review workflow** → unapproved cannot be scheduled; approved can.
4. **Adapters + idempotent publish** → a real message lands in Mastodon; a repeated
   publish call creates exactly one post.
5. **Scheduling, history, hardening** → worker restart mid-batch → zero duplicates;
   publish history; README. Plus a test suite for the scary cases.
