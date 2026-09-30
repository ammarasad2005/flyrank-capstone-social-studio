import { z } from 'zod';
import { knownPlatforms } from './generator.js';

// ── env schema (T0-D) ──────────────────────────────────────────────────────────
// One validated boundary between the environment and the app. A bad/typo'd value
// fails fast at boot with a readable message instead of surfacing as a weird bug
// three layers deep. zod does the coercion so the rest of the code sees real types.
const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? dflt : !['false', '0', 'no', 'off'].includes(v.toLowerCase())));

const csv = z
  .string()
  .default('telegram,mock_x,mock_linkedin')
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  PLATFORMS: csv,
  USE_AI: bool(false),

  // queue engine
  QUEUE_DRIVER: z.enum(['inprocess', 'bull']).default('inprocess'),
  REDIS_URL: z.string().default(''),

  // retry / backoff / dead-letter
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  RETRY_BASE_MS: z.coerce.number().int().min(1).default(5000),
  ALERT_WEBHOOK_URL: z.string().default(''),

  // scheduler (in-process poller)
  SCHEDULER_TICK_MS: z.coerce.number().int().min(50).default(2000),
  SCHEDULER_ENABLED: bool(true),

  // observability (T0-C)
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  METRICS_ENABLED: bool(true),
  SENTRY_DSN: z.string().default(''),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

  // adapters
  ADAPTER_OVERRIDE: z.string().default(''),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  TELEGRAM_PARSE_MODE: z.string().default(''),
  MASTODON_BASE_URL: z.string().default(''),
  MASTODON_ACCESS_TOKEN: z.string().default(''),
  MASTODON_VISIBILITY: z.string().default('unlisted'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}
const env = parsed.data;

export const config = {
  port: env.PORT,
  platforms: env.PLATFORMS,
  useAI: env.USE_AI,
  queue: {
    driver: env.QUEUE_DRIVER,
    redisUrl: env.REDIS_URL,
  },
  retry: {
    maxAttempts: env.RETRY_MAX_ATTEMPTS,
    baseMs: env.RETRY_BASE_MS,
  },
  alertWebhookUrl: env.ALERT_WEBHOOK_URL,
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
    parseMode: env.TELEGRAM_PARSE_MODE,
  },
  mastodon: {
    baseUrl: env.MASTODON_BASE_URL,
    accessToken: env.MASTODON_ACCESS_TOKEN,
    visibility: env.MASTODON_VISIBILITY,
  },
  adapterOverride: env.ADAPTER_OVERRIDE,
  scheduler: {
    tickMs: env.SCHEDULER_TICK_MS,
    enabled: env.SCHEDULER_ENABLED,
  },
  logLevel: env.LOG_LEVEL,
  metrics: {
    enabled: env.METRICS_ENABLED,
  },
  sentry: {
    dsn: env.SENTRY_DSN,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
  },
};

// fail fast on a typo in PLATFORMS
const known = new Set(knownPlatforms());
for (const p of config.platforms) {
  if (!known.has(p)) {
    throw new Error(`PLATFORMS contains unknown platform "${p}". Known: ${[...known].join(', ')}`);
  }
}

// bull needs a Redis endpoint — catch the misconfig at boot, not on first job.
if (config.queue.driver === 'bull' && !config.queue.redisUrl) {
  throw new Error('QUEUE_DRIVER=bull requires REDIS_URL (a rediss://… TCP endpoint).');
}
