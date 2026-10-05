# Grafana Cloud & Observability Handoff Handbook

**Prepared:** 2026-10-05

**Purpose:** give the owner a safe, reproducible path to enable the hosted metrics scrape, import the dashboard and alert rules, and hand the remaining work back to the agent without putting credentials in Git or chat.

## Current state — read this first

- [PR #11](https://github.com/ammarasad2005/flyrank-capstone-social-studio/pull/11) is open and unmerged. The feature implementation passed the required checks; use the PR's live **Checks** tab to confirm the latest commit before merging (this handbook adds the final setup artifacts).
- Merging `main` auto-deploys the app to Render. The optional `METRICS_AUTH_TOKEN` gate is in PR #11, not yet in production. **Do not set this variable on Render until the PR is merged and the deployment is live.**
- The production metrics endpoint is `https://flyrank-social-studio.onrender.com/metrics`. It is currently public because the token gate is not deployed and no token has been configured.
- No Grafana Cloud scrape, dashboard, or alert rules have been provisioned yet. No production environment was changed for Sprint 6.
- `SENTRY_TRACES_SAMPLE_RATE` remains `0`. Queue trace propagation is implemented and locally tested, but Sentry does not retain sampled traces at this setting.
- Staging remains deferred. Do not force a failure through a real Telegram or Mastodon account to test alerts.

**Required decision before the Render steps:** explicitly authorize the PR merge, or keep the PR open. To authorize it, tell the agent: **“I approve merging PR #11; I understand this triggers a production deployment to Render.”** Do not assume this handbook itself is merge approval.

---

## What to prepare

| Item | Needed for | Safe handling |
| --- | --- | --- |
| Grafana Cloud stack URL/name | Agent handoff and dashboard/scrape verification | Safe to share; do not share your Grafana password |
| `METRICS_AUTH_TOKEN` | Protecting `/metrics` and authenticating Grafana's scrape | Generate a new dedicated token; enter it directly in Render and Grafana; **do not send it in chat or commit it** |
| Dedicated Slack test channel | Safely testing Grafana notifications | Use a non-production channel/webhook and approve one test message |
| Temporary Grafana access (optional) | Letting the agent configure the Grafana UI/API directly | Use a short-lived service account with the least permissions available; revoke it after the handoff. If no secure way to provide it is available, do the Grafana UI steps yourself and send only the non-secret results. |
| Trace sampling choice (optional) | Seeing trace samples in Sentry | Default is to leave it at `0`; changing it is a separate production configuration decision |

The existing Sentry and application webhook credentials are already stored in Render. **Do not resend them.** Grafana's Slack contact point is configured separately from the app's `ALERT_WEBHOOK_URL`.

---

## Phase 1 — approve and deploy the code

1. Open [PR #11](https://github.com/ammarasad2005/flyrank-capstone-social-studio/pull/11) and confirm it is the expected branch and change set.
2. If you want the production metrics endpoint to support authentication, authorize the merge using the sentence above, or merge it yourself. If you are not ready for a production deployment, stop here; you can create a Grafana Cloud stack, but do not configure its scrape yet.
3. Wait for Render's deployment of `main` to finish successfully.
4. Check that `https://flyrank-social-studio.onrender.com/health` returns HTTP 200 and `/ready` returns a ready response. If either fails, stop and resolve the deploy before changing environment variables.

The merge adds optional Bearer authentication only when `METRICS_AUTH_TOKEN` is set. With the variable empty, the route keeps its existing behavior. No social-platform configuration is changed by this feature.

---

## Phase 2 — create and configure the metrics token

### 2.1 Generate a dedicated token

Generate a new 32-byte random token (64 hexadecimal characters), for example in a local terminal:

```bash
openssl rand -hex 32
```

A Python alternative is:

```bash
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

Save the value in a password manager or other approved secret store so you can enter the **same value** into both Render and Grafana. Do not reuse the Telegram, Mastodon, Sentry, Slack, GitHub, Neon, Redis, or other existing credentials. Do not put the token in a `.env` file that is committed, an issue, a PR comment, a screenshot, or this handoff packet.

### 2.2 Add it to the Render service

Only do this after Phase 1 is complete.

1. Sign in to the Render Dashboard and open the web service whose URL is `flyrank-social-studio.onrender.com`.
2. Open **Environment**.
3. Under **Environment Variables**, choose **Add Environment Variable**.
4. Set the key to exactly `METRICS_AUTH_TOKEN`; paste the new value into the value field. Do not add quotes or spaces.
5. Choose **Save and deploy** so the running service receives the value. Wait for the deployment to become live.
6. If any other metrics scraper already exists, update it with the same token before or during this change; unauthenticated requests will now receive 401.

Render's environment-variable workflow and deploy choices are documented [here](https://render.com/docs/configure-environment-variables).

### 2.3 Verify the gate without exposing the token

The expected result is **401 without a token** and **200 with the correct Bearer token**. On macOS/Linux, this Python check prompts for the token without putting it in the command history or printing it:

```bash
python3 - <<'PY'
from getpass import getpass
from urllib.error import HTTPError
from urllib.request import Request, urlopen

url = 'https://flyrank-social-studio.onrender.com/metrics'

def status(request):
    try:
        with urlopen(request, timeout=30) as response:
            return response.status
    except HTTPError as error:
        return error.code

print('No auth:', status(Request(url)))
token = getpass('Metrics token (hidden): ')
request = Request(url, headers={'Authorization': f'Bearer {token}'})
print('Bearer auth:', status(request))
PY
```

Expected output: `No auth: 401` and `Bearer auth: 200`. If you get 401 for both, check for an extra space, a stale deploy, or a token typo. If you get 200 without a token, stop: the authenticated build or variable is not active yet. Never paste the token or a command containing its literal value into the handoff.

---

## Phase 3 — create the Grafana Cloud scrape

1. Sign in to Grafana Cloud and open the stack where you want the service metrics. If you have no stack, create/select one and note its stack name and URL. Review the current plan and usage limits before enabling ingestion.
2. In the stack, open **Connections → Add new connection → Metrics Endpoint**. Grafana's Metrics Endpoint integration scrapes a publicly reachable Prometheus-compatible URL without a collector; its current integration instructions require scrape credentials. See the [integration guide](https://grafana.com/docs/grafana-cloud/observe-and-act/send-data/metrics/metrics-prometheus/prometheus-config-examples/integration-guide/) and [Metrics Endpoint reference](https://grafana.com/docs/grafana-cloud/monitor-infrastructure/integrations/integration-reference/integration-metrics-endpoint/).
3. Create a scrape job with:
   - **Name:** `flyrank-social-studio-prod`
   - **URL:** `https://flyrank-social-studio.onrender.com/metrics`
   - **Authentication:** Bearer
   - **Credential:** the same `METRICS_AUTH_TOKEN` you entered in Render (paste only into Grafana's credential field)
   - **Scrape interval:** 60 seconds is a reasonable starting point for this capstone
4. Use Grafana's **Test connection** action, then save the scrape job. Confirm that Grafana reports the target healthy/connected.
5. Open **Explore**, select the Prometheus data source created by the integration, and query:

   ```promql
   up{job="flyrank-social-studio-prod"}
   ```

   A value of `1` indicates a successful scrape. Also try `slots_pending` and `slots_dead_letter`. `publish_attempts_total` may have no series until an attempt has occurred; some panels can correctly show no data during quiet periods.
6. Record the Grafana stack URL/name, scrape-job name/status, and Prometheus data-source name/UID for the handoff. These are not secrets. Do not include the Bearer token.

If the Metrics Endpoint integration shows a different menu or authentication form, follow the stack UI and tell the agent the exact screen/field labels; Grafana Cloud's UI can vary by stack and release.

---

## Phase 4 — import the dashboard

The JSON artifact is `observability/grafana/social-media-studio.json` in the PR branch/repository. Importing it through the Grafana UI is documented [here](https://grafana.com/docs/grafana-cloud/visualizations/dashboards/build-dashboards/import-dashboards/).

1. In Grafana, open **Dashboards → New → Import dashboard**.
2. Upload `observability/grafana/social-media-studio.json` from a local clone/download of the repo. If you need to download it from the open branch, use the [raw JSON file](https://raw.githubusercontent.com/ammarasad2005/flyrank-capstone-social-studio/feat/sprint-6-observability/observability/grafana/social-media-studio.json).
3. When prompted to map the `DS_PROMETHEUS` input, choose the Prometheus data source created in Phase 3.
4. Use a folder such as `Social Media Studio` and import the dashboard.
5. Confirm that the dashboard has seven panels, including publish outcomes/rates, retry/DLQ signals, pending depth, latency, and HTTP 5xx rate. A quiet success-rate panel showing no data can be expected when there is no publish traffic; the expressions deliberately suppress no-traffic alerts.

Do not add customer-specific labels or other sensitive data to this public service's metrics.

---

## Phase 5 — configure a safe notification destination

Grafana notifications and the app's immediate dead-letter webhook are separate paths. Do not assume the Render `ALERT_WEBHOOK_URL` is the right destination for Grafana, and do not change the Grafana stack's global/default notification policy for this project.

1. Create or select a **dedicated non-production Slack channel** for observability tests. Confirm that one test message is acceptable there.
2. In Grafana, open **Alerts & IRM → Alerting → Notification configuration → Contact points** (labels can vary slightly by UI version).
3. Add a contact point named, for example, `social-studio-test-slack`; choose Slack and enter the dedicated test-channel webhook or the approved Slack integration credentials directly into Grafana. Do not put the webhook value in the repo or handoff packet.
4. Use Grafana's **Test** action once and confirm the message arrives in that test channel. This verifies the Grafana-to-Slack contact point, not the service's dead-letter rule.
5. Report only the contact-point name and whether the test succeeded. Do not send the webhook URL.

Grafana's Slack contact-point instructions are [here](https://grafana.com/docs/grafana-cloud/alerting-and-irm/alerting/configure-notifications/manage-contact-points/integrations/configure-slack/).

---

## Phase 6 — import and route the alert rules

The standalone Prometheus rule file is `observability/prometheus/alerts.yml`. It defines:

| Alert | Condition |
| --- | --- |
| `PublishSuccessRateLow` | Success below 90% for 10m, only when there is traffic |
| `DeadLetterArrivals` | Any dead-letter arrival in a 15m window |
| `QueueBacklogHigh` | More than 50 pending slots for 10m |
| `AdapterErrorSpike` | Adapter failure rate above 20% for 5m, only when there is traffic |
| `Api5xxSpike` | API 5xx rate above 5% for 5m, only when there is traffic |

These thresholds are starting points, not a promise of a particular on-call policy.

1. In Grafana, open **Alerting → Alert rules**.
2. In the **Data source-managed alert rules** section, choose **Import to Grafana-managed rules**. Select **Prometheus YAML file** as the import source, then select the Prometheus data source from Phase 3.
3. Upload `observability/prometheus/alerts.yml`. Choose a project folder/namespace such as `Social Media Studio`, review the five rules and expressions, and import them. Grafana's current import instructions are [here](https://grafana.com/docs/grafana-cloud/observe-and-act/alert-and-measure-reliability/alerting/alerting-rules/alerting-migration/).
4. Route these rules to the dedicated test contact point from Phase 5. Either assign that contact point directly to each rule, or create a child notification policy matching `service=social-media-studio`. Do **not** edit the global/default policy to test this project.
5. Preview/evaluate each rule and confirm the expected labels (`service=social-media-studio`, `severity=page|warning`). With no traffic or no dead-letter events, a rate/arrival rule can correctly show Normal or No Data; do not fabricate a real production failure to make it fire.
6. After the test phase is approved and complete, agree on whether to keep alerts routed to the test channel or change them to an operational channel. Do not silently switch the route to a production channel.

The app also sends an immediate dead-letter notification using Render's `ALERT_WEBHOOK_URL`; that remains independent of Grafana's Prometheus alert rules.

---

## Phase 7 — safe verification boundaries

Already proven locally by `npm test`:

- Trace continuation across serialized queue data.
- Credential-less Telegram failure → two retries → dead-letter.
- Sentry exception accepted by an in-memory transport and one webhook accepted by a local stub.
- No Telegram platform request was made.
- Dashboard JSON and key signals validated.
- Optional `/metrics` Bearer gate rejects missing/wrong tokens and accepts the correct token.

A Grafana contact-point test proves Grafana can message the approved test channel. It does **not** by itself prove that a real application dead-letter reached Sentry and Grafana. The current capstone has no staging environment; therefore:

- Do not force a failed publish on production Telegram or Mastodon.
- Do not manufacture a production dead-letter merely to make the dashboard light up.
- If a full live failure → Sentry → Slack test is still required, first agree on an isolated non-production service/database/queue with social adapters disabled or mocked, plus a dedicated Sentry environment and Slack test channel. The existing staging decision would need to be revisited explicitly.
- If you only authorize a notification-routing smoke test, use Grafana's contact-point **Test** action (or a temporary synthetic Grafana rule routed only to the test contact point), then delete the temporary rule. Label this as a routing smoke test, not an end-to-end DLQ test.
- Keep `SENTRY_TRACES_SAMPLE_RATE=0` unless you separately approve a rate and environment for a trace-visibility test. A non-zero value can increase Sentry event volume.

---

## Handoff packet — fill this in and send it back

Copy this block, fill in only the non-secret values/statuses, and omit all token/webhook/DSN values:

```text
PR #11 merge authorization: not yet / authorized
If authorized, I understand merge deploys main to production: yes / no
Render deployment after merge: not started / live (deployment ID or timestamp: ______)
METRICS_AUTH_TOKEN set in Render: yes / no             [do not include value]
Unauthenticated /metrics check: 401 / other: ______
Authenticated /metrics check: 200 / other: ______      [do not include value]
Grafana stack name and URL: ______
Metrics Endpoint job name and status: ______
Prometheus data-source name/UID: ______
Dashboard imported: yes / no
Five alert rules imported: yes / no
Dedicated Slack test contact-point name: ______
Contact-point test approved and received: yes / no
May the agent configure Grafana directly using temporary scoped access: yes / no
If yes, secure access method available (do not paste token here): ______
May the agent send one synthetic routing test to the named non-production channel: yes / no
Named test channel (name only): ______
Sentry trace sampling: keep 0 / approve temporary value ______ in environment ______
```

The existing Sentry DSN, Render webhook, platform tokens, and all other credentials do not belong in this reply. If there is no secure credential handoff for Grafana, complete the UI steps yourself and send the filled packet; the agent can then review the dashboard/rules and continue from the non-secret status information.

## References

- [Grafana Cloud Metrics Endpoint integration](https://grafana.com/docs/grafana-cloud/monitor-infrastructure/integrations/integration-reference/integration-metrics-endpoint/)
- [Grafana dashboard import](https://grafana.com/docs/grafana-cloud/visualizations/dashboards/build-dashboards/import-dashboards/)
- [Import Prometheus alert rules](https://grafana.com/docs/grafana-cloud/observe-and-act/alert-and-measure-reliability/alerting/alerting-rules/alerting-migration/)
- [Configure a Slack contact point](https://grafana.com/docs/grafana-cloud/alerting-and-irm/alerting/configure-notifications/manage-contact-points/integrations/configure-slack/)
- [Render environment variables and secrets](https://render.com/docs/configure-environment-variables)
- [Render Preview Environments and billing](https://render.com/docs/preview-environments)
