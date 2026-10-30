import type { SqlQueryable } from "./postgres-migrations.ts";

export interface StoredIdentity {
  tenantId: string;
  userId: string;
  email?: string;
  admin: boolean;
}

export class PostgresIdentityStore {
  private readonly pool: SqlQueryable;

  constructor(opts: { connectionString?: string; pool?: SqlQueryable }) {
    if (!opts.pool && process.env.OPENHARNESS_POSTGRES !== "1") {
      throw new Error("PostgresIdentityStore requires OPENHARNESS_POSTGRES=1 (fail closed)");
    }
    if (!opts.pool) {
      throw new Error("SqlQueryable pool instance or pg driver required (fail closed)");
    }
    this.pool = opts.pool;
  }

  async upsert(identity: StoredIdentity): Promise<void> {
    await this.pool.query(
      "INSERT INTO oh_identities (tenant_id, user_id, email, is_admin, updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, user_id) DO UPDATE SET email = EXCLUDED.email, is_admin = EXCLUDED.is_admin, updated_at = EXCLUDED.updated_at",
      [identity.tenantId, identity.userId, identity.email ?? null, identity.admin, Date.now()]
    );
  }
}
