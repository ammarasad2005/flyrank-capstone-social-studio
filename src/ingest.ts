// Turn an incoming request into a stored-post shape. Two sources: a URL to fetch,
// or pasted Markdown. The result is the single source of truth for all generation.

interface IngestBody {
  url?: string;
  markdown?: string;
  title?: string;
}
export interface IngestResult {
  source_type: 'url' | 'markdown';
  source_url: string | null;
  title: string;
  content_md: string;
}

function htmlToText(html: string): { title: string; content_md: string } {
  const title =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ||
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '') ||
    'Untitled';

  const bodyMatch = html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<body[\s\S]*?<\/body>/i);
  const chunk = bodyMatch ? bodyMatch[0] : html;
  const text = chunk
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return { title: title.trim(), content_md: text };
}

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

export async function ingestFromBody(body: IngestBody): Promise<IngestResult> {
  if (body?.url) {
    let res: Response;
    try {
      res = await fetch(body.url, { headers: { 'User-Agent': 'social-studio/1.0' } });
    } catch (err) {
      throw httpError(`could not fetch url: ${(err as Error).message}`, 400);
    }
    if (!res.ok) throw httpError(`url returned ${res.status}`, 400);
    const html = await res.text();
    const { title, content_md } = htmlToText(html);
    if (!content_md) throw httpError('no readable content at url', 400);
    return { source_type: 'url', source_url: body.url, title: body.title || title, content_md };
  }

  if (body?.markdown && String(body.markdown).trim()) {
    const md = String(body.markdown);
    const title = body.title || md.match(/^#\s+(.+)$/m)?.[1] || md.trim().split('\n')[0].slice(0, 80);
    return { source_type: 'markdown', source_url: null, title: title.trim(), content_md: md };
  }

  throw httpError('provide either { "url": "..." } or { "markdown": "...", "title": "..." }', 400);
}
