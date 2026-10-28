import { describe, expect, test } from "bun:test";
import { authorize, type AuthSubject } from "../src/oidc-auth.ts";

const member: AuthSubject = {
  kind: "oidc", tenantId: "tenant-a", tenantSlug: "a", userId: "user-1", externalId: "issuer:sub-1", role: "member",
};

describe("OIDC subject authorization", () => {
  test("allows an owner to access their resource in the same tenant", () => {
    expect(authorize(member, "read", { tenantId: "tenant-a", ownerId: "user-1" })).toBe(true);
    expect(authorize(member, "write", { tenantId: "tenant-a", ownerId: "user-1" })).toBe(true);
  });

  test("denies other owners, cross-tenant resources, and ownerless tenant resources", () => {
    expect(authorize(member, "read", { tenantId: "tenant-a", ownerId: "user-2" })).toBe(false);
    expect(authorize(member, "read", { tenantId: "tenant-b", ownerId: "user-1" })).toBe(false);
    expect(authorize(member, "read", { tenantId: "tenant-a" })).toBe(false);
    expect(authorize(member, "admin", { tenantId: "tenant-a", ownerId: "user-1" })).toBe(false);
  });

  test("tenant admins stay within their tenant and service principals cannot cross tenants", () => {
    const admin = { ...member, role: "admin" as const };
    expect(authorize(admin, "admin", { tenantId: "tenant-a" })).toBe(true);
    expect(authorize(admin, "admin", { tenantId: "tenant-b" })).toBe(false);
    const service = { ...member, kind: "service" as const };
    expect(authorize(service, "write", { tenantId: "tenant-a" })).toBe(true);
    expect(authorize(service, "write", { tenantId: "tenant-b" })).toBe(false);
  });
});
