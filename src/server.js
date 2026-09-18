import { createApp } from './app.js';
import { config } from './config.js';
import { startScheduler } from './scheduler.js';

const app = createApp();

app.listen(config.port, '0.0.0.0', () => {
  console.log(`social-media-studio listening on http://0.0.0.0:${config.port}`);
  console.log(`platforms: ${config.platforms.join(', ')} | AI: ${config.useAI}`);
  if (config.scheduler.enabled) {
    startScheduler();
  } else {
    console.log('scheduler: disabled (SCHEDULER_ENABLED=false)');
  }
});
