import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { postsRouter } from './routes/posts.js';
import { variantsRouter } from './routes/variants.js';
import { systemRouter } from './routes/system.js';
import { logger } from './observability/logger.js';
import { register, httpDuration, normalizeRoute } from './observability/metrics.js';
import { captureError } from './observability/sentry.js';
import { captureTraceCarrier, traceIdFromCarrier } from './observability/tracing.js';
import { checkDb, checkQueue } from './observability/health.js';

function metricsRequestAuthorized(req: Request): boolean {
  const expected = config.metrics.authToken;
  if (!expected) return true; // backward-compatible, but protect this route before hosted scraping.

  const providedText = req.get('authorization')?.match(/^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i)?.[1];
  if (!providedText) return false;
  const provided = Buffer.from(providedText, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return provided.length === expectedBytes.length && timingSafeEqual(provided, expectedBytes);
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Structured request logging with a request id (C1). Health/readiness/metrics are
  // noisy and uninteresting, so they're excluded from auto request logs.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string) || randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      customProps: () => {
        const traceId = traceIdFromCarrier(captureTraceCarrier());
        return traceId ? { traceId } : {};
      },
      autoLogging: {
        ignore: (req) => ['/health', '/ready', '/metrics'].includes((req.url || '').split('?')[0]),
      },
    }),
  );

  // HTTP latency/throughput metric (C3), labelled by a low-cardinality route.
  // Capture the route at entry: by the time 'finish' fires we're inside a mounted
  // router and req.path has had the mount prefix stripped.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const route = normalizeRoute(req.path);
    const stop = httpDuration.startTimer({ method: req.method });
    res.on('finish', () => stop({ route, status: String(res.statusCode) }));
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  // Liveness: process is up.
  app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

  // Readiness: the dependencies we actually need are reachable (DB, and Redis when
  // QUEUE_DRIVER=bull). Returns 503 if any check fails so the platform can gate traffic.
  app.get('/ready', async (_req: Request, res: Response) => {
    const checks: Record<string, string> = { db: 'ok', queue: 'ok' };
    await checkDb().catch((e) => (checks.db = String((e as Error)?.message ?? e)));
    await checkQueue().catch((e) => (checks.queue = String((e as Error)?.message ?? e)));
    const ok = checks.db === 'ok' && checks.queue === 'ok';
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not-ready', driver: config.queue.driver, checks });
  });

  // Prometheus scrape endpoint (C3).
  app.get('/metrics', async (req: Request, res: Response) => {
    if (!config.metrics.enabled) return res.status(404).json({ error: 'metrics disabled' });
    if (!metricsRequestAuthorized(req)) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      service: 'social-media-studio',
      tagline: 'one blog post in → a scheduled, idempotent, multi-platform campaign out',
      platforms: config.platforms,
      queue: config.queue.driver,
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
        'GET  /health': 'liveness',
        'GET  /ready': 'readiness (DB + queue)',
        'GET  /metrics': 'Prometheus metrics',
      },
    });
  });

  app.use('/posts', postsRouter);
  app.use('/variants', variantsRouter);
  app.use('/', systemRouter);

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    (req.log ?? logger).error({ err }, 'unhandled request error');
    captureError(err, { path: req.path, method: req.method, reqId: (req as any).id });
    res.status(500).json({ error: 'internal error', detail: String(err.message) });
  });

  return app;
}
