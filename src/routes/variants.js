import { Router } from 'express';
import { validateVariant } from '../profiles.js';
import { knownPlatforms } from '../generator.js';
import {
  getPost, getVariant, listVariants, insertVariant, updateVariant, insertSlot,
} from '../repo.js';

export const variantsRouter = Router();
const ADAPTERS = new Set(knownPlatforms()); // adapter id == platform id

variantsRouter.get('/', (req, res) => {
  const { post_id, status } = req.query;
  res.json(listVariants({ post_id: post_id ? Number(post_id) : undefined, status }));
});

variantsRouter.get('/:id', (req, res) => {
  const v = getVariant(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'variant not found' });
  res.json(v);
});

// Manually create a variant. It is VALIDATED against the platform profile; a
// rule-breaking variant is rejected with 422 and messages that NAME the broken
// rule — it never reaches review. (PROBE 2.)
variantsRouter.post('/', (req, res) => {
  const { post_id, platform, content, hashtags } = req.body ?? {};
  if (!post_id || !platform || typeof content !== 'string') {
    return res.status(400).json({ error: 'post_id, platform and content are required' });
  }
  if (!getPost(Number(post_id))) {
    return res.status(404).json({ error: 'post not found' });
  }
  let validation;
  try {
    validation = validateVariant(platform, content);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!validation.ok) {
    return res.status(422).json({
      error: 'variant violates its platform constraint profile',
      violations: validation.violations,
      stats: validation.stats,
    });
  }
  const v = insertVariant({ post_id: Number(post_id), platform, content, hashtags, status: 'draft' });
  res.status(201).json(v);
});

// ── Review workflow ─────────────────────────────────────────────────────────────

// Approve a variant (draft/rejected → approved). Only approved variants schedule.
variantsRouter.post('/:id/approve', (req, res) => {
  const v = getVariant(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'variant not found' });
  if (v.status === 'published') {
    return res.status(409).json({ error: 'cannot approve an already-published variant' });
  }
  res.json(updateVariant(v.id, { status: 'approved', rejection_reason: null }));
});

// Reject a variant with a reason.
variantsRouter.post('/:id/reject', (req, res) => {
  const v = getVariant(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'variant not found' });
  if (v.status === 'published') {
    return res.status(409).json({ error: 'cannot reject an already-published variant' });
  }
  const reason = req.body?.reason ?? 'rejected by reviewer';
  res.json(updateVariant(v.id, { status: 'rejected', rejection_reason: reason }));
});

// Edit a variant's content. It is re-validated (422 if it now breaks a rule) and
// returns to `draft` so the change is reviewed before it can be scheduled.
variantsRouter.patch('/:id', (req, res) => {
  const v = getVariant(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'variant not found' });
  if (v.status === 'published') {
    return res.status(409).json({ error: 'cannot edit an already-published variant' });
  }
  const content = typeof req.body?.content === 'string' ? req.body.content : v.content;
  const validation = validateVariant(v.platform, content);
  if (!validation.ok) {
    return res.status(422).json({
      error: 'edited variant violates its platform constraint profile',
      violations: validation.violations,
    });
  }
  const hashtags = req.body?.hashtags ?? v.hashtags;
  res.json(updateVariant(v.id, { content, hashtags, status: 'draft', rejection_reason: null }));
});

// Schedule an APPROVED variant into a slot. An unapproved variant is refused with
// a 4xx status code and an error message. (PROBE 3.)
variantsRouter.post('/:id/schedule', (req, res) => {
  const v = getVariant(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'variant not found' });

  if (v.status !== 'approved') {
    return res.status(409).json({
      error: `only approved variants can be scheduled — this variant is "${v.status}"`,
    });
  }

  // adapter defaults to the variant's platform, but can be ANY adapter (the seam:
  // publish the same campaign through a mock without touching business logic).
  const adapter = req.body?.adapter ?? v.platform;
  if (!ADAPTERS.has(adapter)) {
    return res.status(422).json({ error: `unknown adapter "${adapter}"`, known: [...ADAPTERS] });
  }

  // when to publish; default = now (publish on the next scheduler tick)
  const at = req.body?.at ? new Date(req.body.at) : new Date();
  if (Number.isNaN(at.getTime())) {
    return res.status(422).json({ error: `invalid "at" datetime: ${req.body.at}` });
  }

  const slot = insertSlot({
    variant_id: v.id,
    adapter,
    scheduled_at: at.toISOString(),
  });
  res.status(201).json(slot);
});
