import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dashboard = JSON.parse(
  await readFile(new URL('../observability/grafana/social-media-studio.json', import.meta.url), 'utf8'),
);

test('Grafana dashboard JSON is importable and covers core service signals', () => {
  assert.equal(dashboard.title, 'FlyRank Social Studio — Reliability');
  assert.equal(dashboard.uid, 'flyrank-social-studio');
  assert.ok(dashboard.__inputs.some((input: any) => input.pluginId === 'prometheus'));
  assert.ok(dashboard.panels.length >= 7);

  const expressions = dashboard.panels.flatMap((panel: any) => panel.targets.map((target: any) => target.expr));
  for (const metric of [
    'publish_attempts_total',
    'publish_retries_total',
    'publish_dead_letters_total',
    'slots_pending',
    'slots_dead_letter',
    'publish_duration_seconds_bucket',
    'http_request_duration_seconds_count',
  ]) {
    assert.ok(expressions.some((expr: string) => expr.includes(metric)), `dashboard includes ${metric}`);
  }

  const successRate = expressions.find((expr: string) => expr.includes('publish_attempts_total{outcome=~'));
  assert.ok(successRate);
  assert.ok(successRate.includes('succeeded|reused'), 'reused successful attempts count as success');
  assert.ok(successRate.includes('and sum(rate'), 'no-traffic windows do not report a false zero success rate');
});
