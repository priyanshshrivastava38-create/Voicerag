// In-process token bucket for expensive operations (per user + action).
// Suitable for a single web instance; use a shared store (e.g. Redis) when scaling out.
import { tooMany } from "./errors";

const buckets = new Map<string, { tokens: number; updated: number }>();

export function rateLimit(key: string, capacity: number, perMinute: number) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: capacity, updated: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.updated) / 60_000) * perMinute);
  b.updated = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    throw tooMany();
  }
  b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (now - v.updated > 600_000) buckets.delete(k);
}
