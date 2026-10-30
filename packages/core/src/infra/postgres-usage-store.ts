import type { SqlQueryable } from "./postgres-migrations.ts";

export interface TenantUsageRecord {
  tenantId: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class PostgresUsageStore {
  private readonly pool: SqlQueryable;

  constructor(opts: { connectionString?: string; pool?: SqlQueryable }) {
    if (!opts.pool && process.env.OPENHARNESS_POSTGRES !== "1") {
      throw new Error("PostgresUsageStore requires OPENHARNESS_POSTGRES=1 (fail closed)");
    }
    if (!opts.pool) {
      throw new Error("SqlQueryable pool instance or pg driver required (fail closed)");
    }
    this.pool = opts.pool;
  }

  async recordUsage(rec: TenantUsageRecord): Promise<void> {
    await this.pool.query(
      "INSERT INTO oh_usage (tenant_id, session_id, input_tokens, output_tokens, cost_usd, recorded_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [rec.tenantId, rec.sessionId, rec.inputTokens, rec.outputTokens, rec.costUsd, Date.now()]
    );
  }
}
