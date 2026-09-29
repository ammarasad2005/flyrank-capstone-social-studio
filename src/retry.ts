// Exponential backoff with full jitter, capped. attempt is 1-based (the attempt
// that just failed): delay ≈ base * 2^(attempt-1), plus up to 30% jitter, capped.
// Pure + deterministic-shape so it's unit-testable.
const CAP_MS = 15 * 60 * 1000; // 15 min ceiling

export function backoffMs(attempt: number, baseMs: number, cap = CAP_MS): number {
  const exp = Math.min(cap, baseMs * 2 ** (attempt - 1));
  const jitter = Math.random() * 0.3 * exp;
  return Math.round(exp + jitter);
}
