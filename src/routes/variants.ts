import { Router, type Request, type Response } from 'express';
import { validateVariant } from '../profiles.js';
import { knownAdapters } from '../adapters/index.js';
import {
  getPost, getVariant, listVariants, insertVariant, updateVariant, insertSlot,
} from '../repo.js';
import type { VariantStatus } from '../types.js';

export const variantsRouter = Router();
const ADAPTERS = new Set(knownAdapters());

// list / read ------------------------------------------------------------------
variantsRouter.get('/', async (req: Request, res: Response) => {
  const post_id = req.query.post_id ? Number(req.query.post_id) : undefined;
  const status = req.query.status as VariantStatus | undefined;
  res.json(await listVariants({ post_id, status }));
});

variantsRouter.get('/:id', async (req: Request, res: Response) => {
  const v = await getVariant(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'variant not found' });
  res.json(v);
});

// manual create (validated) ----------------------------------------------------
variantsRouter.post('/', async (req: Request, res: Response) => {
  const { post_id, platform, content } = req.body ?? {};
  if (!post_id || !platform || typeof content !== 'string') {
    return res.status(400).json({ error: 'require { post_id, platform, content }' });
  }
  const post = await getPost(Number(post_id));
  if (!post) return res.status(404).json({ error: 'post not found' });

  const validation = validateVariant(platform, content);
  if (!validation.ok) {
    return res.status(422).json({
      error: 'variant violates its platform constraint profile',
      violations: validation.violations,
      stats: validation.stats,
    });
  }
  const v = await insertVariant({ post_id: Number(post_id), platform, content, hashtags: req.body?.hashtags ?? [] });
  res.status(201).json(v);
});

// review workflow --------------------------------------------------------------
variantsRouter.post('/:id/approve', async (req: Request, res: Response) => {
  const v = await getVariant(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'variant not found' });
  if (v.status === 'published') return res.status(409).json({ error: 'cannot approve an already-published variant' });
  res.json(await updateVariant(v.id, { status: 'approved', rejection_reason: null }));
});

variantsRouter.post('/:id/reject', async (req: Request, res: Response) => {
  const v = await getVariant(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'variant not found' });
  if (v.status === 'published') return res.status(409).json({ error: 'cannot reject an already-published variant' });
  res.json(await updateVariant(v.id, { status: 'rejected', rejection_reason: req.body?.reason ?? 'rejected by reviewer' }));
});

// Edit re-validates and returns the variant to draft so the change is reviewed.
variantsRouter.patch('/:id', async (req: Request, res: Response) => {
  const v = await getVariant(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'variant not found' });
  if (v.status === 'published') return res.status(409).json({ error: 'cannot edit an already-published variant' });
  const content = typeof req.body?.content === 'string' ? req.body.content : v.content;
  const validation = validateVariant(v.platform, content);
  if (!validation.ok) {
    return res.status(422).json({ error: 'edited variant violates its platform constraint profile', violations: validation.violations });
  }
  res.json(await updateVariant(v.id, { content, hashtags: req.body?.hashtags ?? v.hashtags, status: 'draft', rejection_reason: null }));
});

// Schedule an APPROVED variant. Unapproved => 4xx (PROBE 3).
variantsRouter.post('/:id/schedule', async (req: Request, res: Response) => {
  const v = await getVariant(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'variant not found' });
  if (v.status !== 'approved') {
    return res.status(409).json({ error: `only approved variants can be scheduled — this variant is "${v.status}"` });
  }
  const adapter = req.body?.adapter ?? v.platform;
  if (!ADAPTERS.has(adapter)) {
    return res.status(422).json({ error: `unknown adapter "${adapter}"`, known: [...ADAPTERS] });
  }
  const at = req.body?.at ? new Date(req.body.at) : new Date();
  if (Number.isNaN(at.getTime())) {
    return res.status(422).json({ error: `invalid "at" datetime: ${req.body.at}` });
  }
  const slot = await insertSlot({ variant_id: v.id, adapter, scheduled_at: at.toISOString() });
  res.status(201).json(slot);
});
