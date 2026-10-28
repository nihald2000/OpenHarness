import type { QuotaService } from "./contracts.ts";

/** Atomic per-process run-slot counters for local mode. */
export class InProcessQuotaService implements QuotaService {
  private readonly tenants = new Map<string, number>();
  private readonly users = new Map<string, number>();
  private readonly leases = new Map<string, Set<string>>();

  async acquireRunSlot(tenantId: string, userId: string, limits: { tenant?: number; user?: number; leaseId?: string; leaseMs?: number }): Promise<boolean> {
    if (!tenantId || !userId) throw new Error("tenantId and userId are required");
    const tenantCount = this.tenants.get(tenantId) ?? 0;
    const userKey = `${tenantId}:${userId}`;
    const leaseKey = `${tenantId}:${userId}`;
    const leaseId = limits.leaseId ?? crypto.randomUUID();
    const existing = this.leases.get(leaseKey) ?? new Set<string>();
    if (existing.has(leaseId)) return true;
    const userCount = this.users.get(userKey) ?? 0;
    if (limits.tenant !== undefined && (!Number.isInteger(limits.tenant) || limits.tenant < 1)) throw new Error("tenant run limit must be a positive integer");
    if (limits.user !== undefined && (!Number.isInteger(limits.user) || limits.user < 1)) throw new Error("user run limit must be a positive integer");
    if ((limits.tenant !== undefined && tenantCount >= limits.tenant) || (limits.user !== undefined && userCount >= limits.user)) return false;
    this.tenants.set(tenantId, tenantCount + 1);
    this.users.set(userKey, userCount + 1);
    existing.add(leaseId);
    this.leases.set(leaseKey, existing);
    return true;
  }

  async releaseRunSlot(tenantId: string, userId: string, leaseId?: string): Promise<void> {
    const userKey = `${tenantId}:${userId}`;
    const active = this.leases.get(userKey);
    const selected = leaseId ?? active?.values().next().value;
    if (!active || !selected || !active.delete(selected)) return;
    if (!active.size) this.leases.delete(userKey);
    const tenantCount = this.tenants.get(tenantId) ?? 0;
    const userCount = this.users.get(userKey) ?? 0;
    if (userCount === 0) return;
    if (tenantCount <= 1) this.tenants.delete(tenantId);
    else this.tenants.set(tenantId, tenantCount - 1);
    if (userCount <= 1) this.users.delete(userKey);
    else this.users.set(userKey, userCount - 1);
  }
}
