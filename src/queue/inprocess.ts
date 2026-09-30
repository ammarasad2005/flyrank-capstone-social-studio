import { claimDueSlot, reclaimStuckSlots, setSlotStatus } from '../repo.js';
import { processSlot } from '../process-slot.js';
import { config } from '../config.js';
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
  private log: Console;

  constructor(opts: { log?: Console } = {}) {
    this.log = opts.log ?? console;
  }

  async start(): Promise<void> {
    // recover crash-orphaned work first
    const stuck = await reclaimStuckSlots();
    for (const s of stuck) {
      this.log.log(`inprocess: reclaiming stuck slot ${s.id} (was 'publishing')`);
      await setSlotStatus(s.id, 'pending');
    }
    this.handle = setInterval(() => void this.tick(), config.scheduler.tickMs);
    this.handle.unref?.();
    this.log.log(`inprocess queue: started, tick=${config.scheduler.tickMs}ms`);
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let slot = await claimDueSlot();
      while (slot) {
        const res = await processSlot(slot.id, this.log);
        this.log.log(`inprocess: slot ${slot.id} -> ${res.outcome}${res.reason ? ' (' + res.reason + ')' : ''} via ${slot.adapter}`);
        slot = await claimDueSlot();
      }
    } catch (err) {
      this.log.error(`inprocess: tick error: ${(err as Error)?.message ?? err}`);
    } finally {
      this.ticking = false;
    }
  }

  async stop(): Promise<void> {
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  }
}
