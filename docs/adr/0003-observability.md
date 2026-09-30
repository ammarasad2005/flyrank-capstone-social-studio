# ADR 0003 — Observability: structured logs, Prometheus metrics, optional Sentry

Status: Accepted · Sprint 3 (T0-C)

## Context

Through Sprint 2 the service was correct and durable but effectively opaque in
production: logs were unstructured `console.*`, there were no metrics, `/ready` only
checked the DB, and a failure surfaced nowhere but the log. T0-C's objective is that
you can **see, debug, and alert** on the system — its acceptance is "a forced adapter
failure shows up in error tracking + a dashboard + an alert."

Constraint: the capstone must stay runnable in the sandbox and deployable on Render's
free tier (single service, no sidecars, no Grafana stack to stand up).

## Decision

**Structured logging — pino (C1).** One JSON logger (`src/observability/logger.ts`);
`pino-http` logs every request with a generated/propagated `x-request-id`. Publish and
queue paths log with `slotId` / `adapter` / `outcome`. Level via `LOG_LEVEL`; tests run
`silent` (`NODE_ENV=test`). JSON lines drop straight into Render's log stream / Loki /
Better Stack with no parsing.

**Metrics — prom-client, `GET /metrics` (C3).** A Prometheus text endpoint rather than
a full OpenTelemetry collector + Grafana deployment: zero infra, scrapeable by Grafana
Cloud / Better Stack / a Prometheus server, and it runs identically in the sandbox.
Series:
- `http_request_duration_seconds` (histogram; `method`, low-cardinality `route`, `status`)
- `publish_attempts_total` (`adapter`, `outcome=succeeded|failed|reused`)
- `publish_duration_seconds` (histogram; adapter latency by `adapter`, `outcome`)
- `publish_retries_total` (`adapter`) · `publish_dead_letters_total` (`adapter`, `reason`)
- `slots_pending`, `slots_dead_letter` (gauges sampled from the DB at scrape time)
- default Node/process metrics (skipped under test)

**Error tracking — Sentry, optional (C2).** `src/observability/sentry.ts` initialises
only when `SENTRY_DSN` is set; `captureError()` is a safe no-op otherwise, so the app
runs identically with or without an account. Wired into the Express error handler and
into `processSlot()` at dead-letter. Set the DSN in prod to light it up.

**Readiness — `/health` + `/ready` (C5).** `/health` = liveness (process up).
`/ready` now checks **DB** (`SELECT 1`) **and**, when `QUEUE_DRIVER=bull`, **Redis**
(`PING`), returning `503` with a per-check breakdown so the platform can gate traffic.

**Correlation (partial C4).** A request id is generated at the edge, returned in
`x-request-id`, and attached to every request log, giving web-side correlation. Full
distributed tracing across web → queue → worker → adapter (OpenTelemetry spans) is
recorded as the productionization step below rather than built now.

## Consequences

- Debuggable (structured logs + request ids), measurable (`/metrics`), and alertable
  (see `docs/OBSERVABILITY.md`) with **no extra infrastructure** — fits the free tier.
- A forced adapter failure now: increments `publish_retries_total` →
  `publish_dead_letters_total`, fires the DLQ alert (`ALERT_WEBHOOK_URL`), is captured
  in Sentry (when a DSN is set), and is visible on `/metrics` — satisfying the epic's
  acceptance.
- prom-client's DB-sampling gauges query on each scrape; cheap here, and easily moved
  to a cached/periodic collector if scrape volume grows.
- **Not yet done (future):** OpenTelemetry traces spanning the queue hop (C4 in full),
  and shipping metrics to a hosted dashboard with the alert rules loaded (C6 is
  specified in `docs/OBSERVABILITY.md`, not yet provisioned).
