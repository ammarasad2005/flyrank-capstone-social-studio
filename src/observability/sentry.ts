import * as Sentry from '@sentry/node';

// Error tracking. Inert unless SENTRY_DSN is set, so the app runs identically with or
// without a Sentry account — set the DSN in prod to light it up. captureError() is a
// safe no-op when disabled, so call sites never need to branch.
let enabled = false;

export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
  });
  enabled = true;
  return true;
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export function sentryEnabled(): boolean {
  return enabled;
}
