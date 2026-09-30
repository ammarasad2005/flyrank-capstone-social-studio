// Standalone worker entrypoint. Runs the configured queue driver on its own so you
// can scale workers independently of the web process:
//   QUEUE_DRIVER=inprocess node --import tsx src/worker.ts   (poller, no broker)
//   QUEUE_DRIVER=bull       node --import tsx src/worker.ts   (Redis-backed fleet)
import { initSentry } from './observability/sentry.js';
initSentry();

import { config } from './config.js';
import { createQueue } from './queue/index.js';
import { logger } from './observability/logger.js';

async function main(): Promise<void> {
  logger.info(
    { driver: config.queue.driver, retryMax: config.retry.maxAttempts, retryBaseMs: config.retry.baseMs },
    'worker starting',
  );
  const queue = await createQueue();
  await queue.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker draining and stopping');
    try {
      await queue.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'worker fatal');
  process.exit(1);
});
