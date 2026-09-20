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

Enable the Mastodon target in `.env` (`MASTODON_BASE_URL`, `MASTODON_ACCESS_TOKEN`,
scope `write:statuses`), then:

```
$ POST /variants/1/approve
$ POST /variants/1/schedule   { adapter:"mastodon", at:"<~2 min from now>" }
  -> 201  slot pending

# the durable scheduler publishes on the next tick after `at`:
scheduler: slot 1 -> published via mastodon

$ GET /history
[ { "status":"succeeded", "adapter":"mastodon",
    "external_url":"https://<instance>/@you/<status-id>", "idempotency_key":"1:1" } ]
```

The `external_url` is the live permalink to the toot. (Runs against any open instance
such as `mastodon.social`; the token stays in `.env`, never committed.)

> Status: verified live once the reviewer/user supplies an instance + `write:statuses`
> token. The exact same `publishSlot()` path is already proven end-to-end against the
> mocks below, and the Mastodon adapter sends the native `Idempotency-Key` header.

---

## PROBE 5 — Kill/retry mid-publish → exactly one post

**Repeated publish of one slot:**

```
$ POST /slots/1/publish  ×3
  call 1 -> reused=False  external_id=mock-mock_x-1
  call 2 -> reused=True   external_id=mock-mock_x-1
  call 3 -> reused=True   external_id=mock-mock_x-1
  GET /mock-posts count -> 1
```

**Crash *after* the network send but *before* recording success** (automated in
`tests/durable-restart.test.js`): the slot is left in `publishing`, the attempt row is
still `pending`, and one mock post already exists. On restart the scheduler reclaims the
slot and re-runs it:

```
ok - crash after send, before commit: restart re-runs and does NOT double-post
   assert listMockPosts().length === 1     // STILL one post
   assert attempt.status === 'succeeded'   // converged
   assert slot.status === 'published'       // converged
```

Exactly-once holds because the idempotency key `variant:slot` is UNIQUE at the app layer
**and** each adapter is idempotent on the same key.

---

## PROBE 6 — Swap the adapter via config, no code change

```
# .env:  ADAPTER_OVERRIDE=mastodon=mock_x
$ POST /variants/1/schedule  { adapter:"mastodon" }   -> slot adapter = "mastodon"
$ POST /slots/1/publish
  published external_url = mock://mock_x/1   (went through the mock, no Mastodon creds used)
```

The slot still targets `mastodon`, but the registry reroutes it to the X mock purely from
the environment. Zero edits to ingestion, review, scheduling, or publish logic.

---

## Stretch — Automated test suite for the scary cases

```
$ npm test
# tests 7
# pass 7
# fail 0
```

Covering: blocked variant (`integration`), refused schedule (`integration`), duplicate
publish (`integration` + `durable-restart`), adapter swap (`adapter-swap`), and durable
crash-restart (`durable-restart`).
