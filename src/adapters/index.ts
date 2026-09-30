import { MastodonPublisher } from './mastodon.js';
import { TelegramPublisher } from './telegram.js';
import { MockXPublisher, MockLinkedInPublisher } from './mock.js';
import { SocialPublisher } from './base.js';
import { config } from '../config.js';

/**
 * The adapter registry. Which adapters exist + how they map to platform ids is the only
 * thing that changes to swap a target. ADAPTER_OVERRIDE reroutes a platform to another
 * adapter (PROBE 6) with zero business-logic change.
 */
const builders: Record<string, () => SocialPublisher> = {
  telegram: () => new TelegramPublisher({
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
    parseMode: config.telegram.parseMode,
  }),
  mastodon: () => new MastodonPublisher({
    baseUrl: config.mastodon.baseUrl,
    accessToken: config.mastodon.accessToken,
    visibility: config.mastodon.visibility,
  }),
  mock_x: () => new MockXPublisher(),
  mock_linkedin: () => new MockLinkedInPublisher(),
};

const overrides = parseOverrides(config.adapterOverride);
const cache = new Map<string, SocialPublisher>();

export function getAdapter(platformId: string): SocialPublisher {
  const target = overrides[platformId] ?? platformId;
  const build = builders[target];
  if (!build) {
    throw new Error(`no adapter registered for "${target}" (known: ${Object.keys(builders).join(', ')})`);
  }
  if (!cache.has(target)) cache.set(target, build());
  return cache.get(target)!;
}

export function knownAdapters(): string[] {
  return Object.keys(builders);
}

function parseOverrides(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!spec) return out;
  for (const pair of spec.split(',')) {
    const [from, to] = pair.split('=').map((s) => s.trim());
    if (from && to) out[from] = to;
  }
  return out;
}
