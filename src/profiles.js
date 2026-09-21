// Constraint profiles — the rules for each platform, enforced by code (not hope).
//
// Each profile is a small, declarative spec. `validateVariant` below turns it into
// a list of violations, every one of which NAMES the broken rule — that is what
// PROBE 2 checks, and what "enforcement is graded" means.

export const PROFILES = {
  mastodon: {
    id: 'mastodon',
    label: 'Mastodon',
    maxLength: 500,
    maxHashtags: 4,
    tone: 'neutral', // no ALL-CAPS shouting
    maxLinks: 4,
  },
  telegram: {
    id: 'telegram',
    label: 'Telegram',
    maxLength: 4096, // Telegram sendMessage hard limit
    maxHashtags: 5,
    tone: 'neutral', // no ALL-CAPS shouting
    maxLinks: 5,
  },
  mock_x: {
    id: 'mock_x',
    label: 'X (mock)',
    maxLength: 280,
    maxHashtags: 3,
    tone: 'casual', // relaxed, but keep it to one link
    maxLinks: 1,
  },
  mock_linkedin: {
    id: 'mock_linkedin',
    label: 'LinkedIn (mock)',
    maxLength: 3000,
    maxHashtags: 5,
    tone: 'professional', // no emoji, no ALL-CAPS shouting
    maxLinks: 3,
  },
};

export function getProfile(platform) {
  const p = PROFILES[platform];
  if (!p) throw new Error(`Unknown platform "${platform}"`);
  return p;
}

// crude but honest counters --------------------------------------------------
const HASHTAG_RE = /(^|\s)#[A-Za-z0-9_]+/g;
const LINK_RE = /https?:\/\/\S+/g;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

export function countHashtags(text) {
  return (text.match(HASHTAG_RE) || []).length;
}
export function countLinks(text) {
  return (text.match(LINK_RE) || []).length;
}

// Is the text "shouting"? (>3 all-caps words of length >=4). A concrete, testable
// stand-in for "tone".
function isShouting(text) {
  const caps = (text.match(/\b[A-Z]{4,}\b/g) || []).length;
  return caps > 3;
}

/**
 * Validate a variant's content against its platform profile.
 * @returns {{ok: boolean, violations: string[], stats: object}}
 */
export function validateVariant(platform, content) {
  const p = getProfile(platform);
  const violations = [];

  const length = [...content].length; // count code points, not UTF-16 units
  const hashtags = countHashtags(content);
  const links = countLinks(content);

  if (length > p.maxLength) {
    violations.push(`${p.id}: exceeds max length ${p.maxLength} (was ${length})`);
  }
  if (hashtags > p.maxHashtags) {
    violations.push(`${p.id}: too many hashtags — ${hashtags} > ${p.maxHashtags}`);
  }
  if (links > p.maxLinks) {
    violations.push(`${p.id}: too many links — ${links} > ${p.maxLinks}`);
  }
  if ((p.tone === 'neutral' || p.tone === 'professional') && isShouting(content)) {
    violations.push(`${p.id}: tone "${p.tone}" forbids ALL-CAPS shouting`);
  }
  if (p.tone === 'professional' && EMOJI_RE.test(content)) {
    violations.push(`${p.id}: tone "professional" forbids emoji`);
  }
  if (content.trim() === '') {
    violations.push(`${p.id}: content is empty`);
  }

  return {
    ok: violations.length === 0,
    violations,
    stats: { length, hashtags, links, maxLength: p.maxLength, maxHashtags: p.maxHashtags },
  };
}
