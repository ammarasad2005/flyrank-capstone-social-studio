# ADR 0004 — CI gates, startup migrations, and Render secrets

**Status:** accepted · **Date:** 2026-10-01 · **Sprint:** Tier 0 (T0-D)

## Context

The existing pull-request workflow only type-checked and ran the PGlite suite. Production
uses Neon through `DATABASE_URL`, migrations ran during module import, and secrets were
managed by Render. The workplan called for linting, dependency/secret scanning, safe
migrations, and a documented rotation process. There is one production Render service;
staging is intentionally deferred by the owner.

## Decisions

1. **PR CI is the delivery gate.** Run ESLint, `tsc`, PGlite tests, `npm audit` (fail on
   high/critical findings), and a Gitleaks scan on PRs to `main`. Actions are pinned to
   full SHAs. Dependabot checks npm and GitHub Actions weekly. A separate CI job runs the
   migration runner and concurrent `SKIP LOCKED` claim test on disposable real PostgreSQL.
   `main` branch protection requires all three checks, requires PRs, enforces the rule for
   administrators, and disables force-push/deletion (zero approvals so the owner can merge).
2. **Keep versioned SQL and the existing migrator.** Do not introduce an ORM solely to run
   migrations. The runner acquires a transaction-scoped PostgreSQL advisory lock, applies
   pending SQL and records filenames atomically in `_migrations`, and fails app startup if
   migration execution fails. This is a documented alternative to the originally suggested
   Drizzle/Prisma path; typed ORM queries remain out of scope.
3. **Use expand/contract for schema changes.** There are no automatic down-migrations;
   code rollback is not a database rollback. Take a provider restore point before destructive
   data changes and prefer a forward corrective migration.
4. **Keep secrets in Render service-scoped variables.** This is narrower than a shared
   group for the current single-service topology. A provider-neutral rotation runbook lives
   in `docs/SECRETS-ROTATION.md`.
5. **Defer staging.** PR checks are not a staging environment. Merging `main` still deploys
   directly to production until a separate staging service/manual-promotion path is approved.

## Consequences

- CI validates both the quick PGlite behavior and the production PostgreSQL-specific
  migration/concurrency path.
- Dependency and secret findings can fail the PR checks. Gitleaks comments/artifact upload
  are disabled to keep permissions read-only; the action still fails its job on a finding.
- Startup migrations are atomic and serialized, but are not a substitute for a reviewed
  backup/restore plan for destructive changes.
- T0-D staging acceptance and foundational F4 remain explicitly deferred. The SQL migrator
  is retained as an accepted deviation from the suggested ORM tool, not mislabeled as
  Drizzle/Prisma.
