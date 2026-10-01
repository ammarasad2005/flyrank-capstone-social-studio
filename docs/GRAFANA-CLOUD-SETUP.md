# Grafana Cloud metrics and dashboard setup

The app exposes Prometheus metrics at `GET /metrics`. The importable dashboard is
`observability/grafana/social-media-studio.json`; metric and alert definitions live in
`docs/OBSERVABILITY.md`.

## Configure a hosted scrape

Grafana Cloud's **Metrics Endpoint** integration can scrape a publicly reachable
Prometheus-compatible URL without a collector service. The production endpoint is
`https://flyrank-social-studio.onrender.com/metrics`.

1. In Grafana Cloud, open **Connections → Add new connection → Metrics Endpoint**.
2. Before enabling the scrape, generate a random token of at least 32 characters, set it as
   `METRICS_AUTH_TOKEN` in the Render service environment, and deploy. Do not use or commit a
   social-platform credential for this purpose.
3. Add the URL above, use an appropriate scrape interval (one minute is sufficient for this
   capstone), configure **Bearer** authentication with the same token, and test the connection.
   The Metrics Endpoint integration's current setup asks for scrape credentials; confirm the
   exact options in your Grafana Cloud stack UI.
4. Import `observability/grafana/social-media-studio.json` from **Dashboards → New → Import**.
   Select the authenticated Prometheus data source created by the Metrics Endpoint integration.
5. Load the PromQL alert rules from `docs/OBSERVABILITY.md` and connect notifications to the
   approved Slack channel. The application-side dead-letter webhook remains independent.

The dashboard includes success rate (including reused successful attempts), publish outcomes,
retry rate, pending slots, dead-letter backlog and arrivals, publish p95 latency, and HTTP 5xx
rate. Success-rate expressions exclude no-traffic windows and use a small denominator floor so
low-volume traffic is not distorted.

## Trace visibility

BullMQ producer spans inject `sentry-trace`, `baggage`, and W3C `traceparent` into each slot job.
The worker continues that context and emits a child processing span; logs include the trace id.
Set `SENTRY_TRACES_SAMPLE_RATE` to a non-zero, intentionally chosen value to retain traces in
Sentry. The default remains `0` to avoid changing production event volume without an owner
choice. The request that originally scheduled a slot is not its parent today: the recurring DB
scanner begins the queue trace because it is decoupled from the HTTP request.

## Provisioning status and safe test policy

The dashboard definition and validation test are committed, but the hosted scrape and dashboard
have **not** been provisioned from this workspace: no Grafana Cloud account/API access was
provided. `METRICS_AUTH_TOKEN` is currently unset, so the production `/metrics` URL remains
public until an owner configures the optional Bearer gate in Render. Set the token before
connecting Grafana; do not add higher-sensitivity labels or per-customer data to a public scrape.

Do not force a real Telegram or Mastodon failure in production to test alerting. Use the offline
`tests/observability-failure.test.ts` drill: it exercises retry → dead-letter → Sentry transport
and Slack-style webhook using PGlite and local stubs, and asserts there was no platform request.
A separate live Sentry/Slack event still requires explicit approval and a designated test channel.

References: [Grafana Prometheus integration guide](https://grafana.com/docs/grafana-cloud/observe-and-act/send-data/metrics/metrics-prometheus/prometheus-config-examples/integration-guide/), [Grafana Metrics Endpoint integration](https://grafana.com/docs/grafana-cloud/monitor-infrastructure/integrations/integration-reference/integration-metrics-endpoint/), [Render deployment](https://render.com/docs/deploys).
