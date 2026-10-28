import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IdentityRecord, PostgresIdentityStore } from "../../core/src/infra/postgres-identity-store.ts";

export type AuthSubject = IdentityRecord & { kind: "oidc" | "service" | "break-glass" };
export type AuthResource = { tenantId: string; ownerId?: string };
export type AuthAction = "read" | "write" | "delete" | "admin";

type OidcConfig = { issuer: string; jwks: ReturnType<typeof createRemoteJWKSet> };
const jwksCache = new Map<string, Promise<OidcConfig>>();

export async function authenticateRequest(
  request: Request,
  options: { identityStore: PostgresIdentityStore; env?: NodeJS.ProcessEnv },
): Promise<AuthSubject | undefined> {
  const env = options.env ?? process.env;
  const token = bearer(request);
  if (!token) return undefined;

  if (safeEqual(token, env.OPENHARNESS_SERVER_TOKEN)) {
    const tenantId = requireUuid(env.OPENHARNESS_SERVICE_TENANT_ID, "OPENHARNESS_SERVICE_TENANT_ID");
    const userId = requireUuid(env.OPENHARNESS_SERVICE_USER_ID ?? "00000000-0000-4000-8000-000000000001", "OPENHARNESS_SERVICE_USER_ID");
    return { tenantId, tenantSlug: tenantId, userId, externalId: "openharness:service", role: "admin", kind: "service" };
  }

  const adminToken = request.headers.get("x-openharness-admin") ?? token;
  if (safeEqual(adminToken, env.OPENHARNESS_ADMIN_TOKEN)) {
    const tenantId = requireUuid(env.OPENHARNESS_SERVICE_TENANT_ID, "OPENHARNESS_SERVICE_TENANT_ID");
    return { tenantId, tenantSlug: tenantId, userId: "00000000-0000-4000-8000-000000000002", externalId: "openharness:break-glass", role: "admin", kind: "break-glass" };
  }

  const issuer = env.OIDC_ISSUER;
  const audience = env.OIDC_AUDIENCE;
  if (!issuer || !audience) return undefined;
  const oidc = await getOidc(issuer);
  const { payload } = await jwtVerify(token, oidc.jwks, { issuer: oidc.issuer, audience, clockTolerance: 5 });
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("OIDC token is missing subject");
  const tenantClaim = env.OIDC_TENANT_CLAIM ?? "tid";
  const tenantSlugValue = payload[tenantClaim];
  if (typeof tenantSlugValue !== "string" || !tenantSlugValue) throw new Error(`OIDC token is missing tenant claim: ${tenantClaim}`);
  const allowList = (env.OIDC_ALLOWED_TENANTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (allowList.length && !allowList.includes(tenantSlugValue)) throw new Error("tenant is not allowed");
  const roleClaim = env.OIDC_ROLE_CLAIM ?? "role";
  const roleValue = payload[roleClaim];
  const roleValues = Array.isArray(roleValue) ? roleValue.map(String) : [String(roleValue ?? "")];
  const adminValues = (env.OIDC_ADMIN_VALUES ?? "admin").split(",").map((value) => value.trim()).filter(Boolean);
  const initialRole = roleValues.some((value) => adminValues.includes(value)) ? "admin" : "member";
  const record = await options.identityStore.provision({
    tenantSlug: tenantSlugValue,
    tenantName: typeof payload["tenant_name"] === "string" ? payload["tenant_name"] : tenantSlugValue,
    externalId: `${oidc.issuer}:${payload.sub}`,
    email: typeof payload.email === "string" ? payload.email : undefined,
    initialRole,
  });
  // Database role is authoritative; the claim may provision a first record but
  // cannot silently elevate an existing member after provisioning.
  return { ...record, role: record.role, kind: "oidc" };
}

export function authorize(subject: AuthSubject, action: AuthAction, resource: AuthResource): boolean {
  if (subject.tenantId !== resource.tenantId) return false;
  if (subject.kind === "service" || subject.kind === "break-glass") return true;
  if (subject.role === "admin") return true;
  if (action === "admin" || !resource.ownerId) return false;
  return subject.userId === resource.ownerId;
}

function bearer(request: Request) {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function safeEqual(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireUuid(value: string | undefined, name: string) {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name} must be a UUID when OIDC is enabled`);
  return value;
}

async function getOidc(issuer: string): Promise<OidcConfig> {
  let cached = jwksCache.get(issuer);
  if (!cached) {
    cached = (async () => {
      const response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`OIDC discovery failed (HTTP ${response.status})`);
      const metadata = await response.json() as { issuer?: string; jwks_uri?: string };
      if (metadata.issuer !== issuer || !metadata.jwks_uri) throw new Error("OIDC discovery metadata has an invalid issuer or missing jwks_uri");
      return { issuer, jwks: createRemoteJWKSet(new URL(metadata.jwks_uri), { timeoutDuration: 10_000, cooldownDuration: 30_000, cacheMaxAge: 600_000 }) };
    })();
    jwksCache.set(issuer, cached);
    cached.catch(() => { if (jwksCache.get(issuer) === cached) jwksCache.delete(issuer); });
  }
  return cached;
}
