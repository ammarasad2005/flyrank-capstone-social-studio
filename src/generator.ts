// Variant generation. Templates are the default (deterministic, zero setup); an
// optional Gemini path produces nicer prose. EITHER way the output is validated —
// because enforcement, not generation, is graded.
import { PROFILES, getProfile, validateVariant, type Validation } from './profiles.js';
import type { Post } from './types.js';

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentences(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (lastStop > 40 ? cut.slice(0, lastStop + 1) : cut.slice(0, max - 1).trimEnd() + '…').trim();
}

function hashtagsFromTitle(title: string, n: number): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'your', 'from', 'that', 'this', 'into', 'you']);
  const words = title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w));
  const seen: string[] = [];
  for (const w of words) {
    const tag = '#' + w.replace(/(^|-)(\w)/g, (_m, _p, c: string) => c.toUpperCase());
    if (!seen.includes(tag)) seen.push(tag);
    if (seen.length >= n) break;
  }
  return seen;
}

interface Candidate { content: string; hashtags: string[]; _fallback?: string }

function templateFor(platform: string, post: Post): Candidate {
  const p = getProfile(platform);
  let body = stripMarkdown(post.content_md);
  if (body.toLowerCase().startsWith(post.title.toLowerCase())) {
    body = body.slice(post.title.length).replace(/^[\s:–-]+/, '').trim();
  }
  const tags = hashtagsFromTitle(post.title, Math.max(1, p.maxHashtags - 1));
  const tagLine = tags.join(' ');

  if (platform === 'mock_x') {
    const budget = p.maxLength - post.title.length - tagLine.length - 6;
    const excerpt = firstSentences(body, Math.max(20, budget));
    return { content: `${post.title} — ${excerpt}\n\n${tagLine}`.trim(), hashtags: tags };
  }
  if (platform === 'mock_linkedin') {
    const excerpt = firstSentences(body, 1200);
    return { content: `${post.title}\n\n${excerpt}\n\nRead more in the full post.\n\n${tagLine}`.trim(), hashtags: tags };
  }
  if (platform === 'telegram') {
    const excerpt = firstSentences(body, 900);
    return { content: `${post.title}\n\n${excerpt}\n\n${tagLine}`.trim(), hashtags: tags };
  }
  const budget = p.maxLength - post.title.length - tagLine.length - 8;
  const excerpt = firstSentences(body, Math.max(20, budget));
  return { content: `${post.title}\n\n${excerpt}\n\n${tagLine}`.trim(), hashtags: tags };
}

async function geminiFor(platform: string, post: Post): Promise<{ content: string; hashtags: string[]; usage: any }> {
  const p = getProfile(platform);
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const prompt = `Rewrite this blog post as a single ${p.label} social post.
Rules you MUST obey: at most ${p.maxLength} characters, at most ${p.maxHashtags} hashtags, ${p.tone} tone.
Return ONLY the post text (with hashtags at the end). No preamble.

TITLE: ${post.title}
POST:
${stripMarkdown(post.content_md).slice(0, 4000)}`;

  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  const content = (data.choices?.[0]?.message?.content ?? '').trim();
  const tags = (content.match(/(^|\s)#[A-Za-z0-9_]+/g) || []).map((s: string) => s.trim());
  return { content, hashtags: tags, usage: data.usage ?? null };
}

export interface GeneratedCandidate {
  platform: string;
  content: string;
  hashtags: string[];
  validation: Validation;
  usage: any;
  fallback?: string;
}

export async function generateCandidate(platform: string, post: Post, opts: { useAI?: boolean } = {}): Promise<GeneratedCandidate> {
  getProfile(platform);
  let out: Candidate;
  let usage: any = null;
  if (opts.useAI && process.env.GEMINI_API_KEY) {
    try {
      const g = await geminiFor(platform, post);
      out = { content: g.content, hashtags: g.hashtags };
      usage = g.usage;
    } catch (err) {
      out = templateFor(platform, post);
      out._fallback = String((err as Error).message);
    }
  } else {
    out = templateFor(platform, post);
  }
  const validation = validateVariant(platform, out.content);
  return { platform, content: out.content, hashtags: out.hashtags, validation, usage, fallback: out._fallback };
}

export function knownPlatforms(): string[] {
  return Object.keys(PROFILES);
}
