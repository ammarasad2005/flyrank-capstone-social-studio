# Production secrets and rotation

## Where secrets live

The production app uses Render **service-scoped environment variables**. This is the chosen
approach for the current single-service deployment; no secret values belong in this public
repository. `.env` and `.env.local` are ignored by Git. `.env.example` must contain only
empty values or unmistakably fake placeholders.

Do not print secrets in application logs, CI output, issue comments, screenshots, or
`BUILDLOG.md`. CI runs Gitleaks against repository history and the PR change set. If a
credential is ever committed, revoke/rotate it immediately; deleting it from the latest
commit does not make it safe.

## Rotation procedure

For each affected credential:

1. Create or regenerate the replacement credential in its provider. Where possible, keep
   the old credential valid during the cutover.
2. Update the corresponding Render environment variable without pasting the value into Git.
3. Deploy/restart the service so the running process receives the replacement.
4. Verify `/ready` and the integration-specific smoke check below.
5. Revoke the old credential and confirm the app still works. If the service fails, restore
   the new value (not the revoked old one), inspect Render logs, and fix forward.
6. Record the date and variable name only—never the secret value—in the private rotation
   record.

| Render variable | Provider-side rotation | Post-rotation check |
|---|---|---|
| `DATABASE_URL` | Rotate the Neon database role password; copy the pooled connection string. | `/ready` returns DB `ok`; a database-backed route succeeds; verify persistence after a later deploy. |
| `REDIS_URL` | Rotate the Upstash Redis password/credential and update the TCP/TLS URL. | `/ready` returns queue `ok` with `QUEUE_DRIVER=bull`; publish queue starts. |
| `TELEGRAM_BOT_TOKEN` | Regenerate/revoke the token with BotFather. | Confirm the bot can send to the configured channel using an explicitly approved test message. |
| `ALERT_WEBHOOK_URL` | Revoke and recreate the Slack/Discord incoming webhook. | Send a clearly labeled setup notification; expect the webhook to accept it. |
| `SENTRY_DSN` | Rotate/disable the project client key if exposure requires it; update the DSN. | Trigger a controlled capture-path error and confirm the event in the correct Sentry project. |
| `MASTODON_ACCESS_TOKEN` | Revoke and create a replacement token with only the needed write scope. | Verify with a controlled, approved test post—or keep the adapter disabled. |
| `GEMINI_API_KEY` | Rotate the key in Google AI Studio / Cloud Console. | Make a non-production generation request and confirm no key is logged. |

`PORT`, `PLATFORMS`, `USE_AI`, `QUEUE_DRIVER`, `SCHEDULER_ENABLED`, `RETRY_MAX_ATTEMPTS`,
`RETRY_BASE_MS`, `METRICS_ENABLED`, and `LOG_LEVEL` are configuration, not credentials.

## Control-plane credentials

GitHub and Render API tokens are not application environment variables. Store them only in
the relevant account's secret manager/credential store, scope permissions narrowly, and
rotate them independently of the application cutover. Never place them in the repo's
`.env.example` or workflow YAML.

## Rotation timing

Rotate credentials after grading as planned, and immediately if a provider reports exposure
or Gitleaks finds a real credential. Rotate one dependency at a time where possible so a
failed integration can be isolated without taking the whole service offline.
