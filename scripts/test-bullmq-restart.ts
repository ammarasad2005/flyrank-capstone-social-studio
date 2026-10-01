import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { BULL_QUEUE_NAME } from '../src/queue/constants.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) {
  throw new Error('DATABASE_URL and REDIS_URL are required for the BullMQ restart check.');
}
if (process.env.FLYRANK_TEST_ALLOW_QUEUE_RESET !== '1') {
  throw new Error('Set FLYRANK_TEST_ALLOW_QUEUE_RESET=1 only for a disposable CI/test Redis before running this check.');
}

function assertLoopbackEndpoint(rawUrl: string, name: string): void {
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`${name} must point to a disposable loopback service; refusing to touch a remote endpoint.`);
  }
}

// The script obliterates one BullMQ test queue and deletes its fixture rows.
// Refuse non-local endpoints so it cannot be aimed at Render/Neon/Upstash by mistake.
assertLoopbackEndpoint(databaseUrl, 'DATABASE_URL');
assertLoopbackEndpoint(redisUrl, 'REDIS_URL');

const { db, migrate } = await import('../src/db.js');
const repo = await import('../src/repo.js');

type WorkerExit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
type WorkerHandle = {
  child: ChildProcess;
  exited: Promise<WorkerExit>;
  exit: WorkerExit | null;
  logTail: string[];
};

function startWorker(crashAfterMockPublish: boolean): WorkerHandle {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PGSSL: 'disable',
    REDIS_URL: redisUrl,
    QUEUE_DRIVER: 'bull',
    NODE_ENV: 'test',
    SCHEDULER_ENABLED: 'false',
    SCHEDULER_TICK_MS: '50',
    RETRY_MAX_ATTEMPTS: '3',
    RETRY_BASE_MS: '10',
    PLATFORMS: 'mock_x',
    ADAPTER_OVERRIDE: '',
    ALERT_WEBHOOK_URL: '',
    SENTRY_DSN: '',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    MASTODON_BASE_URL: '',
    MASTODON_ACCESS_TOKEN: '',
  };
  if (crashAfterMockPublish) env.FLYRANK_TEST_CRASH_AFTER_MOCK_PUBLISH = '1';
  else delete env.FLYRANK_TEST_CRASH_AFTER_MOCK_PUBLISH;

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logTail: string[] = [];
  const append = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      logTail.push(line);
      if (logTail.length > 30) logTail.shift();
    }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  const handle: WorkerHandle = { child, exited: Promise.resolve({ code: null, signal: null }), exit: null, logTail };
  handle.exited = new Promise<WorkerExit>((resolve) => {
    child.once('exit', (code, signal) => {
      handle.exit = { code, signal };
      resolve(handle.exit);
    });
    child.once('error', (error) => {
      handle.exit = { code: null, signal: null, error };
      resolve(handle.exit);
    });
  });
  return handle;
}

async function clearTestQueue(): Promise<void> {
  const connection = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
  const queue = new Queue(BULL_QUEUE_NAME, { connection });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
    await connection.quit();
  }
}

async function waitUntil(
  description: string,
  predicate: () => Promise<boolean>,
  worker?: WorkerHandle,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (worker?.exit) {
      throw new Error(`${description}: worker exited early (${JSON.stringify(worker.exit)}).\n${worker.logTail.join('\n')}`);
    }
    await delay(50);
  }
  throw new Error(`${description}: timed out.\n${worker?.logTail.join('\n') ?? ''}`);
}

async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopWorker(worker: WorkerHandle | null): Promise<void> {
  if (!worker || worker.exit) return;
  worker.child.kill('SIGTERM');
  const graceful = await raceTimeout(worker.exited, 5_000);
  if (!graceful && !worker.exit) {
    worker.child.kill('SIGKILL');
    await raceTimeout(worker.exited, 2_000);
  }
}

let postId: number | undefined;
let slotId: number | undefined;
let idempotencyKey: string | undefined;
let crashWorker: WorkerHandle | null = null;
let recoveryWorker: WorkerHandle | null = null;

try {
  // The DB module migrates on import; this second call verifies the production runner is repeatable.
  await migrate(db);
  await clearTestQueue();

  const post = await repo.insertPost({
    source_type: 'markdown',
    title: 'BullMQ restart check',
    content_md: 'Disposable CI-only fixture; no network adapter is used.',
  });
  postId = post.id;
  const variant = await repo.insertVariant({
    post_id: post.id,
    platform: 'mock_x',
    content: 'One idempotent mock send across a hard worker crash.',
    status: 'approved',
  });
  const slot = await repo.insertSlot({
    variant_id: variant.id,
    adapter: 'mock_x',
    scheduled_at: new Date(Date.now() - 1_000).toISOString(),
  });
  slotId = slot.id;
  idempotencyKey = `${variant.id}:${slot.id}`;

  crashWorker = startWorker(true);
  await waitUntil(
    'first worker must die after the mock send and leave the DB attempt in flight',
    async () => {
      const { rows } = await db.query(
        `SELECT s.status AS slot_status, a.status AS attempt_status,
                (SELECT count(*)::int FROM mock_posts WHERE idempotency_key = $2) AS mock_post_count
           FROM slots s
           LEFT JOIN publish_attempts a ON a.slot_id = s.id
          WHERE s.id = $1`,
        [slotId, idempotencyKey],
      );
      return rows[0]?.slot_status === 'publishing'
        && rows[0]?.attempt_status === 'in_flight'
        && rows[0]?.mock_post_count === 1;
    },
    crashWorker,
  );
  const crash = await raceTimeout(crashWorker.exited, 10_000);
  assert.ok(crash, `crash worker did not exit after the failpoint.\n${crashWorker.logTail.join('\n')}`);
  assert.equal(crash.signal, 'SIGKILL', 'the first worker must be hard-killed after the mock target commits');

  const crashedSlot = await repo.getSlot(slotId);
  const crashedAttempt = await repo.findAttemptByKey(idempotencyKey);
  assert.equal(crashedSlot?.status, 'publishing', 'crash must leave a recoverable publishing slot');
  assert.equal(crashedAttempt?.status, 'in_flight', 'crash must occur before attempt success is recorded');

  // BullQueue.start() must reclaim the orphaned DB claim; its real Redis-backed
  // scanner then submits a fresh slot job. The mock target's unique key protects the resend.
  recoveryWorker = startWorker(false);
  await waitUntil(
    'restarted worker must recover and finish the slot',
    async () => {
      const recovered = await repo.getSlot(slotId!);
      const attempt = await repo.findAttemptByKey(idempotencyKey!);
      return recovered?.status === 'published' && attempt?.status === 'succeeded';
    },
    recoveryWorker,
  );

  const { rows: posts } = await db.query(
    'SELECT id FROM mock_posts WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  assert.equal(posts.length, 1, 'recovery must leave exactly one mock-side post');
  console.log('BullMQ restart check passed: hard worker kill after send recovered to published with one idempotent mock post.');
} finally {
  await stopWorker(crashWorker);
  await stopWorker(recoveryWorker);
  try {
    await clearTestQueue();
  } finally {
    if (idempotencyKey) await db.query('DELETE FROM mock_posts WHERE idempotency_key = $1', [idempotencyKey]);
    if (postId !== undefined) await db.query('DELETE FROM posts WHERE id = $1', [postId]);
    await db.close();
  }
}
