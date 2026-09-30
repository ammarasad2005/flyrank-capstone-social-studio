import { claimDueSlot, reclaimStuckSlots, setSlotStatus } from './repo.js';
import { publishSlot } from './publisher.js';
import { config } from './config.js';

/**
 * A durable scheduler. Durability rests on the database, not process memory:
 *   • claimDueSlot() is an atomic UPDATE ... WHERE status='pending' guarded by
 *     FOR UPDATE SKIP LOCKED, so many workers can run without double-publishing.
 *   • on startup we reclaim slots left in 'publishing' by a crashed worker and re-run
 *     them; publishSlot() is idempotent so re-running produces no duplicate.
 */
export function startScheduler(opts: { log?: Console } = {}): () => void {
  const log = opts.log ?? console;

  // Recover crash-orphaned work first (async, fire-and-forget into the first tick).
  const recover = async () => {
    const stuck = await reclaimStuckSlots();
    for (const s of stuck) {
      log.log(`scheduler: reclaiming stuck slot ${s.id} (was 'publishing')`);
      await setSlotStatus(s.id, 'pending');
    }
  };

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      let slot = await claimDueSlot();
      while (slot) {
        try {
          const out = await publishSlot(slot.id);
          log.log(`scheduler: slot ${slot.id} -> ${out.reused ? 'reused(idempotent)' : out.skipped ? 'skipped(' + out.reason + ')' : 'published'} via ${slot.adapter}`);
        } catch (err) {
          log.error(`scheduler: slot ${slot.id} failed: ${(err as Error)?.message ?? err}`);
        }
        slot = await claimDueSlot();
      }
    } finally {
      running = false;
    }
  };

  const handle = setInterval(tick, config.scheduler.tickMs);
  handle.unref?.();
  log.log(`scheduler: started, tick=${config.scheduler.tickMs}ms`);
  recover().then(tick);
  return () => clearInterval(handle);
}
