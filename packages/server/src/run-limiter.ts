export type LimitResult = { ok: true } | { ok: false; status: 429; error: string };

function positiveLimit(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export class RunLimiter {
  private readonly active = new Map<string, Set<string>>();
  private readonly daily = new Map<string, { day: string; count: number }>();
  private readonly globalActive: number;
  private readonly perTenantActive: number;
  private readonly perTenantDaily: number;

  constructor(
    globalActive = Number(process.env.OH_MAX_ACTIVE_RUNS ?? 3),
    perTenantActive = Number(process.env.OH_GUEST_MAX_ACTIVE_RUNS ?? 1),
    perTenantDaily = Number(process.env.OH_GUEST_MAX_RUNS_PER_DAY ?? 20),
  ) {
    this.globalActive = positiveLimit(globalActive, 3);
    this.perTenantActive = positiveLimit(perTenantActive, 1);
    this.perTenantDaily = positiveLimit(perTenantDaily, 20);
  }

  tryAcquire(tenantId: string, runId: string, admin: boolean): LimitResult {
    const total = [...this.active.values()].reduce((count, runs) => count + runs.size, 0);
    if (total >= this.globalActive) {
      return { ok: false, status: 429, error: "Server is busy (too many active runs). Try again in a minute." };
    }
    if (!admin) {
      if ((this.active.get(tenantId)?.size ?? 0) >= this.perTenantActive) {
        return { ok: false, status: 429, error: "You already have a run in progress. Wait for it to finish or cancel it." };
      }
      const day = new Date().toISOString().slice(0, 10);
      const current = this.daily.get(tenantId);
      const count = current?.day === day ? current.count : 0;
      if (count >= this.perTenantDaily) {
        return { ok: false, status: 429, error: "Daily run limit reached for this browser." };
      }
      this.daily.set(tenantId, { day, count: count + 1 });
    }
    let runs = this.active.get(tenantId);
    if (!runs) this.active.set(tenantId, (runs = new Set()));
    runs.add(runId);
    return { ok: true };
  }

  release(tenantId: string, runId: string): void {
    const runs = this.active.get(tenantId);
    runs?.delete(runId);
    if (runs?.size === 0) this.active.delete(tenantId);
  }

  transfer(tenantId: string, fromRunId: string, toRunId: string): void {
    const runs = this.active.get(tenantId);
    if (!runs?.delete(fromRunId)) return;
    runs.add(toRunId);
  }
}
