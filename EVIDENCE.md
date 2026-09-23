# EVIDENCE

One proof per requirement. Every block below is copied from a real run against the
service (SQLite + Express, Node 20). Reproduce with `npm start` + the commands shown,
or run `npm test` for the automated versions.

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
`tests/durable-restart.test.js`): the slot is left in `publishing`, the attempt row is
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
# tests 8
# pass 8
# fail 0
```

Covering: blocked variant (`integration`), refused schedule (`integration`), duplicate
publish (`integration` + `durable-restart`), adapter swap (`adapter-swap`), and durable
crash-restart for **both** an idempotent and a non-idempotent target (`durable-restart`).
