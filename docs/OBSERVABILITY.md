# Observability & operability (T0-C)

How to see, debug, and alert on the Social Media Studio.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness — process is up. Always cheap. |
| `GET /ready` | Readiness — checks DB, and Redis when `QUEUE_DRIVER=bull`. `200` ready / `503` not-ready with a per-check breakdown. |
| `GET /metrics` | Prometheus metrics (disable with `METRICS_ENABLED=false`); optional Bearer gate via `METRICS_AUTH_TOKEN` (empty means public). |

Point your platform's health check at `/ready` (gates traffic) and `/health` (restarts).

## Logs

Structured JSON via **pino** — one object per line. Every HTTP request is logged with a
generated/propagated `x-request-id` (returned as a response header) plus `responseTime`.
Publish/queue events log `slotId`, `adapter`, `outcome`, and (when Sentry tracing is
initialized) `traceId`. Control verbosity with `LOG_LEVEL` (`info` default; `silent` under
`NODE_ENV=test`). Ship the stream to Render logs / Grafana Loki / Better Stack as-is.

## Cross-queue traces (C4)

Each BullMQ slot producer span injects Sentry's `sentry-trace` and `baggage` plus the W3C
`traceparent` into the Redis job data. The worker extracts that carrier with `continueTrace()`
and creates a child `queue.process` span around `processSlot()`. The producer and consumer
log the same trace id; the consumer span has its own span id. Legacy jobs without a carrier
start a new trace. The periodic DB scanner is intentionally the root: scheduling a slot and
publishing it happen asynchronously, so the HTTP scheduling request is not currently the
parent. Configure `SENTRY_TRACES_SAMPLE_RATE` to a non-zero value to retain spans in Sentry;
its default remains zero to avoid changing production event volume implicitly.

## Metrics

Scrape `GET /metrics`. Key series:

| Metric | Type | Labels | Use |
| --- | --- | --- | --- |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status` | API latency & throughput, error rate |
| `publish_attempts_total` | counter | `adapter`, `outcome` | **publish success rate** per platform |
| `publish_duration_seconds` | histogram | `adapter`, `outcome` | **adapter latency** per platform |
| `publish_retries_total` | counter | `adapter` | retry pressure |
| `publish_dead_letters_total` | counter | `adapter`, `reason` | **DLQ arrivals** |
| `slots_pending` | gauge | — | **queue depth / scheduler lag** |
| `slots_dead_letter` | gauge | — | DLQ backlog |

### Example Prometheus scrape config

```yaml
scrape_configs:
  - job_name: social-media-studio
    metrics_path: /metrics
    static_configs:
      - targets: ['flyrank-social-studio.onrender.com']
    scheme: https
    # If METRICS_AUTH_TOKEN is set, provide the same value from a secret file:
    # authorization:
    #   type: Bearer
    #   credentials_file: /etc/prometheus/secrets/social-media-studio-metrics
```

An empty `METRICS_AUTH_TOKEN` preserves the legacy public endpoint. Generate a dedicated
random token (at least 32 characters) and set it on Render before configuring hosted scraping;
never reuse a social-platform or Sentry secret.

## Dashboard and alerting rules (C6)

The importable Grafana dashboard is `observability/grafana/social-media-studio.json`.
The Prometheus rule file to upload is `observability/prometheus/alerts.yml`; the hosted scrape
setup is in `docs/GRAFANA-CLOUD-SETUP.md`. Thresholds are starting points:

| Rule | Condition | Hold time |
| --- | --- | --- |
| `PublishSuccessRateLow` | Publish success below 90%; suppressed when there is no traffic | 10m |
| `DeadLetterArrivals` | Any dead-letter arrival in the last 15m | immediate |
| `QueueBacklogHigh` | More than 50 pending slots | 10m |
| `AdapterErrorSpike` | Adapter failure rate above 20%; suppressed when there is no traffic | 5m |
| `Api5xxSpike` | API 5xx rate above 5%; suppressed when there is no traffic | 5m |

The rule file adds `service=social-media-studio` and severity labels so a dedicated Grafana
notification route can target these alerts without changing the instance's default policy.

Independently of Prometheus, a dead-letter also fires an **immediate push alert** via
`ALERT_WEBHOOK_URL` (Slack/Discord incoming webhook) — see `src/notify.ts`.

## Error tracking

Set `SENTRY_DSN` (and optionally `SENTRY_TRACES_SAMPLE_RATE`) to capture unhandled API
errors and dead-letter events in Sentry. Without a DSN the integration is a safe no-op.

## Forced-failure drill (acceptance)

Run `npm test` (including `tests/observability-failure.test.ts`) for the deterministic offline
drill. It uses PGlite, a Telegram adapter with credentials explicitly blanked, an in-memory
Sentry transport, and a stubbed webhook. It verifies two scheduled retries, a dead-letter,
Sentry event capture, one Slack-style webhook payload, and the resulting metrics; every fetch
is intercepted and the test asserts no Telegram request occurred. This test does not claim
that the hosted Grafana dashboard or external Sentry/Slack accounts received the event.

Do not force a failure against a real Telegram/Mastodon account in production. A live Sentry/
Slack event and hosted Grafana scrape require explicit account access and a designated test
channel/environment.
