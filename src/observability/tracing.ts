import * as Sentry from '@sentry/node';

/** Trace metadata persisted in a BullMQ job so a different worker can continue the trace. */
export interface TraceCarrier {
  sentryTrace?: string;
  baggage?: string;
  traceparent?: string;
  traceId?: string;
}

/** Capture Sentry's queue-safe headers plus the standard W3C traceparent. */
export function captureTraceCarrier(): TraceCarrier {
  const data = Sentry.getTraceData({ propagateTraceparent: true });
  const carrier: TraceCarrier = {
    sentryTrace: data['sentry-trace'],
    baggage: data.baggage,
    traceparent: data.traceparent,
  };
  const traceId = traceIdFromCarrier(carrier);
  if (traceId) carrier.traceId = traceId;
  return carrier;
}

/** Extract a trace id from W3C Trace Context, falling back to Sentry's trace header. */
export function traceIdFromCarrier(carrier?: TraceCarrier | null): string | undefined {
  if (!carrier) return undefined;
  const traceparent = carrier.traceparent?.match(/^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i);
  if (traceparent) return traceparent[1].toLowerCase();
  const sentryTrace = carrier.sentryTrace?.match(/^([\da-f]{32})-[\da-f]{16}(?:-[01])?$/i);
  if (sentryTrace) return sentryTrace[1].toLowerCase();
  return undefined;
}

/** Run a queue consumer under the producer trace; tolerate legacy or unsampled jobs. */
export function continueQueueTrace<T>(carrier: TraceCarrier | undefined, callback: () => T): T {
  if (carrier?.sentryTrace) {
    return Sentry.continueTrace({ sentryTrace: carrier.sentryTrace, baggage: carrier.baggage }, callback);
  }
  return Sentry.startNewTrace(callback);
}

/** Start an independent root trace for scheduled work with no HTTP parent. */
export function startQueueTrace<T>(callback: () => T): T {
  return Sentry.startNewTrace(callback);
}
