import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { claimDueSlot, reclaimStuckSlots, setSlotStatus } from '../repo.js';
import { processSlot } from '../process-slot.js';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import type { PublishQueue } from './types.js';
import { BULL_QUEUE_NAME } from './constants.js';

/**
 * Bull driver (Upstash/Redis). Redis becomes the coordination layer for a fleet of
 * workers, but the publish SEMANTICS are unchanged: a repeatable "scan" job claims
 * due slots via the same SKIP-LOCKED query and enqueues one "slot" job each; the
 * worker runs every slot through the shared processSlot(). Retry/backoff/dead-letter
 * stay in the DB (see repo.recordSlotFailure) rather than using Bull-native retries,
 * so both drivers behave identically and the model is testable without a broker.
 *
 * CI runs a disposable real-Postgres/Redis worker-restart check. The domain retry tests
 * remain broker-free; production enables this driver via QUEUE_DRIVER=bull + REDIS_URL.
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
    this.worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'bull: job failed'));

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
        // enqueue one job per claimed slot; the slot is already 'publishing'
        await this.queue.add('slot', { slotId: slot.id }, { removeOnComplete: true, removeOnFail: true });
        slot = await claimDueSlot();
      }
      return;
    }
    if (job.name === 'slot') {
      const res = await processSlot(job.data.slotId);
      logger.info({ slotId: job.data.slotId, outcome: res.outcome, reason: res.reason }, 'bull: slot processed');
    }
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }
}
