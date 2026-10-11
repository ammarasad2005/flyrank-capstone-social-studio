import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Sentry from '@sentry/node';
import {
  captureTraceCarrier,
  continueQueueTrace,
  traceIdFromCarrier,
  type TraceCarrier,
} from '../src/observability/tracing.js';

// Use a transport that discards telemetry; the test proves context propagation only
// and never sends spans or errors to an external service.
Sentry.init({
  dsn: 'https://public@example.invalid/1',
  environment: 'test',
  tracesSampleRate: 1,
  transport: () => ({
    send: async () => ({ statusCode: 200 }),
    flush: async () => true,
  }),
});

after(async () => {
  await Sentry.close(1_000);
});

test('Sentry trace context continues across a serialized queue boundary', async () => {
  let producer!: TraceCarrier;
  let consumer!: TraceCarrier;

  await Sentry.startNewTrace(async () => {
    await Sentry.startSpan({ name: 'bullmq.enqueue_slot', op: 'queue.publish' }, async () => {
      producer = captureTraceCarrier();
      assert.match(producer.traceparent ?? '', /^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/i);
      assert.match(producer.sentryTrace ?? '', /^[\da-f]{32}-[\da-f]{16}-[01]$/i);

      // This represents serializing the carrier into BullMQ job data and extracting
      // it in another worker process.
      const serialized = JSON.parse(JSON.stringify(producer)) as TraceCarrier;
      await continueQueueTrace(serialized, async () => {
        await Sentry.startSpan({ name: 'bullmq.process_slot', op: 'queue.process' }, () => {
          consumer = captureTraceCarrier();
        });
      });
    });
  });

  assert.equal(consumer.traceId, producer.traceId, 'producer and consumer remain in one trace');
  assert.equal(traceIdFromCarrier(consumer), traceIdFromCarrier(producer));
  assert.notEqual(consumer.traceparent?.split('-')[2], producer.traceparent?.split('-')[2], 'consumer gets its own span id');
});

test('trace-id extraction rejects malformed propagation headers', () => {
  assert.equal(traceIdFromCarrier({ traceparent: 'not-a-trace' }), undefined);
  assert.equal(traceIdFromCarrier({ sentryTrace: 'not-a-trace' }), undefined);
});
