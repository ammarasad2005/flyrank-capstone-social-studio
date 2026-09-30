import { initSentry } from './observability/sentry.js';
initSentry(); // before anything else, so early errors are captured

import { createApp } from './app.js';
import { config } from './config.js';
import { createQueue } from './queue/index.js';
import { logger } from './observability/logger.js';
import type { PublishQueue } from './queue/types.js';

const app = createApp();

// The web process runs the configured queue driver INLINE, so a single-service
// deploy (e.g. Render free tier) both serves HTTP and publishes — with either
// driver. To scale the queue horizontally instead, set SCHEDULER_ENABLED=false
// here and run `npm run worker` as its own process.
let queue: PublishQueue | null = null;

const server = app.listen(config.port, '0.0.0.0', async () => {
  logger.info(
    { port: config.port, platforms: config.platforms, ai: config.useAI, queue: config.queue.driver },
    'social-media-studio listening',
  );
  if (!config.scheduler.enabled) {
    logger.info('queue disabled (SCHEDULER_ENABLED=false) — run publishing via `npm run worker`');
    return;
  }
  try {
    queue = await createQueue();
    await queue.start();
  } catch (err) {
    logger.error({ err, driver: config.queue.driver }, 'queue failed to start');
  }
});

// Graceful shutdown: stop accepting connections, let in-flight work settle.
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down gracefully');
  void queue?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
