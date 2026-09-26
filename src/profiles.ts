// Constraint profiles — the rules for each platform, enforced by code (not hope).
// validateVariant turns a profile into a list of violations, each NAMING the rule.

export interface Profile {
  id: string;
  label: string;
  maxLength: number;
  maxHashtags: number;
  tone: 'neutral' | 'casual' | 'professional';
  maxLinks: number;
}

export const PROFILES: Record<string, Profile> = {
  mastodon: { id: 'mastodon', label: 'Mastodon', maxLength: 500, maxHashtags: 4, tone: 'neutral', maxLinks: 4 },
  telegram: { id: 'telegram', label: 'Telegram', maxLength: 4096, maxHashtags: 5, tone: 'neutral', maxLinks: 5 },
  mock_x: { id: 'mock_x', label: 'X (mock)', maxLength: 280, maxHashtags: 3, tone: 'casual', maxLinks: 1 },
  mock_linkedin: { id: 'mock_linkedin', label: 'LinkedIn (mock)', maxLength: 3000, maxHashtags: 5, tone: 'professional', maxLinks: 3 },
};

export function getProfile(platform: string): Profile {
  const p = PROFILES[platform];
  if (!p) throw new Error(`Unknown platform "${platform}"`);
  return p;
}

const HASHTAG_RE = /(^|\s)#[A-Za-z0-9_]+/g;
const LINK_RE = /https?:\/\/\S+/g;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

export function countHashtags(text: string): number {
  return (text.match(HASHTAG_RE) || []).length;
}
export function countLinks(text: string): number {
  return (text.match(LINK_RE) || []).length;
}
function isShouting(text: string): boolean {
  const caps = (text.match(/\b[A-Z]{4,}\b/g) || []).length;
  return caps > 3;
}

export interface Validation {
  ok: boolean;
  violations: string[];
  stats: { length: number; hashtags: number; links: number; maxLength: number; maxHashtags: number };
}

export function validateVariant(platform: string, content: string): Validation {
  const p = getProfile(platform);
  const violations: string[] = [];

  const length = [...content].length;
  const hashtags = countHashtags(content);
  const links = countLinks(content);

  if (length > p.maxLength) violations.push(`${p.id}: exceeds max length ${p.maxLength} (was ${length})`);
  if (hashtags > p.maxHashtags) violations.push(`${p.id}: too many hashtags — ${hashtags} > ${p.maxHashtags}`);
  if (links > p.maxLinks) violations.push(`${p.id}: too many links — ${links} > ${p.maxLinks}`);
  if ((p.tone === 'neutral' || p.tone === 'professional') && isShouting(content)) {
    violations.push(`${p.id}: tone "${p.tone}" forbids ALL-CAPS shouting`);
  }
  if (p.tone === 'professional' && EMOJI_RE.test(content)) {
    violations.push(`${p.id}: tone "professional" forbids emoji`);
  }
  if (content.trim() === '') violations.push(`${p.id}: content is empty`);

  return {
    ok: violations.length === 0,
    violations,
    stats: { length, hashtags, links, maxLength: p.maxLength, maxHashtags: p.maxHashtags },
  };
}
