import client from 'prom-client';

// Prometheus metrics. Scrape `GET /metrics`; point Grafana Cloud / Better Stack /
// a Prometheus server at it. Default process metrics are skipped under test to keep
// the suite fast and free of stray timers.
export const register = new client.Registry();
register.setDefaultLabels({ service: 'social-media-studio' });
if (process.env.NODE_ENV !== 'test') {
  client.collectDefaultMetrics({ register });
}

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const publishAttempts = new client.Counter({
  name: 'publish_attempts_total',
  help: 'Publish attempts by adapter and outcome (succeeded|failed|reused)',
  labelNames: ['adapter', 'outcome'] as const,
  registers: [register],
});

export const publishDuration = new client.Histogram({
  name: 'publish_duration_seconds',
  help: 'Adapter publish latency in seconds, by adapter and outcome',
  labelNames: ['adapter', 'outcome'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const retriesTotal = new client.Counter({
  name: 'publish_retries_total',
  help: 'Publish retries scheduled (backoff), by adapter',
  labelNames: ['adapter'] as const,
  registers: [register],
});

export const deadLettersTotal = new client.Counter({
  name: 'publish_dead_letters_total',
  help: 'Slots moved to the dead-letter state, by adapter and reason',
  labelNames: ['adapter', 'reason'] as const,
  registers: [register],
});

// Queue depth + DLQ backlog, sampled from the DB at scrape time.
export const slotsPending = new client.Gauge({
  name: 'slots_pending',
  help: 'Slots currently pending publication (queue depth)',
  registers: [register],
  async collect() {
    try {
      const { countSlotsByStatus } = await import('../repo.js');
      this.set(await countSlotsByStatus('pending'));
    } catch {
      /* DB not ready — leave the last value */
    }
  },
});

export const slotsDeadLetter = new client.Gauge({
  name: 'slots_dead_letter',
  help: 'Slots currently in the dead-letter state',
  registers: [register],
  async collect() {
    try {
      const { countSlotsByStatus } = await import('../repo.js');
      this.set(await countSlotsByStatus('dead_letter'));
    } catch {
      /* DB not ready */
    }
  },
});

// Collapse ids in a path so labels stay low-cardinality: /variants/12/approve -> /variants/:id/approve
export function normalizeRoute(path: string): string {
  return (
    '/' +
    path
      .split('/')
      .filter(Boolean)
      .map((seg) => (/^\d+$/.test(seg) ? ':id' : seg))
      .join('/')
  );
}
