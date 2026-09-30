import { createApp } from './app.js';
import { config } from './config.js';
import { createQueue } from './queue/index.js';
import type { PublishQueue } from './queue/types.js';

const app = createApp();

// The web process runs the configured queue driver INLINE, so a single-service
// deploy (e.g. Render free tier) both serves HTTP and publishes — with either
// driver. To scale the queue horizontally instead, set SCHEDULER_ENABLED=false
// here and run `npm run worker` as its own process.
let queue: PublishQueue | null = null;

const server = app.listen(config.port, '0.0.0.0', async () => {
  console.log(`social-media-studio listening on http://0.0.0.0:${config.port}`);
  console.log(`platforms: ${config.platforms.join(', ')} | AI: ${config.useAI} | queue: ${config.queue.driver}`);
  if (!config.scheduler.enabled) {
    console.log('queue: disabled (SCHEDULER_ENABLED=false) — run publishing via `npm run worker`');
    return;
  }
  try {
    queue = await createQueue();
    await queue.start();
  } catch (err) {
    console.error(`queue: failed to start (${config.queue.driver}):`, (err as Error)?.message ?? err);
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

