import { publishSlot, type PublishOutcome } from './publisher.js';
import { recordSlotFailure, deadLetterSlot } from './repo.js';
import { notifyDeadLetter } from './notify.js';
import { config } from './config.js';

export interface ProcessResult {
  slotId: number;
  outcome: 'published' | 'reused' | 'retry_scheduled' | 'dead_letter';
  reason?: string;
  publish?: PublishOutcome;
}

/**
 * The one place a slot goes from claimed -> terminal|retry. Wraps publishSlot()
 * and owns the retry/backoff/dead-letter decision so the in-process and Bull
 * drivers behave identically. publishSlot() only records history + throws on
 * failure; this function translates that into slot state.
 */
export async function processSlot(slotId: number, log: Console = console): Promise<ProcessResult> {
  try {
    const out = await publishSlot(slotId);

    // At-most-once adapter whose send outcome is unknown after a crash — never
    // retry (could double-post). Dead-letter it straight away.
    if (out.skipped && out.reason === 'uncertain') {
      const slot = await deadLetterSlot(slotId, 'non-idempotent send outcome unknown; not retried');
      await notifyDeadLetter(slot, 'uncertain non-idempotent send', log);
      return { slotId, outcome: 'dead_letter', reason: 'uncertain', publish: out };
    }

    return { slotId, outcome: out.reused ? 'reused' : 'published', publish: out };
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    const { deadLettered, slot } = await recordSlotFailure(slotId, {
      maxAttempts: config.retry.maxAttempts,
      baseMs: config.retry.baseMs,
      error: message,
    });
    if (deadLettered) {
      await notifyDeadLetter(slot, message, log);
      return { slotId, outcome: 'dead_letter', reason: message };
    }
    log.warn(`slot ${slotId} failed (attempt ${slot.attempts}/${config.retry.maxAttempts}), retry at ${slot.next_attempt_at}: ${message}`);
    return { slotId, outcome: 'retry_scheduled', reason: message };
  }
}
