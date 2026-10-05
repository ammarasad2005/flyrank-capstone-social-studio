import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import * as Sentry from '@sentry/node';
import { claimDueSlot, reclaimStuckSlots, setSlotStatus } from '../repo.js';
import { processSlot } from '../process-slot.js';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import {
  captureTraceCarrier,
  continueQueueTrace,
  startQueueTrace,
  traceIdFromCarrier,
  type TraceCarrier,
} from '../observability/tracing.js';
import type { PublishQueue } from './types.js';
import { BULL_QUEUE_NAME } from './constants.js';

type SlotJobData = {
  slotId: number;
  traceContext?: TraceCarrier;
  enqueuedAt?: number;
};

/**
 * Bull driver (Upstash/Redis). Redis becomes the coordination layer for a fleet of
 * workers, but the publish SEMANTICS are unchanged: a repeatable "scan" job claims
 * due slots via the same SKIP-LOCKED query and enqueues one "slot" job each; the
 * worker runs every slot through the shared processSlot(). Retry/backoff/dead-letter
 * stay in the DB (see repo.recordSlotFailure) rather than using Bull-native retries,
 * so both drivers behave identically and the model is testable without a broker.
 *
 * Trace headers are attached to each slot job and resumed by the consumer span. CI
 * runs a disposable real-Postgres/Redis worker-restart check; production enables this
 * driver via QUEUE_DRIVER=bull + REDIS_URL.
 */
export class BullQueue implements PublishQueue {
  private connection: IORedis;
  private queue: Queue;
  private worker: Worker | null = null;

  constructor() {
    // BullMQ requires maxRetriesPerRequest: null on the shared connection.
    this.connection = new IORedis(config.queue.redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(BULL_QUEUE_NAME, { connection: this.connection });
  }

  async start(): Promise<void> {
    // requeue crash-orphaned work, same as the in-process driver
    const stuck = await reclaimStuckSlots();
    for (const s of stuck) {
      logger.info({ slotId: s.id }, "bull: reclaiming stuck slot (was 'publishing')");
      await setSlotStatus(s.id, 'pending');
    }

    this.worker = new Worker(BULL_QUEUE_NAME, (job) => this.process(job), {
      connection: this.connection,
      concurrency: 4,
    });
    this.worker.on('failed', (job, err) => {
      const data = job?.data as Partial<SlotJobData> | undefined;
      logger.error(
        {
          jobId: job?.id,
          slotId: data?.slotId,
          traceId: traceIdFromCarrier(data?.traceContext),
          err,
        },
        'bull: job failed',
      );
    });

    // one repeatable "scan" tick; the scheduler id keeps it a singleton across restarts
    await this.queue.upsertJobScheduler(
      'scan',
      { every: config.scheduler.tickMs },
      { name: 'scan', data: {}, opts: { removeOnComplete: true, removeOnFail: true } },
    );
    logger.info({ tickMs: config.scheduler.tickMs }, 'bull queue started');
  }

  private async process(job: Job): Promise<void> {
    if (job.name === 'scan') {
      let slot = await claimDueSlot();
      while (slot) {
        const slotId = slot.id;
        await startQueueTrace(() =>
          Sentry.startSpan(
            {
              name: 'bullmq.enqueue_slot',
              op: 'queue.publish',
              attributes: {
                'messaging.system': 'redis',
                'messaging.destination.name': BULL_QUEUE_NAME,
                'messaging.operation.type': 'send',
                'messaging.message.id': `slot-${slotId}`,
                'slot.id': slotId,
              },
            },
            async (span) => {
              const traceContext = captureTraceCarrier();
              const queued = await this.queue.add(
                'slot',
                { slotId, traceContext, enqueuedAt: Date.now() } satisfies SlotJobData,
                { removeOnComplete: true, removeOnFail: true },
              );
              span.setAttribute('messaging.message.id', String(queued.id ?? `slot-${slotId}`));
              logger.info(
                { slotId, jobId: queued.id, traceId: traceIdFromCarrier(traceContext) },
                'bull: slot enqueued',
              );
            },
          ),
        );
        slot = await claimDueSlot();
      }
      return;
    }

    if (job.name === 'slot') {
      const data = job.data as SlotJobData;
      const traceId = traceIdFromCarrier(data.traceContext);
      const receiveLatencyMs = typeof data.enqueuedAt === 'number'
        ? Math.max(0, Date.now() - data.enqueuedAt)
        : undefined;

      await continueQueueTrace(data.traceContext, () =>
        Sentry.startSpan(
          {
            name: 'bullmq.process_slot',
            op: 'queue.process',
            attributes: {
              'messaging.system': 'redis',
              'messaging.destination.name': BULL_QUEUE_NAME,
              'messaging.operation.type': 'process',
              'messaging.message.id': String(job.id ?? `slot-${data.slotId}`),
              'messaging.message.retry.count': job.attemptsMade,
              'slot.id': data.slotId,
              ...(receiveLatencyMs === undefined ? {} : { 'messaging.receive_latency_ms': receiveLatencyMs }),
            },
          },
          async (span) => {
            const result = await processSlot(data.slotId);
            span.setAttribute('publish.outcome', result.outcome);
            if (result.outcome === 'dead_letter') {
              span.setStatus({ code: 2, message: 'slot dead-lettered' });
            }
            logger.info(
              { slotId: data.slotId, traceId, outcome: result.outcome, reason: result.reason },
              'bull: slot processed',
            );
          },
        ),
      );
    }
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }
}
