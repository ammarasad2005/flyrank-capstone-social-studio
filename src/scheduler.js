import { claimDueSlot, reclaimStuckSlots, setSlotStatus } from './repo.js';
import { publishSlot } from './publisher.js';
import { config } from './config.js';

/**
 * A durable, single-worker scheduler.
 *
 * Durability rests on the database, not on process memory:
 *   • Claiming a due slot is an atomic `UPDATE ... WHERE status='pending'` (see
 *     repo.claimDueSlot) — two workers can never grab the same slot.
 *   • On startup we reclaim any slot left in 'publishing' by a crashed worker and
 *     re-run it. publishSlot() is idempotent, so re-running a slot whose network call
 *     already landed produces NO duplicate (PROBE 5 + the durable-restart probe).
 */
export function startScheduler({ log = console } = {}) {
  // Recover crash-orphaned work first.
  const stuck = reclaimStuckSlots();
  for (const s of stuck) {
    log.log?.(`scheduler: reclaiming stuck slot ${s.id} (was 'publishing')`);
    setSlotStatus(s.id, 'pending'); // put back so the normal loop re-claims + re-runs it
  }

  let running = false;
  const tick = async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      let slot;
      // Drain every due slot this tick.
      while ((slot = claimDueSlot(new Date().toISOString()))) {
        try {
          const out = await publishSlot(slot.id);
          log.log?.(`scheduler: slot ${slot.id} -> ${out.reused ? 'reused(idempotent)' : 'published'} via ${slot.adapter}`);
        } catch (err) {
          log.error?.(`scheduler: slot ${slot.id} failed: ${err?.message ?? err}`);
        }
      }
    } finally {
      running = false;
    }
  };

  const handle = setInterval(tick, config.scheduler.tickMs);
  handle.unref?.();
  log.log?.(`scheduler: started, tick=${config.scheduler.tickMs}ms`);
  tick(); // run once immediately
  return () => clearInterval(handle);
}
