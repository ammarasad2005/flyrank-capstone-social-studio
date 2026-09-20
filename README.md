# Social Media Studio

Turn **one blog post** into a **scheduled, idempotent, multi-platform social campaign**.

Paste a URL or Markdown → the studio stores it once (single source of truth), generates
a per-platform variant that is **guaranteed** to obey that platform's rules, lets a human
approve/reject/edit, then publishes each approved variant on schedule through a pluggable
adapter — **exactly once**, even under retries and worker crashes.

FlyRank backend capstone. JavaScript / Node.js · Express · SQLite. No Docker, no Redis —
`npm install && npm start` and it runs.

---

## Why the interesting bits are interesting

| Requirement | How it's met |
|---|---|
| **Single source of truth** | A post is ingested once into `posts`; every variant references it. |
| **Constraints enforced in code** | `src/profiles.js` validates length / hashtag count / links / tone / emoji. A bad variant is **blocked before review** — generation drops it and manual create returns `422` **naming the broken rule**. |
| **Review gate** | Variants move `draft → approved → published` (or `rejected`). Only `approved` variants can be scheduled; an unapproved schedule is a `409` with a message. Editing re-validates and sends the variant back to `draft`. |
| **Adapter seam** | One `SocialPublisher` interface (`src/adapters/base.js`). One real target (Mastodon) + two mocks (X, LinkedIn). Swapping targets is a config change (`ADAPTER_OVERRIDE`) with **zero** business-logic edits. |
| **Idempotent + durable** | Every send goes through `publishSlot()` keyed by `variant:slot`. Exactly-once is enforced at **two layers** (see below) so retries and crashes never double-post. |
| **History** | Every attempt and its result is in `publish_attempts`; `GET /history` shows it. |

### Exactly-once, in two layers

```
publishSlot(slot)                           key = `${variantId}:${slotId}`
   │
   ├─ 1. APP layer   publish_attempts.idempotency_key is UNIQUE.
   │                 A 'succeeded' attempt short-circuits — the adapter isn't called twice.
   │
   └─ 2. ADAPTER layer   every adapter is idempotent on that same key:
                         • Mastodon → native `Idempotency-Key` request header
                         • mocks    → UNIQUE mock_posts.idempotency_key
```

So even if the worker sends the post and then **dies before recording success**, the
restart re-runs the slot, the adapter recognises the key, and you still get one post.

### Durable scheduling

A single in-process worker (`src/scheduler.js`) ticks every `SCHEDULER_TICK_MS`:

- **Claim** is an atomic `UPDATE slots SET status='publishing' WHERE status='pending'` — two
  workers can never grab the same slot.
- On **startup** it reclaims any slot left in `publishing` by a crashed run and re-publishes
  it (safe, because `publishSlot` is idempotent).

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
                        │  scheduler.js claims due slots (atomic)
                        ▼
                 ┌──────────────┐        ┌────────────────────────────┐
                 │ publishSlot  │───────▶│ getAdapter(id)             │
                 │ (idempotent) │        │  ├─ MastodonPublisher (real)│
                 └──────────────┘        │  ├─ MockXPublisher          │
                        │                │  └─ MockLinkedInPublisher   │
                        ▼                └────────────────────────────┘
                 publish_attempts  ◀── history + idempotency ledger
```

Data model (SQLite, `src/db.js`): `posts` · `variants` · `slots` · `publish_attempts`
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

### Turning on the REAL Mastodon target

1. On any open instance (e.g. `mastodon.social`) → **Settings → Development → New
   application**, scope **`write:statuses`**, copy the access token.
2. In `.env`:
   ```
   MASTODON_BASE_URL=https://mastodon.social
   MASTODON_ACCESS_TOKEN=...        # your token — stays in .env, never committed
   ```
3. Schedule a variant with `{"adapter":"mastodon"}` — it lands as a real toot with the link.

### The adapter swap (config-only)

Publish your "mastodon" campaigns through the X mock without touching code:

```
ADAPTER_OVERRIDE=mastodon=mock_x
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

- **Single-node scheduler.** Correctness relies on SQLite's atomic claim, which is fine for
  one process. Horizontal scaling would need Postgres row locks or an external queue.
- **Variant text is templated by default.** Optional Gemini generation (`USE_AI=true`) exists,
  but the *graded* behaviour is enforcement, not authorship — a weak AI variant is still
  blocked if it breaks a rule.
- **Mocks only, out of the box.** X and LinkedIn are mocks by design (no free write APIs); the
  real target is Mastodon. The seam means adding a real X/LinkedIn adapter is one new file.
- **No media/image generation, analytics, or thread-splitting** — explicit non-goals.

See `EVIDENCE.md` for one proof per requirement and `BUILDLOG.md` for the AI-usage log.

## License

MIT
