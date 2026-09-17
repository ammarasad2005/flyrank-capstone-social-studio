import { getAdapter } from './adapters/index.js';
import {
  getSlot, getVariant, getPost, setSlotStatus, updateVariant,
  findAttemptByKey, insertPendingAttempt, finishAttempt,
} from './repo.js';

/**
 * Publish exactly one slot — the single choke point through which everything is sent.
 *
 * Exactly-once is enforced at two layers, so it holds even if the worker dies between
 * the network call and recording the result:
 *
 *   1. App layer — publish_attempts.idempotency_key (`${variantId}:${slotId}`) is
 *      UNIQUE. A succeeded attempt short-circuits; we never even call the adapter twice.
 *   2. Adapter layer — every adapter is idempotent on that same key (Mastodon's native
 *      Idempotency-Key header; mocks' UNIQUE mock_posts.idempotency_key). So a retry
 *      that DID reach the network the first time still yields one post.
 */
export async function publishSlot(slotId) {
  const slot = getSlot(slotId);
  if (!slot) throw new Error(`slot ${slotId} not found`);

  const key = `${slot.variant_id}:${slot.id}`;

  // Layer 1: already done? no-op, converge state, return.
  let attempt = findAttemptByKey(key);
  if (attempt?.status === 'succeeded') {
    setSlotStatus(slot.id, 'published');
    updateVariant(slot.variant_id, { status: 'published' });
    return { reused: true, alreadyDone: true, attempt };
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

  const adapter = getAdapter(slot.adapter);
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
