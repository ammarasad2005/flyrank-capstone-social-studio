import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { claimDueSlot, reclaimStuckSlots, setSlotStatus } from '../repo.js';
import { processSlot } from '../process-slot.js';
import { config } from '../config.js';
import type { PublishQueue } from './types.js';

const QUEUE_NAME = 'flyrank-publish';

/**
 * Bull driver (Upstash/Redis). Redis becomes the coordination layer for a fleet of
 * workers, but the publish SEMANTICS are unchanged: a repeatable "scan" job claims
 * due slots via the same SKIP-LOCKED query and enqueues one "slot" job each; the
 * worker runs every slot through the shared processSlot(). Retry/backoff/dead-letter
 * stay in the DB (see repo.recordSlotFailure) rather than using Bull-native retries,
 * so both drivers behave identically and the model is testable without a broker.
 *
 * Not exercised in CI (no Redis in the sandbox); validated by typecheck. Prod stays
 * on QUEUE_DRIVER=inprocess until a rediss:// endpoint is wired in.
 */
export class BullQueue implements PublishQueue {
  private connection: IORedis;
  private queue: Queue;
  private worker: Worker | null = null;
  private log: Console;

  constructor(opts: { log?: Console } = {}) {
    this.log = opts.log ?? console;
    // BullMQ requires maxRetriesPerRequest: null on the shared connection.
    this.connection = new IORedis(config.queue.redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
  }

  async start(): Promise<void> {
    // requeue crash-orphaned work, same as the in-process driver
    const stuck = await reclaimStuckSlots();
    for (const s of stuck) {
      this.log.log(`bull: reclaiming stuck slot ${s.id} (was 'publishing')`);
      await setSlotStatus(s.id, 'pending');
    }

    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), {
      connection: this.connection,
      concurrency: 4,
    });
    this.worker.on('failed', (job, err) => this.log.error(`bull: job ${job?.id} failed: ${err?.message}`));

    // one repeatable "scan" tick; the scheduler id keeps it a singleton across restarts
    await this.queue.upsertJobScheduler(
      'scan',
      { every: config.scheduler.tickMs },
      { name: 'scan', data: {}, opts: { removeOnComplete: true, removeOnFail: true } },
    );
    this.log.log(`bull queue: started, scan every ${config.scheduler.tickMs}ms`);
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
      const res = await processSlot(job.data.slotId, this.log);
      this.log.log(`bull: slot ${job.data.slotId} -> ${res.outcome}${res.reason ? ' (' + res.reason + ')' : ''}`);
    }
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }
}
