# Social Media Studio

Turn **one blog post** into a **scheduled, idempotent, multi-platform social campaign**.

**🔴 Live:** https://flyrank-social-studio.onrender.com  ·  publishes to Telegram
[@my_flyrank_demo](https://t.me/my_flyrank_demo)

Paste a URL or Markdown → the studio stores it once (single source of truth), generates
a per-platform variant that is **guaranteed** to obey that platform's rules, lets a human
approve/reject/edit, then publishes each approved variant on schedule through a pluggable
adapter — **exactly once**, even under retries and worker crashes.

FlyRank backend capstone. **TypeScript** / Node.js · Express · **Postgres**. Zero-setup
locally: `npm install && npm start` runs an in-process Postgres (PGlite) — no Docker, no
external DB. Point `DATABASE_URL` at a managed Postgres (Neon/Supabase/RDS) for production.

**Real target: Telegram** (free Bot API, real message + link). **Mastodon** is included as a
second real adapter. **X** and **LinkedIn** are mocks (no free write APIs). Swapping any of
them is a config change — see PROBE 6.

---

## Why the interesting bits are interesting

| Requirement | How it's met |
|---|---|
| **Single source of truth** | A post is ingested once into `posts`; every variant references it. |
| **Constraints enforced in code** | `src/profiles.js` validates length / hashtag count / links / tone / emoji. A bad variant is **blocked before review** — generation drops it and manual create returns `422` **naming the broken rule**. |
| **Review gate** | Variants move `draft → approved → published` (or `rejected`). Only `approved` variants can be scheduled; an unapproved schedule is a `409` with a message. Editing re-validates and sends the variant back to `draft`. |
| **Adapter seam** | One `SocialPublisher` interface (`src/adapters/base.js`). Real target Telegram (+ Mastodon), plus two mocks (X, LinkedIn). Swapping targets is a config change (`ADAPTER_OVERRIDE`) with **zero** business-logic edits. |
| **Idempotent + durable** | Every send goes through `publishSlot()` keyed by `variant:slot`. Exactly-once (never a duplicate) is enforced by a claim-before-send attempt ledger + adapter-level dedupe (see below), so retries and crashes never double-post. |
| **History** | Every attempt and its result is in `publish_attempts`; `GET /history` shows it. |

### Exactly-once (never a duplicate)

Every attempt row moves `pending → in_flight → succeeded | failed | uncertain`, where
`in_flight` is set **right before** the network send — so the crash window is recorded.

```
publishSlot(slot)                           key = `${variantId}:${slotId}`
   │
   ├─ APP layer     publish_attempts.idempotency_key is UNIQUE.
   │                A 'succeeded' attempt short-circuits — the adapter isn't called twice.
   │
   └─ ADAPTER layer, on restart after an in_flight crash:
        • idempotent target (Mastodon Idempotency-Key header, mocks' UNIQUE key)
              → safe to re-send; the target returns the same post  → exactly one
        • non-idempotent target (Telegram sendMessage, no dedupe key)
              → we REFUSE to re-send and mark the attempt 'uncertain' → at-most-once
```

Either way you never get a duplicate. (For Telegram the trade-off is honest: rather than
risk a double-post, an ambiguous in-flight send is flagged for review instead of retried.)

### Durable scheduling

A queue driver (`src/queue/`) ticks every `SCHEDULER_TICK_MS`:

- **Claim** is an atomic `UPDATE slots SET status='publishing' WHERE status='pending'`
  guarded by `FOR UPDATE SKIP LOCKED` — two workers can never grab the same slot.
- On **startup** it reclaims any slot left in `publishing` by a crashed run and re-publishes
  it (safe, because `publishSlot` is idempotent).

### Retries, backoff & dead-letter (Sprint 2)

When a publish fails, `processSlot()` decides what happens next — and that decision lives in
the **database**, so it's identical across queue drivers and testable with no broker:

- **Retry with backoff.** `slots.attempts` is bumped and `next_attempt_at` is set to
  `now() + RETRY_BASE_MS · 2^(attempt-1)` (+ jitter, capped). `claimDueSlot()` filters on
  `next_attempt_at`, so a slot is simply not re-claimed until its backoff window passes.
- **Dead-letter.** After `RETRY_MAX_ATTEMPTS` failures the slot moves to `dead_letter`
  (queryable, never re-claimed) and an alert fires (log, plus an optional
  `ALERT_WEBHOOK_URL` POST).
- **Uncertain sends are never retried.** If a non-idempotent target (Telegram) crashed
  mid-send, the outcome is unknown, so the slot is dead-lettered immediately rather than
  risk a duplicate.

### Queue drivers (swap the engine, keep the semantics)

Both drivers implement one `PublishQueue` interface and funnel every slot through the same
`processSlot()`, so publish behaviour never changes with the engine:

| `QUEUE_DRIVER` | Engine | Use |
| --- | --- | --- |
| `inprocess` (default) | DB-backed poller, no broker | single process or a few; multi-worker-safe via `SKIP LOCKED`. Carries the test suite. |
| `bull` | BullMQ over Redis (Upstash) | a horizontally-scaled worker fleet |

Run the queue inside the web process (default, `inprocess`) or as its own scalable process:

```bash
npm run worker      # standalone worker; picks the driver from QUEUE_DRIVER
```

For `bull`, set `REDIS_URL` to a **`rediss://…:6379`** TCP endpoint (the Upstash *REST*
URL/token will not work with BullMQ/ioredis), set `QUEUE_DRIVER=bull`, and run the web
process with `SCHEDULER_ENABLED=false` while `npm run worker` does the publishing. See
`docs/adr/0002-queue-driver-and-domain-retries.md`.

---

## Architecture

```
                 ┌──────────────┐
   URL / MD  ──▶ │  ingest.js   │──▶ posts (single source of truth)
                 └──────────────┘
                        │
                 ┌──────────────┐   validate against profiles.js
                 │ generator.js │──▶ variants (bad ones blocked here)
                 └──────────────┘
                        │  human: approve / reject / edit
                        ▼
                 ┌──────────────┐
                 │    slots     │  (approved variant + when + which adapter)
                 └──────────────┘
                        │  queue driver claims due slots (atomic)
                        ▼
                 ┌──────────────┐        ┌─────────────────────────────┐
                 │ publishSlot  │───────▶│ getAdapter(id)              │
                 │ (idempotent) │        │  ├─ TelegramPublisher (real)│
                 └──────────────┘        │  ├─ MastodonPublisher (real)│
                        │                │  ├─ MockXPublisher          │
                        │                │  └─ MockLinkedInPublisher   │
                        ▼                └─────────────────────────────┘
                 publish_attempts  ◀── history + idempotency ledger
```

Data model (Postgres, `migrations/001_init.sql`): `posts` · `variants` · `slots` · `publish_attempts`
(UNIQUE `idempotency_key`) · `mock_posts` (UNIQUE `idempotency_key`).

---

## Run it (one command + seed)

```bash
cp .env.example .env          # defaults work out of the box (mocks only, no secrets)
npm install
npm start                     # web + scheduler on http://localhost:3000

# in another terminal — ingest a post, generate, approve, schedule two variants:
npm run seed
# watch the server log: the scheduler publishes them within a minute
curl localhost:3000/history
curl localhost:3000/mock-posts
```

Run the test suite (the scary cases):

```bash
npm test
```

### Turning on the REAL Telegram target

1. In the Telegram app, message **@BotFather** → `/newbot` → copy the **bot token**.
2. Create a channel, add the bot as an **admin**, and note the channel id (`@mychannel`
   for a public channel, or the numeric `-100…` id).
3. In `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...   # stays in .env, never committed
   TELEGRAM_CHAT_ID=@mychannel
   ```
4. Schedule a variant with `{"adapter":"telegram"}` — it lands as a real message; a public
   channel yields a real `https://t.me/…` permalink in `/history`.

Mastodon works the same way as a second real target (`MASTODON_BASE_URL` +
`MASTODON_ACCESS_TOKEN`, scope `write:statuses`, schedule with `{"adapter":"mastodon"}`).

### The adapter swap (config-only)

Publish your "telegram" campaigns through the X mock without touching code:

```
ADAPTER_OVERRIDE=telegram=mock_x
```

---

## API surface

| Method & path | Purpose |
|---|---|
| `POST /posts` | Ingest `{url}` **or** `{markdown, title}` → `201` post |
| `POST /posts/:id/generate` | Generate one variant per platform → `{created[], blocked[]}` |
| `GET /posts/:id` · `GET /variants?post_id=` | Read post / its variants |
| `POST /variants` | Manually create a variant — `422 {violations[]}` if it breaks a rule |
| `PATCH /variants/:id` | Edit content (re-validated, returns to `draft`) |
| `POST /variants/:id/approve` · `/reject` | Review workflow |
| `POST /variants/:id/schedule` | Schedule an **approved** variant `{at?, adapter?}` (else `409`) |
| `GET /slots` | Schedule calendar |
| `POST /slots/:id/publish` | Publish now — idempotent (same path the scheduler uses) |
| `GET /history` | Every publish attempt + result |
| `GET /mock-posts` | What the mock adapters recorded |

---

## Limitations (honest)

- **Scheduler is DB-backed.** The claim uses Postgres `FOR UPDATE SKIP LOCKED`, so multiple
  workers can run without double-publishing. A dedicated job engine (**BullMQ** over Redis)
  is now available behind `QUEUE_DRIVER=bull`, and retry/backoff/dead-letter is implemented
  as DB domain logic shared by both drivers (Tier 0-B, see `docs/WORKPLAN.md`).
- **Variant text is templated by default.** Optional Gemini generation (`USE_AI=true`) exists,
  but the *graded* behaviour is enforcement, not authorship — a weak AI variant is still
  blocked if it breaks a rule.
- **X and LinkedIn are mocks by design** (no free write APIs). The real targets are Telegram
  and Mastodon. The seam means adding a real X/LinkedIn adapter is one new file.
- **Telegram has no idempotency key.** Its exactly-once is achieved by refusing to retry an
  in-flight send (at-most-once); an idempotent target like Mastodon can additionally re-send
  safely. The trade-off is documented and tested (`tests/durable-restart.test.js`).
- **No media/image generation, analytics, or thread-splitting** — explicit non-goals.

See `EVIDENCE.md` for one proof per requirement and `BUILDLOG.md` for the AI-usage log.

## Deployment

Deployed on **Render** (free web service) at
[flyrank-social-studio.onrender.com](https://flyrank-social-studio.onrender.com). The
Telegram secrets are set as Render **environment variables** (never committed). `PORT` is
supplied by Render and the server binds `0.0.0.0`.

Note: with the default PGlite store on Render's ephemeral filesystem the DB resets on
redeploy/restart (the durable scheduler still resumes correctly *within* a container's
lifetime — see the crash-restart test). For persistence across restarts, set `DATABASE_URL`
to a managed Postgres (Neon/Supabase).

## License

MIT
