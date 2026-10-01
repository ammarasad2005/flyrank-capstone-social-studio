# Release and migration runbook

## CI gates

A pull request targeting `main` runs three required checks:

1. **`build-test`** — `npm ci`, ESLint, TypeScript type-check, the PGlite unit/integration
   suite, and `npm audit --audit-level=high`.
2. **`postgres-concurrency`** — starts a disposable PostgreSQL service, applies migrations,
   reruns them to prove idempotency, then has concurrent callers claim due slots. The test
   asserts that each slot is claimed once and cleans up its rows.
3. **`gitleaks`** — scans the repository history for credentials. The workflow checks out
   full history, and the action is configured not to post comments or upload artifacts.

Actions are pinned to full commit SHAs. Dependabot checks npm and GitHub Actions weekly.

## Deploy behavior

- `main` auto-deploys to the Render production service. A separate staging service is
  intentionally **deferred**; PR checks are review/quality gates, not a staging environment.
- Render injects secrets at runtime as service-scoped environment variables. Never put
  live values in `.env.example`, GitHub workflow files, docs, or commit messages.
- The server imports `src/db.ts` before opening its HTTP listener. If a migration fails,
  startup fails rather than accepting traffic against an incomplete schema.

## Migration guarantees and limits

`migrations/*.sql` are applied in filename order by the small SQL migrator in `src/db.ts`.
The migration ledger and all pending DDL are applied in one database transaction, guarded
by a PostgreSQL transaction-scoped advisory lock. That makes a failed batch roll back and
prevents two app/worker processes from applying the same migration simultaneously. The
runner is idempotent: an applied filename is recorded in `_migrations` and skipped later.

There are **no automatic down-migrations**. A Render code rollback does not roll back the
database schema. Use an expand/contract rollout:

1. Before a destructive/data-changing migration, confirm a Neon restore point or equivalent
   backup is available for the database plan in use.
2. First add backward-compatible columns/tables/indexes; deploy code that can work with old
   and new forms.
3. Backfill separately in bounded, observable batches where necessary.
4. Only in a later release, remove obsolete schema after all deployed code has stopped
   using it. Prefer a forward corrective migration over an automatic rollback.
5. If startup fails, inspect Render logs and the `_migrations` ledger; correct the SQL in a
   new migration or a reviewed repair commit. Do not manually delete a ledger row unless
   the corresponding schema change has also been inspected.

Keep migrations small and transactional. Do not use statements that cannot run inside a
transaction (for example, `CREATE INDEX CONCURRENTLY`) in this boot-time migration path; if
such a change is needed, design a separate operational migration step first.

## Release checklist

- [ ] PR targets `main`; all three required status checks pass.
- [ ] No credential is included in the diff; the Gitleaks scan is green.
- [ ] Migration is additive/backward-compatible, or has an explicit backup and recovery
      plan reviewed before merge.
- [ ] After deploy, verify `/health`, `/ready`, and (when enabled) `/metrics`.
- [ ] For data-affecting changes, verify the relevant read/write flow and record evidence.
- [ ] If a deploy fails, stop and inspect logs before retrying; do not repeatedly redeploy
      a migration that partially changed the schema outside a transaction.

## Deferred by owner decision

As of 2026-10-01, no staging service or manual promote path is provisioned. The main branch
still auto-deploys to production after merge. Revisit this before onboarding customer data
or if the workplan's full Tier-0 environment criterion becomes mandatory.
