import { Router } from 'express';
import { listSlots, listAttempts } from '../repo.js';

export const systemRouter = Router();

// The schedule calendar.
systemRouter.get('/slots', (_req, res) => res.json(listSlots()));

// The publish history — every attempt and its result (one slot = one success).
systemRouter.get('/history', (_req, res) => res.json(listAttempts()));
