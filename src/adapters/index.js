import { MastodonPublisher } from './mastodon.js';
import { TelegramPublisher } from './telegram.js';
import { MockXPublisher, MockLinkedInPublisher } from './mock.js';
import { config } from '../config.js';

/**
 * The adapter registry. Which adapters exist and how they map to platform ids is the
 * ONLY thing that changes to swap a target. PROBE 6 — "point mastodon at a mock" — is
 * done purely with the ADAPTER_OVERRIDE env var; no business logic is touched.
 */
const builders = {
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

// ADAPTER_OVERRIDE="mastodon=mock_x,other=..." reroutes a platform to another adapter.
const overrides = parseOverrides(config.adapterOverride);

const cache = new Map();

export function getAdapter(platformId) {
  const target = overrides[platformId] ?? platformId;
  if (!builders[target]) {
    throw new Error(`no adapter registered for "${target}" (known: ${Object.keys(builders).join(', ')})`);
  }
  if (!cache.has(target)) cache.set(target, builders[target]());
  return cache.get(target);
}

export function knownAdapters() {
  return Object.keys(builders);
}

function parseOverrides(spec) {
  const out = {};
  if (!spec) return out;
  for (const pair of spec.split(',')) {
    const [from, to] = pair.split('=').map((s) => s.trim());
    if (from && to) out[from] = to;
  }
  return out;
}
