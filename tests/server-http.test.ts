import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OpenHarnessServer,
  loadServerConfig,
  createHttpServer,
} from "../packages/server/src/index.ts";

test("Step 4 (R2, S5, S6, S7): HTTP server, loadServerConfig guards, auth matrix, admin 403, tenant isolation, PATCH allowlist, and SSE replay exactly once", async () => {
  // 1. Config fail-closed guards
  assert.throws(
    () => loadServerConfig({ OPENHARNESS_HOST: "0.0.0.0" }),
    /Refusing to listen on a non-loopback address/
  );
  assert.throws(
    () => loadServerConfig({ OPENHARNESS_ADMIN_TOKEN: "short-token" }),
    /at least 32 characters/
  );
  assert.throws(
    () => loadServerConfig({ DATABASE_URL: "postgres://localhost/oh" }),
    /postgres adapters are not enabled/
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-server-http-"));
  const adminToken = "a".repeat(48);
  const serverToken = "s".repeat(48);
  const jwtSecret = "oidc-secret-key-for-testing-123456";

  const makeJwt = (claims: Record<string, unknown>) => {
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(
      JSON.stringify({
        iss: "https://auth.openharness.test",
        aud: "openharness-api",
        ...claims,
      })
    ).toString("base64url");
    const sig = crypto.createHmac("sha256", jwtSecret).update(`${h}.${p}`).digest("base64url");
    return `${h}.${p}.${sig}`;
  };

  const app = new OpenHarnessServer({
    host: "127.0.0.1",
    loopback: false,
    dataDir: tmpDir,
    serverToken,
    adminToken,
    oidc: {
      issuer: "https://auth.openharness.test",
      audience: "openharness-api",
      hs256Secret: jwtSecret,
    },
  });
  await app.start();
  const srv = createHttpServer(app);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 2. /health works unauthenticated and includes security headers
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get("x-content-type-options"), "nosniff");
    assert.equal(healthRes.headers.get("x-frame-options"), "DENY");

    // 3. Unauthenticated /v1/* is 401 off-loopback
    const unauthRes = await fetch(`${baseUrl}/v1/sessions`);
    assert.equal(unauthRes.status, 401);

    // 4. Admin routes are 403 without admin token (even when authenticated with serverToken)
    const nonAdminRes = await fetch(`${baseUrl}/v1/admin/secrets`, {
      headers: { authorization: `Bearer ${serverToken}` },
    });
    assert.equal(nonAdminRes.status, 403);

    const adminRes = await fetch(`${baseUrl}/v1/admin/secrets`, {
      headers: {
        authorization: `Bearer ${serverToken}`,
        "x-openharness-admin": adminToken,
      },
    });
    assert.equal(adminRes.status, 200);

    // 5. Tenant isolation: x-tenant-id header has NO effect; OIDC JWT tenant_id isolates sessions
    const jwtTenantA = makeJwt({ sub: "user_a", tenant_id: "tenant_alpha" });
    const jwtTenantB = makeJwt({ sub: "user_b", tenant_id: "tenant_beta" });

    const createARes = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwtTenantA}`,
        "x-tenant-id": "tenant_beta", // spoof attempt must be ignored!
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Alpha Secret Session" }),
    });
    assert.equal(createARes.status, 201);
    const createdSession = (await createARes.json()) as { id: string; title: string };

    // Tenant B cannot see Tenant A's session even if Tenant B sends x-tenant-id: tenant_alpha
    const listBRes = await fetch(`${baseUrl}/v1/sessions`, {
      headers: {
        authorization: `Bearer ${jwtTenantB}`,
        "x-tenant-id": "tenant_alpha",
      },
    });
    assert.equal(listBRes.status, 200);
    const listB = (await listBRes.json()) as Array<{ id: string }>;
    assert.equal(listB.length, 0);

    const getBRes = await fetch(`${baseUrl}/v1/sessions/${createdSession.id}`, {
      headers: {
        authorization: `Bearer ${jwtTenantB}`,
        "x-tenant-id": "tenant_alpha",
      },
    });
    assert.equal(getBRes.status, 404);

    // 6. PATCH mass-assignment protection: ignores unpatchable fields (status, cost, id) & rejects invalid mode/runtime
    const patchRes = await fetch(`${baseUrl}/v1/sessions/${createdSession.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${jwtTenantA}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Renamed Alpha",
        status: "completed",
        cost: 9999,
        id: "hacked_id",
      }),
    });
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as any;
    assert.equal(patched.title, "Renamed Alpha");
    assert.equal(patched.status, "idle");
    assert.equal(patched.cost, 0);
    assert.equal(patched.id, createdSession.id);

    const badModeRes = await fetch(`${baseUrl}/v1/sessions/${createdSession.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${jwtTenantA}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "root_escalation" }),
    });
    assert.equal(badModeRes.status, 400);

    const badRuntimeRes = await fetch(`${baseUrl}/v1/sessions/${createdSession.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${jwtTenantA}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ runtime: "nonexistent_vm" }),
    });
    assert.equal(badRuntimeRes.status, 400);

    // 7. SSE replay and deduplication with Last-Event-ID
    const ev1 = await app.stateStore.appendEvent("tenant_alpha", createdSession.id, {
      type: "run.phase",
      phase: "planning",
    });
    const ev2 = await app.stateStore.appendEvent("tenant_alpha", createdSession.id, {
      type: "run.phase",
      phase: "building",
    });

    const sseCtrl = new AbortController();
    const sseRes = await fetch(
      `${baseUrl}/v1/events?sessionId=${encodeURIComponent(createdSession.id)}`,
      {
        headers: {
          authorization: `Bearer ${jwtTenantA}`,
          "last-event-id": String(ev1.seq),
        },
        signal: sseCtrl.signal,
      }
    );
    assert.equal(sseRes.status, 200);

    // Emit a live event while stream is open
    const ev3 = await app.stateStore.appendEvent("tenant_alpha", createdSession.id, {
      type: "run.phase",
      phase: "completed",
    });
    app.eventBus.publish(ev3);

    const reader = sseRes.body!.pipeThrough(new TextDecoderStream()).getReader();
    let collected = "";
    while (!collected.includes(`"seq":${ev3.seq}`)) {
      const { value, done } = await reader.read();
      if (done) break;
      collected += value;
    }
    sseCtrl.abort();

    const receivedIds = [...collected.matchAll(/^id:\s*(\d+)/gm)].map((m) => Number(m[1]));
    assert.deepEqual(receivedIds, [ev2.seq, ev3.seq], "Reconnect after ev1 must receive ev2 and ev3 exactly once");
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
