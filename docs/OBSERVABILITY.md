# Observability & operability (T0-C)

How to see, debug, and alert on the Social Media Studio.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness — process is up. Always cheap. |
| `GET /ready` | Readiness — checks DB, and Redis when `QUEUE_DRIVER=bull`. `200` ready / `503` not-ready with a per-check breakdown. |
| `GET /metrics` | Prometheus metrics (disable with `METRICS_ENABLED=false`). |

Point your platform's health check at `/ready` (gates traffic) and `/health` (restarts).

## Logs

Structured JSON via **pino** — one object per line. Every HTTP request is logged with a
generated/propagated `x-request-id` (returned as a response header) plus `responseTime`.
Publish/queue events log `slotId`, `adapter`, and `outcome`. Control verbosity with
`LOG_LEVEL` (`info` default; `silent` under `NODE_ENV=test`). Ship the stream to Render
logs / Grafana Loki / Better Stack as-is.

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
```

## Alerting rules (C6)

Load these into Prometheus/Grafana/Better Stack. Thresholds are starting points.

```yaml
groups:
  - name: social-media-studio
    rules:
      # Publish success-rate drop (< 90% over 10m, once there's traffic)
      - alert: PublishSuccessRateLow
        expr: |
          sum(rate(publish_attempts_total{outcome="succeeded"}[10m]))
          /
          clamp_min(sum(rate(publish_attempts_total[10m])), 1) < 0.9
        for: 10m
        labels: { severity: page }

      # DLQ arrivals — anything landing in the dead-letter queue
      - alert: DeadLetterArrivals
        expr: increase(publish_dead_letters_total[15m]) > 0
        for: 0m
        labels: { severity: page }

      # Queue backlog / scheduler lag
      - alert: QueueBacklogHigh
        expr: slots_pending > 50
        for: 10m
        labels: { severity: warning }

      # Adapter 5xx / error spike (failed publishes)
      - alert: AdapterErrorSpike
        expr: sum by (adapter) (rate(publish_attempts_total{outcome="failed"}[5m])) > 0.2
        for: 5m
        labels: { severity: warning }

      # API 5xx spike
      - alert: Api5xxSpike
        expr: |
          sum(rate(http_request_duration_seconds_count{status=~"5.."}[5m]))
          /
          clamp_min(sum(rate(http_request_duration_seconds_count[5m])), 1) > 0.05
        for: 5m
        labels: { severity: warning }
```

Independently of Prometheus, a dead-letter also fires an **immediate push alert** via
`ALERT_WEBHOOK_URL` (Slack/Discord incoming webhook) — see `src/notify.ts`.

## Error tracking

Set `SENTRY_DSN` (and optionally `SENTRY_TRACES_SAMPLE_RATE`) to capture unhandled API
errors and dead-letter events in Sentry. Without a DSN the integration is a safe no-op.

## Forced-failure drill (acceptance)

Schedule a `telegram` slot with the bot token unset (or `ADAPTER_OVERRIDE` to a failing
adapter). Expected: `publish_retries_total{adapter="telegram"}` climbs, then
`publish_dead_letters_total{adapter="telegram"}` increments, the `ALERT_WEBHOOK_URL`
webhook fires, Sentry receives the event (if a DSN is set), and `slots_dead_letter`
rises — all visible on `/metrics`.
