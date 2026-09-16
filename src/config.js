import { knownPlatforms } from './generator.js';

export const config = {
  port: Number(process.env.PORT || 3000),
  platforms: (process.env.PLATFORMS || 'mastodon,mock_x,mock_linkedin')
    .split(',').map((s) => s.trim()).filter(Boolean),
  useAI: String(process.env.USE_AI).toLowerCase() === 'true',
  mastodon: {
    baseUrl: process.env.MASTODON_BASE_URL || '',
    accessToken: process.env.MASTODON_ACCESS_TOKEN || '',
    visibility: process.env.MASTODON_VISIBILITY || 'unlisted',
  },
  // "mastodon=mock_x" reroutes a platform to another adapter — the PROBE 6 swap.
  adapterOverride: process.env.ADAPTER_OVERRIDE || '',
  scheduler: {
    tickMs: Number(process.env.SCHEDULER_TICK_MS || 2000),
    enabled: String(process.env.SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false',
  },
};

// fail fast on a typo in PLATFORMS
const known = new Set(knownPlatforms());
for (const p of config.platforms) {
  if (!known.has(p)) {
    throw new Error(`PLATFORMS contains unknown platform "${p}". Known: ${[...known].join(', ')}`);
  }
}
