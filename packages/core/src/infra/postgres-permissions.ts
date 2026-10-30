import type { SqlQueryable } from "./postgres-migrations.ts";
import type { PermissionReply, PermissionRequest } from "@openharness/sdk";

export class PostgresPermissionStore {
  private readonly pool: SqlQueryable;

  constructor(opts: { connectionString?: string; pool?: SqlQueryable }) {
    if (!opts.pool && process.env.OPENHARNESS_POSTGRES !== "1") {
      throw new Error("PostgresPermissionStore requires OPENHARNESS_POSTGRES=1 (fail closed)");
    }
    if (!opts.pool) {
      throw new Error("SqlQueryable pool instance or pg driver required (fail closed)");
    }
    this.pool = opts.pool;
  }

  async save(tenantId: string, req: PermissionRequest): Promise<void> {
    await this.pool.query(
      "INSERT INTO oh_permissions (tenant_id, id, session_id, data) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, id) DO UPDATE SET data = EXCLUDED.data",
      [tenantId, req.id, req.sessionId, JSON.stringify(req)]
    );
  }

  async resolve(tenantId: string, requestId: string, _reply: PermissionReply): Promise<PermissionRequest | null> {
    const { rows } = await this.pool.query(
      "DELETE FROM oh_permissions WHERE tenant_id = $1 AND id = $2 RETURNING data",
      [tenantId, requestId]
    );
    return rows[0] ? (rows[0].data as PermissionRequest) : null;
  }
}
