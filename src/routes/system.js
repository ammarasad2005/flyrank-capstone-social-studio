import { Router } from 'express';
import { listSlots, listAttempts, listMockPosts, getSlot } from '../repo.js';
import { publishSlot } from '../publisher.js';

export const systemRouter = Router();

// The schedule calendar.
systemRouter.get('/slots', (_req, res) => res.json(listSlots()));

// The publish history — every attempt and its result (one slot = one success).
systemRouter.get('/history', (_req, res) => res.json(listAttempts()));

// What the mock adapters "posted" (their preview store).
systemRouter.get('/mock-posts', (_req, res) => res.json(listMockPosts()));

// Publish a slot right now. Idempotent: calling it repeatedly yields exactly one
// post (PROBE 5). The scheduler uses the same publishSlot() path.
systemRouter.post('/slots/:id/publish', async (req, res) => {
  const slot = getSlot(Number(req.params.id));
  if (!slot) return res.status(404).json({ error: 'slot not found' });
  try {
    const out = await publishSlot(slot.id);
    res.json({
      slot_id: slot.id,
      reused: out.reused,
      already_done: out.alreadyDone,
      attempt: out.attempt,
    });
  } catch (err) {
    res.status(502).json({ error: String(err?.message ?? err) });
  }
});
