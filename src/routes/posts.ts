import { Router, type Request, type Response, type NextFunction } from 'express';
import { ingestFromBody } from '../ingest.js';
import { generateCandidate } from '../generator.js';
import { config } from '../config.js';
import { insertPost, getPost, insertVariant, listVariants } from '../repo.js';
import type { Variant } from '../types.js';

export const postsRouter = Router();

postsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const record = await ingestFromBody(req.body);
    const post = await insertPost(record);
    res.status(201).json(post);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

postsRouter.get('/:id', async (req: Request, res: Response) => {
  const post = await getPost(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'post not found' });
  res.json(post);
});

// Generate one variant per configured platform. Only VALID variants are stored as
// drafts; a candidate that breaks its profile is returned in `blocked` and never
// reaches review.
postsRouter.post('/:id/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const post = await getPost(Number(req.params.id));
    if (!post) return res.status(404).json({ error: 'post not found' });

    const platforms: string[] = req.body?.platforms?.length ? req.body.platforms : config.platforms;
    const useAI: boolean = req.body?.useAI ?? config.useAI;

    const created: Variant[] = [];
    const blocked: Array<{ platform: string; violations: string[]; content: string }> = [];
    for (const platform of platforms) {
      const cand = await generateCandidate(platform, post, { useAI });
      if (cand.validation.ok) {
        created.push(await insertVariant({
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

postsRouter.get('/:id/variants', async (req: Request, res: Response) => {
  const post = await getPost(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'post not found' });
  res.json(await listVariants({ post_id: post.id }));
});
