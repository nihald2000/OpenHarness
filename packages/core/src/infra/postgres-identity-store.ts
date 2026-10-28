import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Sql } from "postgres";

export interface IdentityRecord {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  externalId: string;
  email?: string;
  role: "member" | "admin";
}

/** OIDC subject provisioning with uniqueness enforced by tenant/external identity. */
export class PostgresIdentityStore {
  private constructor(private readonly sql: Sql, private readonly owned: boolean) {}
  static connect(url: string, options: postgres.Options<{}> = {}) {
    return new PostgresIdentityStore(postgres(url, { max: 10, ...options }), true);
  }
  async close() { if (this.owned) await this.sql.end({ timeout: 5 }); }

  async provision(input: { tenantSlug: string; tenantName?: string; externalId: string; email?: string; initialRole?: "member" | "admin" }): Promise<IdentityRecord> {
    if (!input.tenantSlug || !input.externalId) throw new Error("tenantSlug and externalId are required");
    return this.sql.begin(async (tx) => {
      const tenants = await tx<{ id: string; slug: string }[]>`INSERT INTO tenants (id,slug,name,plan,created_at)
        VALUES (${randomUUID()}::uuid,${input.tenantSlug},${input.tenantName ?? input.tenantSlug},'free',${Date.now()})
        ON CONFLICT (slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id,slug`;
      const tenant = tenants[0]!;
      const users = await tx<{ id: string; role: "member" | "admin"; email: string | null }[]>`INSERT INTO users (id,tenant_id,external_id,email,role,created_at)
        VALUES (${randomUUID()}::uuid,${tenant.id}::uuid,${input.externalId},${input.email ?? null},${input.initialRole ?? "member"},${Date.now()})
        ON CONFLICT (tenant_id,external_id) DO UPDATE SET email=COALESCE(EXCLUDED.email,users.email) RETURNING id,role,email`;
      const user = users[0]!;
      return { tenantId: tenant.id, tenantSlug: tenant.slug, userId: user.id, externalId: input.externalId, email: user.email ?? undefined, role: user.role };
    });
  }

  async find(tenantId: string, externalId: string): Promise<IdentityRecord | undefined> {
    const rows = await this.sql<{ tenant_id: string; slug: string; id: string; external_id: string; email: string | null; role: "member" | "admin" }[]>`SELECT u.tenant_id,t.slug,u.id,u.external_id,u.email,u.role FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.tenant_id=${tenantId}::uuid AND u.external_id=${externalId}`;
    const row = rows[0];
    return row ? { tenantId: row.tenant_id, tenantSlug: row.slug, userId: row.id, externalId: row.external_id, email: row.email ?? undefined, role: row.role } : undefined;
  }
}
