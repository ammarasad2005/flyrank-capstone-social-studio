import { getAdapter } from './adapters/index.js';
import {
  getSlot, getVariant, getPost, setSlotStatus, updateVariant,
  findAttemptByKey, insertPendingAttempt, markAttemptInFlight, finishAttempt,
} from './repo.js';

/**
 * Publish exactly one slot — the single choke point through which everything is sent.
 *
 * Exactly-once (never a duplicate) holds even if the worker dies between the network
 * send and recording the result. The attempt row moves through:
 *
 *   pending → in_flight → succeeded | failed | uncertain
 *                ▲ set right BEFORE the send, so the crash window is detectable
 *
 * Recovery depends on whether the target itself is idempotent:
 *   • Idempotent adapter (Mastodon's Idempotency-Key header, mocks' UNIQUE key):
 *     re-issuing an in_flight send is safe — the target returns the same post.
 *   • Non-idempotent adapter (Telegram sendMessage): re-issuing could duplicate, so we
 *     REFUSE to retry an in_flight send and mark it 'uncertain' (at-most-once).
 *
 * Either way: at most one post per (variant, slot). The app-layer UNIQUE idempotency_key
 * additionally makes a second *successful* attempt impossible at the database level.
 */
export async function publishSlot(slotId) {
  const slot = getSlot(slotId);
  if (!slot) throw new Error(`slot ${slotId} not found`);

  const key = `${slot.variant_id}:${slot.id}`;
  const adapter = getAdapter(slot.adapter);

  let attempt = findAttemptByKey(key);

  // Already done — converge state and return.
  if (attempt?.status === 'succeeded') {
    setSlotStatus(slot.id, 'published');
    updateVariant(slot.variant_id, { status: 'published' });
    return { reused: true, alreadyDone: true, attempt };
  }

  // Crash recovery for a send that was already issued.
  if (attempt?.status === 'in_flight' && !adapter.idempotent) {
    // We cannot know if it landed, and re-sending could duplicate → refuse to retry.
    const done = finishAttempt(attempt.id, {
      status: 'uncertain',
      error: 'crashed during a non-idempotent send; not retried to avoid a duplicate',
    });
    setSlotStatus(slot.id, 'failed');
    return { skipped: true, reason: 'uncertain', attempt: done };
  }

  const variant = getVariant(slot.variant_id);
  const post = getPost(variant.post_id);

  // Reserve the attempt row (UNIQUE key). If a concurrent worker beat us, reuse theirs.
  if (!attempt) {
    try {
      attempt = insertPendingAttempt({
        variant_id: slot.variant_id, slot_id: slot.id, idempotency_key: key, adapter: slot.adapter,
      });
    } catch {
      attempt = findAttemptByKey(key);
      if (attempt?.status === 'succeeded') {
        setSlotStatus(slot.id, 'published');
        updateVariant(slot.variant_id, { status: 'published' });
        return { reused: true, alreadyDone: true, attempt };
      }
    }
  }

  // Mark in-flight BEFORE the network call so a crash is recoverable/detectable.
  markAttemptInFlight(attempt.id);

  try {
    const result = await adapter.publish({ idempotencyKey: key, variant, post });
    const done = finishAttempt(attempt.id, {
      status: 'succeeded',
      external_id: result.externalId,
      external_url: result.externalUrl,
      preview: result.preview,
    });
    updateVariant(slot.variant_id, { status: 'published' });
    setSlotStatus(slot.id, 'published');
    return { reused: !!result.reused, alreadyDone: false, attempt: done, result };
  } catch (err) {
    finishAttempt(attempt.id, { status: 'failed', error: String(err?.message ?? err) });
    setSlotStatus(slot.id, 'failed');
    throw err;
  }
}
