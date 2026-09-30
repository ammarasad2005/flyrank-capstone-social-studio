import express, { type Request, type Response, type NextFunction } from 'express';
import { config } from './config.js';
import { postsRouter } from './routes/posts.js';
import { variantsRouter } from './routes/variants.js';
import { systemRouter } from './routes/system.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));
  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      const { db } = await import('./db.js');
      await db.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch (err) {
      res.status(503).json({ status: 'not-ready', error: String((err as Error)?.message ?? err) });
    }
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      service: 'social-media-studio',
      tagline: 'one blog post in → a scheduled, idempotent, multi-platform campaign out',
      platforms: config.platforms,
      endpoints: {
        'POST /posts': 'ingest a post {url} or {markdown,title}',
        'POST /posts/:id/generate': 'generate one variant per platform',
        'GET  /variants': 'list variants (?post_id=&status=)',
        'POST /variants': 'manually create a variant (validated → 422 if it breaks a rule)',
        'PATCH /variants/:id': 'edit a variant (re-validated)',
        'POST /variants/:id/approve|reject': 'review workflow',
        'POST /variants/:id/schedule': 'schedule an approved variant {at, adapter}',
        'GET  /slots': 'the schedule calendar',
        'POST /slots/:id/publish': 'publish a slot now (idempotent)',
        'GET  /history': 'publish history (every attempt + result)',
        'GET  /mock-posts': 'what the mock adapters recorded',
      },
    });
  });

  app.use('/posts', postsRouter);
  app.use('/variants', variantsRouter);
  app.use('/', systemRouter);

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[error]', err);
    res.status(500).json({ error: 'internal error', detail: String(err.message) });
  });

  return app;
}
