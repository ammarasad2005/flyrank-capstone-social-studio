import { createApp } from './app.js';
import { config } from './config.js';
import { InProcessQueue } from './queue/inprocess.js';
import type { PublishQueue } from './queue/types.js';

const app = createApp();

// The web process only runs the in-process queue inline (convenient single-process
// deploy). With QUEUE_DRIVER=bull, run the queue in a separate `src/worker.ts`
// process instead — the server just serves HTTP.
let queue: PublishQueue | null = null;

const server = app.listen(config.port, '0.0.0.0', async () => {
  console.log(`social-media-studio listening on http://0.0.0.0:${config.port}`);
  console.log(`platforms: ${config.platforms.join(', ')} | AI: ${config.useAI} | queue: ${config.queue.driver}`);
  if (!config.scheduler.enabled) {
    console.log('queue: disabled (SCHEDULER_ENABLED=false)');
  } else if (config.queue.driver === 'inprocess') {
    queue = new InProcessQueue();
    await queue.start();
  } else {
    console.log(`queue: driver=${config.queue.driver} — run publishing in a separate worker (src/worker.ts)`);
  }
});

// Graceful shutdown: stop accepting connections, let in-flight work settle.
function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down gracefully`);
  void queue?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
