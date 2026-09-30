import { Router, type Request, type Response } from 'express';
import { listSlots, listAttempts, listMockPosts, getSlot } from '../repo.js';
import { publishSlot } from '../publisher.js';

export const systemRouter = Router();

systemRouter.get('/slots', async (_req: Request, res: Response) => res.json(await listSlots()));
systemRouter.get('/history', async (_req: Request, res: Response) => res.json(await listAttempts()));
systemRouter.get('/mock-posts', async (_req: Request, res: Response) => res.json(await listMockPosts()));

// Publish a slot now. Idempotent: repeated calls yield exactly one post (PROBE 5).
systemRouter.post('/slots/:id/publish', async (req: Request, res: Response) => {
  const slot = await getSlot(Number(req.params.id));
  if (!slot) return res.status(404).json({ error: 'slot not found' });
  try {
    const out = await publishSlot(slot.id);
    res.json({ slot_id: slot.id, reused: out.reused, already_done: out.alreadyDone, skipped: out.skipped, attempt: out.attempt });
  } catch (err) {
    res.status(502).json({ error: String((err as Error)?.message ?? err) });
  }
});
