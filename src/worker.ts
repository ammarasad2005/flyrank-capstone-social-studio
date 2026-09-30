// Standalone worker entrypoint. Runs the configured queue driver on its own so you
// can scale workers independently of the web process:
//   QUEUE_DRIVER=inprocess node --import tsx src/worker.ts   (poller, no broker)
//   QUEUE_DRIVER=bull       node --import tsx src/worker.ts   (Redis-backed fleet)
import { config } from './config.js';
import { createQueue } from './queue/index.js';

async function main(): Promise<void> {
  console.log(`worker: starting (driver=${config.queue.driver}, retry max=${config.retry.maxAttempts} base=${config.retry.baseMs}ms)`);
  const queue = await createQueue();
  await queue.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\nworker: ${signal} received — draining and stopping`);
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
  console.error('worker: fatal', err);
  process.exit(1);
});
