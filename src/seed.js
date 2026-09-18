/**
 * One-command seed: ingest a sample post, generate variants, approve two, and
 * schedule them a minute out so the running server publishes them on the next tick.
 *
 *   npm run seed      # after `npm start` in another terminal (or standalone)
 *
 * It talks to the HTTP API (BASE_URL, default http://localhost:3000) so it exercises
 * the exact same paths a reviewer would.
 */
const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const SAMPLE = {
  title: 'How we cut our build times in half',
  markdown: `# How we cut our build times in half

We profiled the pipeline, cached dependencies aggressively, and parallelised the
test matrix. The result: CI dropped from 22 minutes to under 10, and shipping got
a lot less painful. Here is what actually moved the needle.`,
};

async function j(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

async function main() {
  console.log(`seeding against ${BASE} ...`);
  const post = await j('POST', '/posts', SAMPLE);
  console.log(`• ingested post #${post.id}: "${post.title}"`);

  const gen = await j('POST', `/posts/${post.id}/generate`, {});
  console.log(`• generated ${gen.created.length} valid variant(s), blocked ${gen.blocked.length}`);

  // Approve + schedule the first two valid variants ~1 minute from now.
  const when = new Date(Date.now() + 60_000).toISOString();
  for (const v of gen.created.slice(0, 2)) {
    await j('POST', `/variants/${v.id}/approve`);
    const slot = await j('POST', `/variants/${v.id}/schedule`, { adapter: v.platform, at: when });
    console.log(`• approved variant #${v.id} (${v.platform}) -> slot #${slot.id} at ${when}`);
  }

  console.log('\nseed done. Watch the server logs — the scheduler will publish these shortly.');
  console.log(`Then check:  curl ${BASE}/history   and   curl ${BASE}/mock-posts`);
}

main().catch((err) => {
  console.error('seed failed:', err.message);
  console.error('is the server running?  npm start   (in another terminal)');
  process.exit(1);
});
