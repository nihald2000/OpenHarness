import type { RateLimiter } from "./contracts.ts";

/** Token-bucket limiter for one-process local mode and adapter contract tests. */
export class InProcessRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private operations = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  async consume(key: string, input: { capacity: number; refillPerSecond: number; cost?: number }) {
    const { capacity, refillPerSecond } = input;
    const cost = input.cost ?? 1;
    if (!key) throw new Error("rate limit key is required");
    if (!Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(refillPerSecond) || refillPerSecond < 0 || !Number.isFinite(cost) || cost <= 0 || cost > capacity) {
      throw new Error("capacity and cost must be positive, cost cannot exceed capacity, and refillPerSecond cannot be negative");
    }
    const now = this.clock();
    const previous = this.buckets.get(key);
    const elapsed = previous ? Math.max(0, now - previous.updatedAt) / 1_000 : 0;
    const tokens = Math.min(capacity, (previous?.tokens ?? capacity) + elapsed * refillPerSecond);
    const allowed = tokens >= cost;
    const remaining = allowed ? tokens - cost : tokens;
    this.buckets.set(key, { tokens: remaining, updatedAt: now });
    if (++this.operations % 256 === 0) {
      const cutoff = now - 60 * 60_000;
      for (const [bucketKey, bucket] of this.buckets) if (bucket.updatedAt < cutoff) this.buckets.delete(bucketKey);
    }
    return {
      allowed,
      remaining: Math.floor(remaining * 1_000) / 1_000,
      retryAfterMs: allowed ? 0 : refillPerSecond > 0 ? Math.ceil((cost - tokens) / refillPerSecond * 1_000) : Number.MAX_SAFE_INTEGER,
    };
  }
}
