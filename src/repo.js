// Data-access layer — every SQL statement lives here, so routes/scheduler stay
// clean and there is one place to reason about the store.
import { db } from './db.js';

// ── posts ─────────────────────────────────────────────────────────────────────
const insertPostStmt = db.prepare(`
  INSERT INTO posts (source_type, source_url, title, content_md)
  VALUES (@source_type, @source_url, @title, @content_md)
`);
export function insertPost(post) {
  const info = insertPostStmt.run({
    source_type: post.source_type,
    source_url: post.source_url ?? null,
    title: post.title,
    content_md: post.content_md,
  });
  return getPost(info.lastInsertRowid);
}
export function getPost(id) {
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id) ?? null;
}

// ── variants ──────────────────────────────────────────────────────────────────
const insertVariantStmt = db.prepare(`
  INSERT INTO variants (post_id, platform, content, hashtags, status)
  VALUES (@post_id, @platform, @content, @hashtags, @status)
`);
export function insertVariant(v) {
  const info = insertVariantStmt.run({
    post_id: v.post_id,
    platform: v.platform,
    content: v.content,
    hashtags: JSON.stringify(v.hashtags ?? []),
    status: v.status ?? 'draft',
  });
  return getVariant(info.lastInsertRowid);
}
export function getVariant(id) {
  const row = db.prepare('SELECT * FROM variants WHERE id = ?').get(id);
  if (!row) return null;
  row.hashtags = JSON.parse(row.hashtags);
  return row;
}
export function listVariants({ post_id, status } = {}) {
  let sql = 'SELECT * FROM variants';
  const where = [];
  const args = [];
  if (post_id) { where.push('post_id = ?'); args.push(post_id); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id';
  return db.prepare(sql).all(...args).map((r) => ({ ...r, hashtags: JSON.parse(r.hashtags) }));
}
export function updateVariant(id, fields) {
  const sets = [];
  const args = {};
  for (const [k, val] of Object.entries(fields)) {
    sets.push(`${k} = @${k}`);
    args[k] = k === 'hashtags' ? JSON.stringify(val) : val;
  }
  sets.push(`updated_at = datetime('now')`);
  args.id = id;
  db.prepare(`UPDATE variants SET ${sets.join(', ')} WHERE id = @id`).run(args);
  return getVariant(id);
}

// ── slots ─────────────────────────────────────────────────────────────────────
const insertSlotStmt = db.prepare(`
  INSERT INTO slots (variant_id, adapter, scheduled_at, status)
  VALUES (@variant_id, @adapter, @scheduled_at, 'pending')
`);
export function insertSlot(s) {
  const info = insertSlotStmt.run(s);
  return getSlot(info.lastInsertRowid);
}
export function getSlot(id) {
  return db.prepare('SELECT * FROM slots WHERE id = ?').get(id) ?? null;
}
export function listSlots() {
  return db.prepare('SELECT * FROM slots ORDER BY scheduled_at').all();
}

// Atomically claim ONE due, pending slot whose variant is approved. Returns the
// claimed slot or null. The WHERE status='pending' guard means only one caller
// can win the transition — the basis of duplicate-free scheduling.
export function claimDueSlot(nowIso) {
  const tx = db.transaction(() => {
    const slot = db.prepare(`
      SELECT s.* FROM slots s
      JOIN variants v ON v.id = s.variant_id
      WHERE s.status = 'pending'
        AND s.scheduled_at <= ?
        AND v.status IN ('approved','published')
      ORDER BY s.scheduled_at
      LIMIT 1
    `).get(nowIso);
    if (!slot) return null;
    const res = db.prepare(
      `UPDATE slots SET status='publishing', claimed_at=datetime('now')
       WHERE id = ? AND status='pending'`
    ).run(slot.id);
    if (res.changes === 0) return null; // lost the race
    return getSlot(slot.id);
  });
  return tx();
}

// Slots stuck in 'publishing' from a crash mid-batch — re-run them on restart.
export function reclaimStuckSlots() {
  const rows = db.prepare(`SELECT * FROM slots WHERE status='publishing'`).all();
  return rows;
}
export function setSlotStatus(id, status) {
  db.prepare('UPDATE slots SET status = ? WHERE id = ?').run(status, id);
  return getSlot(id);
}

// ── publish_attempts (history + idempotency) ───────────────────────────────────
export function findAttemptByKey(key) {
  return db.prepare('SELECT * FROM publish_attempts WHERE idempotency_key = ?').get(key) ?? null;
}
export function insertPendingAttempt({ variant_id, slot_id, idempotency_key, adapter, attempt_no }) {
  const info = db.prepare(`
    INSERT INTO publish_attempts (variant_id, slot_id, idempotency_key, adapter, status, attempt_no)
    VALUES (@variant_id, @slot_id, @idempotency_key, @adapter, 'pending', @attempt_no)
  `).run({ variant_id, slot_id, idempotency_key, adapter, attempt_no: attempt_no ?? 1 });
  return db.prepare('SELECT * FROM publish_attempts WHERE id = ?').get(info.lastInsertRowid);
}
// Mark an attempt as 'in_flight' immediately BEFORE issuing the network send, so a
// crash in the send window is recoverable (and detectable for non-idempotent targets).
export function markAttemptInFlight(id) {
  db.prepare(`UPDATE publish_attempts SET status='in_flight', updated_at=datetime('now') WHERE id=?`).run(id);
  return db.prepare('SELECT * FROM publish_attempts WHERE id = ?').get(id);
}
export function finishAttempt(id, { status, external_id, external_url, preview, error }) {
  db.prepare(`
    UPDATE publish_attempts
       SET status=@status, external_id=@external_id, external_url=@external_url,
           preview=@preview, error=@error, updated_at=datetime('now')
     WHERE id=@id
  `).run({ id, status, external_id: external_id ?? null, external_url: external_url ?? null,
           preview: preview ?? null, error: error ?? null });
  return db.prepare('SELECT * FROM publish_attempts WHERE id = ?').get(id);
}
export function listAttempts() {
  return db.prepare('SELECT * FROM publish_attempts ORDER BY id DESC').all();
}

// ── mock_posts (mock adapters' own idempotent store) ───────────────────────────
// Idempotent by idempotency_key: a repeat with the same key returns the first row.
export function upsertMockPost({ adapter, idempotency_key, content }) {
  const info = db.prepare(
    `INSERT OR IGNORE INTO mock_posts (adapter, idempotency_key, content) VALUES (?,?,?)`
  ).run(adapter, idempotency_key, content);
  const row = db.prepare('SELECT * FROM mock_posts WHERE idempotency_key = ?').get(idempotency_key);
  return { row, created: info.changes === 1 };
}
export function listMockPosts() {
  return db.prepare('SELECT * FROM mock_posts ORDER BY id DESC').all();
}
