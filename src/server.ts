import { createApp } from './app.js';
import { config } from './config.js';
import { startScheduler } from './scheduler.js';

const app = createApp();

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`social-media-studio listening on http://0.0.0.0:${config.port}`);
  console.log(`platforms: ${config.platforms.join(', ')} | AI: ${config.useAI}`);
  if (config.scheduler.enabled) startScheduler();
  else console.log('scheduler: disabled (SCHEDULER_ENABLED=false)');
});

// Graceful shutdown: stop accepting connections, let in-flight work settle.
function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down gracefully`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
