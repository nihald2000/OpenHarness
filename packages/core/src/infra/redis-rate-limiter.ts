export class RedisRateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(opts?: { redisUrl?: string }) {
    const url = opts?.redisUrl ?? process.env.REDIS_URL;
    if (!url) {
      throw new Error("RedisRateLimiter requires REDIS_URL to be configured (fail closed)");
    }
  }

  checkLimit(key: string, limit: number, windowMs: number, now = Date.now()): { allowed: boolean; remaining: number } {
    const existing = this.windows.get(key);
    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: Math.max(0, limit - 1) };
    }
    if (existing.count >= limit) {
      return { allowed: false, remaining: 0 };
    }
    existing.count += 1;
    return { allowed: true, remaining: Math.max(0, limit - existing.count) };
  }
}
