// Turn an incoming request into a stored-post shape. Two sources: a URL to fetch,
// or pasted Markdown. The result is the single source of truth for all generation.

function htmlToText(html) {
  const title =
    (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]) ||
    (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]) ||
    (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '')) ||
    'Untitled';

  // prefer <article>, else <body>
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

/**
 * Build a post record from the request body.
 * @param {{url?:string, markdown?:string, title?:string}} body
 * @returns {Promise<{source_type,source_url,title,content_md}>}
 */
export async function ingestFromBody(body) {
  if (body?.url) {
    let res;
    try {
      res = await fetch(body.url, { headers: { 'User-Agent': 'social-studio/1.0' } });
    } catch (err) {
      throw Object.assign(new Error(`could not fetch url: ${err.message}`), { status: 400 });
    }
    if (!res.ok) throw Object.assign(new Error(`url returned ${res.status}`), { status: 400 });
    const html = await res.text();
    const { title, content_md } = htmlToText(html);
    if (!content_md) throw Object.assign(new Error('no readable content at url'), { status: 400 });
    return { source_type: 'url', source_url: body.url, title: body.title || title, content_md };
  }

  if (body?.markdown && String(body.markdown).trim()) {
    const md = String(body.markdown);
    const title = body.title || md.match(/^#\s+(.+)$/m)?.[1] || md.trim().split('\n')[0].slice(0, 80);
    return { source_type: 'markdown', source_url: null, title: title.trim(), content_md: md };
  }

  throw Object.assign(new Error('provide either { "url": "..." } or { "markdown": "...", "title": "..." }'),
    { status: 400 });
}
