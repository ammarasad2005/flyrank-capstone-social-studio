import { config } from '../config.js';
import type { PublishQueue } from './types.js';
import { InProcessQueue } from './inprocess.js';

/**
 * Pick the queue driver from config. bull.ts (and thus bullmq/ioredis) is imported
 * lazily so nothing tries to reach Redis unless QUEUE_DRIVER=bull — tests and the
 * default deploy never load it.
 */
export async function createQueue(opts: { log?: Console } = {}): Promise<PublishQueue> {
  if (config.queue.driver === 'bull') {
    const { BullQueue } = await import('./bull.js');
    return new BullQueue(opts);
  }
  return new InProcessQueue(opts);
}

export type { PublishQueue } from './types.js';
