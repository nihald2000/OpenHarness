import type { SqlQueryable } from "./postgres-migrations.ts";
import type { OpenHarnessEvent } from "@openharness/sdk";

export class PostgresOutbox {
  private readonly pool: SqlQueryable;

  constructor(opts: { connectionString?: string; pool?: SqlQueryable }) {
    if (!opts.pool && process.env.OPENHARNESS_POSTGRES !== "1") {
      throw new Error("PostgresOutbox requires OPENHARNESS_POSTGRES=1 (fail closed)");
    }
    if (!opts.pool) {
      throw new Error("SqlQueryable pool instance or pg driver required (fail closed)");
    }
    this.pool = opts.pool;
  }

  async enqueue(tenantId: string, sessionId: string, event: OpenHarnessEvent): Promise<number> {
    const { rows } = await this.pool.query(
      "INSERT INTO oh_events (tenant_id, session_id, event_json, created_at) VALUES ($1,$2,$3,$4) RETURNING seq",
      [tenantId, sessionId, JSON.stringify(event), Date.now()]
    );
    return Number(rows[0]?.seq ?? 0);
  }
}
