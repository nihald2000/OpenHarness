import postgres from "postgres";
import type { Sql } from "postgres";

export interface UsageSnapshot { inputTokens: number; outputTokens: number; costUsd: number; budgetExceeded: boolean }

/** Batched per-step tenant usage accounting and monthly budget check. */
export class PostgresUsageStore {
  private constructor(private readonly sql: Sql, private readonly owned: boolean) {}
  static connect(url: string, options: postgres.Options<{}> = {}) { return new PostgresUsageStore(postgres(url, { max: 10, ...options }), true); }
  async close() { if (this.owned) await this.sql.end({ timeout: 5 }); }

  async recordStep(input: { tenantId: string; period: string; inputTokens: number; outputTokens: number; costUsd: number; monthlyBudgetUsd?: number }): Promise<UsageSnapshot> {
    if (!/^\d{4}-\d{2}$/.test(input.period)) throw new Error("period must be YYYY-MM");
    for (const [name, value] of [["inputTokens", input.inputTokens], ["outputTokens", input.outputTokens], ["costUsd", input.costUsd]] as const) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
    }
    const rows = await this.sql<{ input_tokens: string; output_tokens: string; cost_usd: string }[]>`INSERT INTO tenant_usage (tenant_id,period,input_tokens,output_tokens,cost_usd)
      VALUES (${input.tenantId}::uuid,${input.period},${Math.trunc(input.inputTokens)},${Math.trunc(input.outputTokens)},${input.costUsd})
      ON CONFLICT (tenant_id,period) DO UPDATE SET input_tokens=tenant_usage.input_tokens+EXCLUDED.input_tokens,output_tokens=tenant_usage.output_tokens+EXCLUDED.output_tokens,cost_usd=tenant_usage.cost_usd+EXCLUDED.cost_usd
      RETURNING input_tokens,output_tokens,cost_usd`;
    const row = rows[0]!;
    const costUsd = Number(row.cost_usd);
    return { inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), costUsd, budgetExceeded: input.monthlyBudgetUsd !== undefined && costUsd > input.monthlyBudgetUsd };
  }

  async get(tenantId: string, period: string): Promise<UsageSnapshot> {
    const rows = await this.sql<{ input_tokens: string; output_tokens: string; cost_usd: string }[]>`SELECT input_tokens,output_tokens,cost_usd FROM tenant_usage WHERE tenant_id=${tenantId}::uuid AND period=${period}`;
    const row = rows[0];
    return row ? { inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), costUsd: Number(row.cost_usd), budgetExceeded: false } : { inputTokens: 0, outputTokens: 0, costUsd: 0, budgetExceeded: false };
  }
}
