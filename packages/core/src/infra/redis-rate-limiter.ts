import Redis from "ioredis";
import type { RateLimiter } from "./contracts.ts";

const TOKEN_BUCKET = `
local values = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local tokens = tonumber(values[1]) or capacity
local updated = tonumber(values[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - updated) * refill / 1000)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / refill * 1000)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated', now)
redis.call('PEXPIRE', KEYS[1], math.max(1000, math.ceil(capacity / refill * 2000)))
return {allowed, tokens, retry}
`;

/** Atomic Redis token bucket; all app instances share the same balance. */
export class RedisRateLimiter implements RateLimiter {
  private readonly redis: Redis;
  constructor(redis: Redis, private readonly ownsClient = false, private readonly prefix = "openharness:rl:") { this.redis = redis; }
  static connect(url: string, options: Redis.RedisOptions = {}) { return new RedisRateLimiter(new Redis(url, options), true); }
  async consume(key: string, input: { capacity: number; refillPerSecond: number; cost?: number }) {
    const { capacity, refillPerSecond } = input;
    const cost = input.cost ?? 1;
    if (!key) throw new Error("rate limit key is required");
    if (![capacity, refillPerSecond, cost].every(Number.isFinite) || capacity <= 0 || refillPerSecond <= 0 || cost <= 0 || cost > capacity) throw new Error("rate limit values must be positive and cost cannot exceed capacity");
    const result = await this.redis.eval(TOKEN_BUCKET, 1, `${this.prefix}${key}`, String(capacity), String(refillPerSecond), String(cost), String(Date.now())) as [number, number, number];
    return { allowed: Number(result[0]) === 1, remaining: Math.max(0, Number(result[1])), retryAfterMs: Math.max(0, Number(result[2])) };
  }
  async close() { if (this.ownsClient) await this.redis.quit(); }
}
