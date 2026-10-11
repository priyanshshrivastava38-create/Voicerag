// In-process token bucket for expensive operations (per user + action).
// Suitable for a single web instance; use a shared store (e.g. Redis) when scaling out.
import { tooMany } from "./errors";

const MAX_BUCKETS = 10_000;
// Map iteration order is insertion order; re-inserting on every hit keeps it least-recently-used first.
const buckets = new Map<string, { tokens: number; updated: number }>();

export function rateLimit(key: string, capacity: number, perMinute: number) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: capacity, updated: now };
  buckets.delete(key);
  b.tokens = Math.min(capacity, b.tokens + ((now - b.updated) / 60_000) * perMinute);
  b.updated = now;
  const allowed = b.tokens >= 1;
  if (allowed) b.tokens -= 1;
  buckets.set(key, b);
  // Hard cap: evict the least recently used keys, so a flood of distinct keys cannot grow memory.
  for (const k of buckets.keys()) {
    if (buckets.size <= MAX_BUCKETS) break;
    buckets.delete(k);
  }
  if (!allowed) throw tooMany();
}
