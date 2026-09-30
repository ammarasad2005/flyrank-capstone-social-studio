// T0-A: the atomic claim (FOR UPDATE SKIP LOCKED) must never hand the same slot to two
// callers. Here we fire many concurrent claimDueSlot() calls and assert every claimed
// slot id is unique and each due slot is claimed exactly once.
//
// Note: PGlite is a single in-process connection, so this proves the claim LOGIC is
// correct (no double-claim). True multi-connection contention is validated against a
// networked Postgres (DATABASE_URL) in CI/staging, where the same query runs unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.SCHEDULER_ENABLED = 'false';
process.env.PLATFORMS = 'mock_x';

const repo = await import('../src/repo.js');

test('claimDueSlot never hands the same due slot to two concurrent callers', async () => {
  const post = await repo.insertPost({ source_type: 'markdown', title: 'C', content_md: '# C\n\nbody' });
  const N = 12;
  const past = new Date(Date.now() - 60_000).toISOString();
  for (let i = 0; i < N; i++) {
    const v = await repo.insertVariant({ post_id: post.id, platform: 'mock_x', content: `post ${i}`, status: 'approved' });
    await repo.insertSlot({ variant_id: v.id, adapter: 'mock_x', scheduled_at: past });
  }

  // 2N concurrent claim attempts against N due slots.
  const claims = await Promise.all(Array.from({ length: N * 2 }, () => repo.claimDueSlot()));
  const claimedIds = claims.filter(Boolean).map((s) => s!.id);

  assert.equal(claimedIds.length, N, 'exactly N slots claimed (the rest returned null)');
  assert.equal(new Set(claimedIds).size, N, 'no slot was claimed twice');
});
