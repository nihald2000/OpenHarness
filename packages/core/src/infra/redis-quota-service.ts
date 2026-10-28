import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import type { RedisOptions } from "ioredis";
import type { QuotaService } from "./contracts.ts";

const ACQUIRE = `
local now = tonumber(ARGV[1])
local leaseUntil = now + tonumber(ARGV[2])
local tenantLimit = tonumber(ARGV[3])
local userLimit = tonumber(ARGV[4])
local member = ARGV[5]
for i=1,2 do redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now) end
local tenantHas = redis.call('ZSCORE', KEYS[1], member)
local userHas = redis.call('ZSCORE', KEYS[2], member)
if tenantHas and userHas then
  redis.call('ZADD', KEYS[1], leaseUntil, member)
  redis.call('ZADD', KEYS[2], leaseUntil, member)
  return 1
end
if (tenantLimit > 0 and redis.call('ZCARD', KEYS[1]) >= tenantLimit) or (userLimit > 0 and redis.call('ZCARD', KEYS[2]) >= userLimit) then return 0 end
redis.call('ZADD', KEYS[1], leaseUntil, member)
redis.call('ZADD', KEYS[2], leaseUntil, member)
local ttl = tonumber(ARGV[2]) * 2
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[2], ttl)
return 1
`;
const RELEASE = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

/** Redis run slots are represented by expiring per-job leases, avoiding leaked counters after crashes. */
export class RedisQuotaService implements QuotaService {
  private readonly redis: Redis;
  private readonly legacy = new Map<string, string[]>();
  constructor(redis: Redis, private readonly ownsClient = false, private readonly prefix = "openharness:quota:") { this.redis = redis; }
  static connect(url: string, options: RedisOptions = {}) { return new RedisQuotaService(new Redis(url, options), true); }

  async acquireRunSlot(tenantId: string, userId: string, limits: { tenant?: number; user?: number; leaseId?: string; leaseMs?: number }) {
    if (!tenantId || !userId) throw new Error("tenantId and userId are required");
    checkLimit(limits.tenant, "tenant"); checkLimit(limits.user, "user");
    const leaseId = limits.leaseId ?? randomUUID();
    const leaseMs = limits.leaseMs ?? 60_000;
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error("leaseMs must be a positive integer");
    const tenantKey = `${this.prefix}tenant:${tenantId}`;
    const userKey = `${this.prefix}user:${tenantId}:${userId}`;
    const result = await this.redis.eval(ACQUIRE, 2, tenantKey, userKey, String(Date.now()), String(leaseMs), String(limits.tenant ?? 0), String(limits.user ?? 0), leaseId);
    if (Number(result) === 1 && limits.leaseId === undefined) {
      const key = `${tenantId}:${userId}`;
      this.legacy.set(key, [...(this.legacy.get(key) ?? []), leaseId]);
    }
    return Number(result) === 1;
  }

  async releaseRunSlot(tenantId: string, userId: string, leaseId?: string) {
    const key = `${tenantId}:${userId}`;
    let member = leaseId;
    if (!member) {
      const leases = this.legacy.get(key) ?? [];
      member = leases.shift();
      if (!leases.length) this.legacy.delete(key); else this.legacy.set(key, leases);
    }
    if (!member) return;
    await this.redis.eval(RELEASE, 2, `${this.prefix}tenant:${tenantId}`, `${this.prefix}user:${tenantId}:${userId}`, member);
  }
  async close() { if (this.ownsClient) await this.redis.quit(); }
}

function checkLimit(value: number | undefined, name: string) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`${name} run limit must be a positive integer`);
}
