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

**Correlation (C4 completed in Sprint 6).** A request id is generated at the edge and
returned in `x-request-id`. BullMQ slot producers create Sentry spans with W3C trace context
and OpenTelemetry messaging attributes, then serialize `sentry-trace`, `baggage`, and
`traceparent` into each job. The worker continues that context and emits a child processing
span; producer/consumer logs carry the same trace id.
The periodic DB scanner is the root because queue processing is decoupled from the original
HTTP scheduling request. `SENTRY_TRACES_SAMPLE_RATE` controls retention and remains `0` by
default so production event volume is not silently increased.

## Consequences

- Debuggable (structured logs + request ids), measurable (`/metrics`), and alertable
  (see `docs/OBSERVABILITY.md`) with **no extra infrastructure** — fits the free tier.
- The failure path increments `publish_retries_total` and `publish_dead_letters_total`,
  calls the webhook and Sentry capture hooks, and is reflected on `/metrics`. The offline
  integration test proves this with an in-memory Sentry transport and a webhook stub, without
  calling a social platform. Hosted Grafana ingestion and an external Sentry/Slack event remain
  unverified, so the T0-C epic acceptance is still open.
- prom-client's DB-sampling gauges query on each scrape; cheap here, and easily moved
  to a cached/periodic collector if scrape volume grows.
- **Not yet done:** provisioning the hosted Grafana Cloud scrape/dashboard and verifying the
  failure alert in an approved external Sentry/Slack target (C6). The importable dashboard and
  setup instructions are in the repository; no Grafana account/API access was provided.
