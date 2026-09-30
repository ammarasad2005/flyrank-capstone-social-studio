import { db } from '../db.js';
import { config } from '../config.js';

// Readiness checks used by GET /ready. Liveness (/health) stays trivial; readiness
// proves the dependencies the app actually needs are reachable.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref()),
  ]);
}

export async function checkDb(): Promise<void> {
  await withTimeout(db.query('SELECT 1'), 3000, 'db check');
}

// Only meaningful for the bull driver; the in-process poller has no broker to reach.
let redis: any;
export async function checkQueue(): Promise<void> {
  if (config.queue.driver !== 'bull') return;
  const IORedis = (await import('ioredis')).default;
  if (!redis) redis = new IORedis(config.queue.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
  const pong = await withTimeout(redis.ping(), 2500, 'redis ping');
  if (pong !== 'PONG') throw new Error(`unexpected redis ping reply: ${pong}`);
}
