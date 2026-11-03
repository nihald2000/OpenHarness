import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenHarnessServer } from "../packages/server/src/server.ts";
import { LocalStateStore } from "../packages/core/src/infra/state-store.ts";
import { PostgresStateStore } from "../packages/core/src/infra/postgres-state-store.ts";
import type { SqlQueryable } from "../packages/core/src/infra/postgres-migrations.ts";

test("Postgres tenant settings queries enforce tenant scope in the adapter", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool: SqlQueryable = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
  const store = new PostgresStateStore({ connectionString: "postgres://localhost/oh", pool, postgresEnabled: true });
  await store.getTenantSetting("tenant-a", "providers.v1");
  await store.setTenantSetting("tenant-a", "providers.v1", [{ encryptedApiKey: "ciphertext" }]);
  await store.deleteTenantSetting("tenant-a", "providers.v1");
  assert.equal(queries.length, 3);
  for (const query of queries) {
    assert.ok(query.sql.includes("tenant_id = $1") || query.sql.includes("tenant_id, setting_key"));
    assert.equal(query.params[0], "tenant-a");
  }
});

test("guest provider credentials are encrypted, write-only, and isolated by guest tenant", async () => {
  const envKeys = ["OPENHARNESS_WEB_GUEST", "OPENHARNESS_WEB_GUEST_SECRET", "OPENHARNESS_SECRET_KEY", "OH_SKIP_DNS_SSRF_CHECK"] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.OPENHARNESS_WEB_GUEST = "1";
  process.env.OPENHARNESS_WEB_GUEST_SECRET = "guest-cookie-signing-key-for-tests";
  process.env.OPENHARNESS_SECRET_KEY = "dedicated-encryption-key-for-tests";
  process.env.OH_SKIP_DNS_SSRF_CHECK = "1";

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-guest-provider-"));
  const app = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, loopback: false, isolateSessions: true });

  try {
    const guestIdentity = async () => {
      const response = await app.createWebGuestSession({});
      assert.equal(response.status, 200);
      const identity = await app.authenticate({ cookie: response.headers?.["set-cookie"]?.split(";")[0] });
      assert.ok(identity);
      return identity;
    };
    const identityA = await guestIdentity();
    const identityB = await guestIdentity();
    const url = (pathname: string) => new URL(pathname, "http://openharness.test");
    const save = await app.handleAuthenticatedRequest(identityA, "PUT", url("/v1/user/providers/personal"), {}, {
        name: "Personal endpoint",
        baseUrl: "https://8.8.8.8/v1",
        apiKey: "secret-guest-key",
        models: [{ id: "my-model", name: "My Model", contextWindow: 64_000 }],
    });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    const saved = save.body as any;
    assert.equal(saved.hasApiKey, true);
    assert.equal("apiKey" in saved, false);
    assert.equal(JSON.stringify(saved).includes("secret-guest-key"), false);

    const listA = await app.handleAuthenticatedRequest(identityA, "GET", url("/v1/user/providers"));
    const listB = await app.handleAuthenticatedRequest(identityB, "GET", url("/v1/user/providers"));
    assert.equal(listA.status, 200);
    assert.equal(listB.status, 200);
    assert.equal((listA.body as any[]).length, 1);
    assert.deepEqual(listB.body, []);

    const stored = await app.stateStore.getTenantSetting(identityA.tenantId, "providers.v1");
    assert.ok(JSON.stringify(stored).includes("v1."));
    assert.equal(JSON.stringify(stored).includes("secret-guest-key"), false);
    const reloaded = new LocalStateStore({ dataDir: root });
    assert.deepEqual(await reloaded.getTenantSetting(identityA.tenantId, "providers.v1"), stored);
    assert.equal(await reloaded.getTenantSetting(identityB.tenantId, "providers.v1"), null);
  } finally {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
