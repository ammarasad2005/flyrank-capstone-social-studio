import { getAdapter } from './adapters/index.js';
import {
  getSlot, getVariant, getPost, setSlotStatus, updateVariant,
  findAttemptByKey, insertPendingAttempt, markAttemptInFlight, finishAttempt,
} from './repo.js';
import type { Attempt, PublishResult } from './types.js';

export interface PublishOutcome {
  reused?: boolean;
  alreadyDone?: boolean;
  skipped?: boolean;
  reason?: string;
  attempt: Attempt;
  result?: PublishResult;
}

/**
 * Publish exactly one slot — the single choke point through which everything is sent.
 * Exactly-once (never a duplicate) holds even if the worker dies between the network
 * send and recording the result. See docs for the full argument.
 */
export async function publishSlot(slotId: number): Promise<PublishOutcome> {
  const slot = await getSlot(slotId);
  if (!slot) throw new Error(`slot ${slotId} not found`);

  const key = `${slot.variant_id}:${slot.id}`;
  const adapter = getAdapter(slot.adapter);

  let attempt = await findAttemptByKey(key);

  // Already done — converge state and return.
  if (attempt?.status === 'succeeded') {
    await setSlotStatus(slot.id, 'published');
    await updateVariant(slot.variant_id, { status: 'published' });
    return { reused: true, alreadyDone: true, attempt };
  }

  // Crash recovery for a send that was already issued to a non-idempotent target.
  // We CANNOT know if it landed, so retrying could double-post. Record the
  // ambiguity and hand back 'uncertain' — the caller dead-letters it (no retry).
  if (attempt?.status === 'in_flight' && !adapter.idempotent) {
    const done = await finishAttempt(attempt.id, {
      status: 'uncertain',
      error: 'crashed during a non-idempotent send; not retried to avoid a duplicate',
    });
    return { skipped: true, reason: 'uncertain', attempt: done };
  }

  const variant = await getVariant(slot.variant_id);
  const post = variant ? await getPost(variant.post_id) : null;
  if (!variant) throw new Error(`variant ${slot.variant_id} not found`);

  if (!attempt) {
    attempt = await insertPendingAttempt({
      variant_id: slot.variant_id, slot_id: slot.id, idempotency_key: key, adapter: slot.adapter,
    });
    if (attempt.status === 'succeeded') {
      await setSlotStatus(slot.id, 'published');
      await updateVariant(slot.variant_id, { status: 'published' });
      return { reused: true, alreadyDone: true, attempt };
    }
  }

  // Mark in-flight BEFORE the network call so a crash is recoverable/detectable.
  await markAttemptInFlight(attempt.id);

  try {
    const result = await adapter.publish({ idempotencyKey: key, variant, post: post ?? undefined });
    const done = await finishAttempt(attempt.id, {
      status: 'succeeded',
      external_id: result.externalId,
      external_url: result.externalUrl,
      preview: result.preview,
    });
    await updateVariant(slot.variant_id, { status: 'published' });
    await setSlotStatus(slot.id, 'published');
    return { reused: !!result.reused, alreadyDone: false, attempt: done, result };
  } catch (err) {
    // Record the failed attempt for history, then RETHROW. Slot state (retry vs
    // dead-letter) is decided by processSlot() so both queue drivers share one model.
    const done = await finishAttempt(attempt.id, { status: 'failed', error: String((err as Error)?.message ?? err) });
    throw Object.assign(err as Error, { attempt: done });
  }
}
