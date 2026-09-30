import { claimDueSlot, reclaimStuckSlots, setSlotStatus } from '../repo.js';
import { processSlot } from '../process-slot.js';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import type { PublishQueue } from './types.js';

/**
 * Default driver: a single-process poller. Durability lives in the DB, not memory —
 *   • claimDueSlot() is an atomic UPDATE guarded by FOR UPDATE SKIP LOCKED, so any
 *     number of these pollers can run at once without double-publishing;
 *   • on start we requeue slots left 'publishing' by a crashed worker (processSlot
 *     + the idempotency key make re-runs safe);
 *   • retry backoff is honoured because claimDueSlot() filters on next_attempt_at.
 * No broker required, so it runs and is fully tested anywhere.
 */
export class InProcessQueue implements PublishQueue {
  private handle: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  async start(): Promise<void> {
    // recover crash-orphaned work first
    const stuck = await reclaimStuckSlots();
    for (const s of stuck) {
      logger.info({ slotId: s.id }, "inprocess: reclaiming stuck slot (was 'publishing')");
      await setSlotStatus(s.id, 'pending');
    }
    this.handle = setInterval(() => void this.tick(), config.scheduler.tickMs);
    this.handle.unref?.();
    logger.info({ tickMs: config.scheduler.tickMs }, 'inprocess queue started');
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let slot = await claimDueSlot();
      while (slot) {
        const res = await processSlot(slot.id);
        logger.info({ slotId: slot.id, adapter: slot.adapter, outcome: res.outcome, reason: res.reason }, 'inprocess: slot processed');
        slot = await claimDueSlot();
      }
    } catch (err) {
      logger.error({ err }, 'inprocess: tick error');
    } finally {
      this.ticking = false;
    }
  }

  async stop(): Promise<void> {
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  }
}
