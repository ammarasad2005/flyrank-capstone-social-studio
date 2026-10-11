# ADR 0005 — Defer a persistent staging environment

Status: Accepted · 2026-10-02

## Context

Production `main` deploys directly to the Render service, so a staging environment could catch
Render-specific configuration, boot, and health-check issues before promotion. The capstone is
currently operated by one owner and has no onboarded customer data. Required PR checks already
exercise disposable real PostgreSQL and Redis, including migration replay, claim contention,
and BullMQ crash recovery. The normal PGlite suite and secret scan also run before merge.

A safe staging copy would need independent Postgres state, Redis/BullMQ keyspace, platform
credentials or an enforced mock-only adapter set, Sentry environment, and Slack alert routing.
Copying production environment variables into a preview would risk real posts or noisy alerts.
Render's native Preview Environments require a Pro workspace and bill preview resources at
normal service rates; see [Render Preview Environments](https://render.com/docs/preview-environments)
and [Render pricing](https://render.com/pricing). The current repo also has no `render.yaml`
Blueprint to replicate services safely.

## Decision

Do **not** provision a persistent staging service or manual promotion path now. Keep the PR
review and required CI jobs as pre-merge gates, not as a claim that CI is staging. Keep external
platform adapters out of integration tests; use mock adapters and disposable local/CI services.
`main` remains the production auto-deploy branch.

## Consequences

- Avoids duplicating stateful services, credentials, alert destinations, and ongoing service
  cost while the project has no customer data.
- Render-specific boot and secret-configuration regressions can still reach production after a
  green PR; apply the existing additive-migration runbook and verify `/health`, `/ready`, and
  `/metrics` after deploy.
- Revisit before customer-data onboarding, a destructive migration, a production incident, or
  when a second operator needs a manual QA/promotion gate. If staging is added, isolate DB,
  Redis, Sentry, and alert destinations; default all social platforms to mocks and use dedicated
  test credentials only for explicitly approved live smoke tests.
