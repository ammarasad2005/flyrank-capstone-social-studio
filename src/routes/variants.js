import { Router } from 'express';
import { validateVariant } from '../profiles.js';
import { getPost, getVariant, listVariants, insertVariant } from '../repo.js';

export const variantsRouter = Router();

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
