/** Sliding window. Callers store the timestamps; this module only decides. */

export function slideWindow(prev: readonly number[], now: number, windowMs: number, limit: number): { limited: boolean; next: number[] } {
  const next = prev.filter((ts) => now - ts < windowMs);
  if (next.length >= limit) return { limited: true, next };
  next.push(now);
  return { limited: false, next };
}
