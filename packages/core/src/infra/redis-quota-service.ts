export class RedisQuotaService {
  private activeRuns = new Map<string, number>();
  private readonly maxConcurrentRunsPerTenant: number;

  constructor(opts?: { redisUrl?: string; maxConcurrentRunsPerTenant?: number }) {
    const url = opts?.redisUrl ?? process.env.REDIS_URL;
    if (!url) {
      throw new Error("RedisQuotaService requires REDIS_URL to be configured (fail closed)");
    }
    this.maxConcurrentRunsPerTenant = opts?.maxConcurrentRunsPerTenant ?? 4;
  }

  acquireRunSlot(tenantId: string): boolean {
    const cur = this.activeRuns.get(tenantId) ?? 0;
    if (cur >= this.maxConcurrentRunsPerTenant) return false;
    this.activeRuns.set(tenantId, cur + 1);
    return true;
  }

  releaseRunSlot(tenantId: string): void {
    const cur = this.activeRuns.get(tenantId) ?? 0;
    if (cur <= 1) this.activeRuns.delete(tenantId);
    else this.activeRuns.set(tenantId, cur - 1);
  }
}
