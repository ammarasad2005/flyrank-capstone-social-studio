// Data access. All async now (Postgres). The SQL is the same story as the SQLite
// version, but the claim uses FOR UPDATE SKIP LOCKED so multiple workers are safe.
import { db } from './db.js';
import { backoffMs } from './retry.js';
import type { Post, Variant, Slot, Attempt, MockPost, VariantStatus, SlotStatus } from './types.js';

// ── posts ───────────────────────────────────────────────────────────────────
export async function insertPost(post: {
  source_type: 'url' | 'markdown';
  source_url?: string | null;
  title: string;
  content_md: string;
}): Promise<Post> {
  const { rows } = await db.query(
    `INSERT INTO posts (source_type, source_url, title, content_md)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [post.source_type, post.source_url ?? null, post.title, post.content_md],
  );
  return rows[0];
}
export async function getPost(id: number): Promise<Post | null> {
  const { rows } = await db.query('SELECT * FROM posts WHERE id = $1', [id]);
  return rows[0] ?? null;
}

// ── variants ──────────────────────────────────────────────────────────────────
function parseVariant(row: any): Variant {
  return { ...row, hashtags: JSON.parse(row.hashtags) };
}
export async function insertVariant(v: {
  post_id: number;
  platform: string;
  content: string;
  hashtags?: string[];
  status?: VariantStatus;
}): Promise<Variant> {
  const { rows } = await db.query(
    `INSERT INTO variants (post_id, platform, content, hashtags, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [v.post_id, v.platform, v.content, JSON.stringify(v.hashtags ?? []), v.status ?? 'draft'],
  );
  return parseVariant(rows[0]);
}
export async function getVariant(id: number): Promise<Variant | null> {
  const { rows } = await db.query('SELECT * FROM variants WHERE id = $1', [id]);
  return rows[0] ? parseVariant(rows[0]) : null;
}
export async function listVariants(filter: { post_id?: number; status?: VariantStatus } = {}): Promise<Variant[]> {
  const where: string[] = [];
  const args: any[] = [];
  if (filter.post_id) { args.push(filter.post_id); where.push(`post_id = $${args.length}`); }
  if (filter.status) { args.push(filter.status); where.push(`status = $${args.length}`); }
  const sql = `SELECT * FROM variants ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`;
  const { rows } = await db.query(sql, args);
  return rows.map(parseVariant);
}
export async function updateVariant(id: number, fields: Record<string, any>): Promise<Variant | null> {
  const sets: string[] = [];
  const args: any[] = [];
  for (const [k, val] of Object.entries(fields)) {
    args.push(k === 'hashtags' ? JSON.stringify(val) : val);
    sets.push(`${k} = $${args.length}`);
  }
  args.push(id);
  await db.query(`UPDATE variants SET ${sets.join(', ')}, updated_at = now() WHERE id = $${args.length}`, args);
  return getVariant(id);
}

// ── slots ─────────────────────────────────────────────────────────────────────
export async function insertSlot(s: { variant_id: number; adapter: string; scheduled_at: string }): Promise<Slot> {
  const { rows } = await db.query(
    `INSERT INTO slots (variant_id, adapter, scheduled_at, status)
     VALUES ($1, $2, $3, 'pending') RETURNING *`,
    [s.variant_id, s.adapter, s.scheduled_at],
  );
  return rows[0];
}
export async function getSlot(id: number): Promise<Slot | null> {
  const { rows } = await db.query('SELECT * FROM slots WHERE id = $1', [id]);
  return rows[0] ?? null;
}
export async function listSlots(): Promise<Slot[]> {
  const { rows } = await db.query('SELECT * FROM slots ORDER BY scheduled_at');
  return rows;
}

// Atomically claim the next due slot for an approved/published variant. FOR UPDATE
// SKIP LOCKED lets N workers drain the queue with no two grabbing the same slot.
export async function claimDueSlot(): Promise<Slot | null> {
  return db.withTx(async (q) => {
    const { rows } = await q(
      `SELECT s.* FROM slots s
         JOIN variants v ON v.id = s.variant_id
        WHERE s.status = 'pending'
          AND s.scheduled_at <= now()
          AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= now())
          AND v.status IN ('approved','published')
        ORDER BY s.scheduled_at
        FOR UPDATE OF s SKIP LOCKED
        LIMIT 1`,
    );
    const slot = rows[0];
    if (!slot) return null;
    const upd = await q(
      `UPDATE slots SET status = 'publishing', claimed_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [slot.id],
    );
    return upd.rows[0] ?? null;
  });
}

// Slots stuck in 'publishing' from a crash mid-batch — re-run them on restart.
export async function reclaimStuckSlots(): Promise<Slot[]> {
  const { rows } = await db.query(`SELECT * FROM slots WHERE status = 'publishing'`);
  return rows;
}
export async function setSlotStatus(id: number, status: SlotStatus): Promise<Slot | null> {
  await db.query('UPDATE slots SET status = $1 WHERE id = $2', [status, id]);
  return getSlot(id);
}

// ── retry / dead-letter (T0-B) ─────────────────────────────────────────────────
// A slot's publish threw. Bump attempts and decide: reschedule with backoff, or
// give up and dead-letter. This is DB-owned domain logic (engine-agnostic) so the
// in-process and Bull drivers share exactly one retry model and it's testable on
// PGlite without any broker.
export async function recordSlotFailure(
  id: number,
  opts: { maxAttempts: number; baseMs: number; error: string },
): Promise<{ deadLettered: boolean; slot: Slot }> {
  return db.withTx(async (q) => {
    const cur = (await q('SELECT * FROM slots WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new Error(`slot ${id} not found`);
    const attempts = (cur.attempts ?? 0) + 1;
    if (attempts >= opts.maxAttempts) {
      const { rows } = await q(
        `UPDATE slots SET status = 'dead_letter', attempts = $2, last_error = $3,
                          claimed_at = NULL, next_attempt_at = NULL
          WHERE id = $1 RETURNING *`,
        [id, attempts, opts.error],
      );
      return { deadLettered: true, slot: rows[0] };
    }
    const delay = backoffMs(attempts, opts.baseMs);
    const { rows } = await q(
      `UPDATE slots SET status = 'pending', attempts = $2, last_error = $3,
                        claimed_at = NULL,
                        next_attempt_at = now() + ($4 || ' milliseconds')::interval
        WHERE id = $1 RETURNING *`,
      [id, attempts, opts.error, String(delay)],
    );
    return { deadLettered: false, slot: rows[0] };
  });
}

// Give up on a slot immediately (no more retries) — used for at-most-once adapters
// whose send outcome is unknown, where retrying could double-post.
export async function deadLetterSlot(id: number, error: string): Promise<Slot> {
  const { rows } = await db.query(
    `UPDATE slots SET status = 'dead_letter', last_error = $2, claimed_at = NULL,
                      next_attempt_at = NULL, attempts = attempts + 1
      WHERE id = $1 RETURNING *`,
    [id, error],
  );
  return rows[0];
}

export async function listDeadLetters(): Promise<Slot[]> {
  const { rows } = await db.query(`SELECT * FROM slots WHERE status = 'dead_letter' ORDER BY id`);
  return rows;
}
export async function countSlotsByStatus(status: SlotStatus): Promise<number> {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM slots WHERE status = $1', [status]);
  return rows[0]?.n ?? 0;
}

// ── publish_attempts (history + idempotency) ───────────────────────────────────
export async function findAttemptByKey(key: string): Promise<Attempt | null> {
  const { rows } = await db.query('SELECT * FROM publish_attempts WHERE idempotency_key = $1', [key]);
  return rows[0] ?? null;
}
// Reserve an attempt row. UNIQUE idempotency_key means a concurrent worker can't make
// a second one — ON CONFLICT returns the existing row instead of throwing.
export async function insertPendingAttempt(a: {
  variant_id: number;
  slot_id: number;
  idempotency_key: string;
  adapter: string;
  attempt_no?: number;
}): Promise<Attempt> {
  const { rows } = await db.query(
    `INSERT INTO publish_attempts (variant_id, slot_id, idempotency_key, adapter, status, attempt_no)
     VALUES ($1, $2, $3, $4, 'pending', $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [a.variant_id, a.slot_id, a.idempotency_key, a.adapter, a.attempt_no ?? 1],
  );
  if (rows[0]) return rows[0];
  return (await findAttemptByKey(a.idempotency_key))!; // lost the race — reuse theirs
}
export async function markAttemptInFlight(id: number): Promise<Attempt> {
  const { rows } = await db.query(
    `UPDATE publish_attempts SET status = 'in_flight', updated_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0];
}
export async function finishAttempt(
  id: number,
  fields: { status: string; external_id?: string | null; external_url?: string | null; preview?: string | null; error?: string | null },
): Promise<Attempt> {
  const { rows } = await db.query(
    `UPDATE publish_attempts
        SET status = $2, external_id = $3, external_url = $4, preview = $5, error = $6, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, fields.status, fields.external_id ?? null, fields.external_url ?? null, fields.preview ?? null, fields.error ?? null],
  );
  return rows[0];
}
export async function listAttempts(): Promise<Attempt[]> {
  const { rows } = await db.query('SELECT * FROM publish_attempts ORDER BY id DESC');
  return rows;
}

// ── mock_posts (mock adapters' own idempotent store) ───────────────────────────
export async function upsertMockPost(m: { adapter: string; idempotency_key: string; content: string }): Promise<{ row: MockPost; created: boolean }> {
  const ins = await db.query(
    `INSERT INTO mock_posts (adapter, idempotency_key, content) VALUES ($1, $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [m.adapter, m.idempotency_key, m.content],
  );
  if (ins.rows[0]) return { row: ins.rows[0], created: true };
  const { rows } = await db.query('SELECT * FROM mock_posts WHERE idempotency_key = $1', [m.idempotency_key]);
  return { row: rows[0], created: false };
}
export async function listMockPosts(): Promise<MockPost[]> {
  const { rows } = await db.query('SELECT * FROM mock_posts ORDER BY id DESC');
  return rows;
}
