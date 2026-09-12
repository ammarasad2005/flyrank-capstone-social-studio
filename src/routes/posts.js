import { Router } from 'express';
import { ingestFromBody } from '../ingest.js';
import { generateCandidate } from '../generator.js';
import { config } from '../config.js';
import { insertPost, getPost, insertVariant, listVariants } from '../repo.js';

export const postsRouter = Router();

// Ingest + store a post (URL or Markdown). The stored post is the source of truth.
postsRouter.post('/', async (req, res, next) => {
  try {
    const record = await ingestFromBody(req.body);
    const post = insertPost(record);
    res.status(201).json(post);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

postsRouter.get('/:id', (req, res) => {
  const post = getPost(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'post not found' });
  res.json(post);
});

// Generate one variant per configured platform. Only VALID variants are stored as
// drafts; a candidate that breaks its profile is returned in `blocked` with the
// named violations and never reaches review.
postsRouter.post('/:id/generate', async (req, res, next) => {
  try {
    const post = getPost(Number(req.params.id));
    if (!post) return res.status(404).json({ error: 'post not found' });

    const platforms = req.body?.platforms?.length ? req.body.platforms : config.platforms;
    const useAI = req.body?.useAI ?? config.useAI;

    const created = [];
    const blocked = [];
    for (const platform of platforms) {
      const cand = await generateCandidate(platform, post, { useAI });
      if (cand.validation.ok) {
        created.push(insertVariant({
          post_id: post.id, platform, content: cand.content, hashtags: cand.hashtags, status: 'draft',
        }));
      } else {
        blocked.push({ platform, violations: cand.validation.violations, content: cand.content });
      }
    }
    res.status(201).json({ post_id: post.id, created, blocked });
  } catch (err) {
    next(err);
  }
});

// Convenience: list a post's variants.
postsRouter.get('/:id/variants', (req, res) => {
  const post = getPost(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'post not found' });
  res.json(listVariants({ post_id: post.id }));
});
