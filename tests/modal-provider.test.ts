import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  ModalSandboxProvider,
  InMemorySandboxRecordStore,
  HttpDaemonTransport,
  needsRollover,
  reapOrphans,
  accumulateSandboxCost,
  compileSandboxPolicy,
} from "../packages/core/src/sandbox/index.ts";
import type {
  ModalApi,
  ModalCreateParams,
  ModalSandboxRef,
} from "../packages/core/src/sandbox/modal-api.ts";

test("Step 7 (R4, S9, F6): ModalSandboxProvider lifecycle (create -> health -> exec -> pause -> resume same handle -> rollover -> destroy), orphan reaper, encrypted sessionKey, and edge 401 token re-minting", async () => {
  // Start a mock HTTP daemon endpoint that simulates Modal edge + oh-sandboxd
  let edgeRejectFirstToken = true;
  let mintedCount = 0;

  const daemonServer = http.createServer(async (req, res) => {
    const auth = req.headers.authorization ?? "";
    if (edgeRejectFirstToken && auth === "Bearer modal-tok-1") {
      edgeRejectFirstToken = false;
      // Modal edge 401 (no x-oh-daemon header) -> triggers token re-mint!
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "expired connect token" }));
      return;
    }

    res.setHeader("x-oh-daemon", "1");
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, osEnforced: true, status: "running" }));
      return;
    }
    if (req.url === "/processes/stop-all") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ stopped: true }));
      return;
    }
    if (req.url === "/checkpoints/create") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sha: "abc1234567890def", message: "checkpoint" }));
      return;
    }
    if (req.url === "/shell/main/exec") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ exitCode: 0, output: "modal-ok", status: "completed" }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => daemonServer.listen(0, "127.0.0.1", resolve));
  const daemonPort = (daemonServer.address() as { port: number }).port;
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;

  const createdSandboxes = new Map<string, { params: ModalCreateParams; terminated: boolean }>();
  let sbSeq = 0;
  let snapSeq = 0;

  const makeRef = (id: string, params: ModalCreateParams): ModalSandboxRef => ({
    id,
    async poll() {
      return createdSandboxes.get(id)?.terminated ? 0 : null;
    },
    async exec(_cmd) {
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    async writeBytes() {},
    async readBytes() {
      return new Uint8Array();
    },
    async connectToken(_port, _meta) {
      mintedCount++;
      return { url: daemonUrl, token: `modal-tok-${mintedCount}` };
    },
    async tunnels() {
      return {
        8080: "https://internal-daemon.modal.host",
        3000: "https://preview-3000.modal.host",
      };
    },
    async snapshotFilesystem() {
      return `im-snap-${++snapSeq}`;
    },
    async terminate() {
      const entry = createdSandboxes.get(id);
      if (entry) entry.terminated = true;
    },
  });

  const fakeApi: ModalApi = {
    async create(p) {
      const id = `sb-modal-${++sbSeq}`;
      createdSandboxes.set(id, { params: p, terminated: false });
      return makeRef(id, p);
    },
    async fromId(id) {
      const entry = createdSandboxes.get(id);
      if (!entry) throw new Error(`unknown sandbox ${id}`);
      return makeRef(id, entry.params);
    },
    async *list(_tags) {
      for (const [id, entry] of createdSandboxes.entries()) {
        if (!entry.terminated) {
          yield makeRef(id, entry.params);
        }
      }
    },
  };

  try {
    const records = new InMemorySandboxRecordStore();
    const provider = new ModalSandboxProvider(
      fakeApi,
      {
        baseImageId: "im-base-ubuntu24",
        cpu: 2,
        memoryMiB: 4096,
        timeoutMs: 3_600_000,
        bootTimeoutMs: 10_000,
        setupTimeoutMs: 60_000,
        snapshotTtlMs: 86_400_000,
        envCacheTtlMs: 86_400_000,
        encryptedPorts: [3000, 5173],
        inboundCidrAllowlist: [],
        encrypt: (s) => `ENC:${Buffer.from(s, "utf8").toString("base64")}`,
        decrypt: (s) => Buffer.from(s.replace(/^ENC:/, ""), "base64").toString("utf8"),
      },
      records
    );

    const policy = compileSandboxPolicy({
      runId: "run_modal_1",
      phase: "agent",
      networkMode: "allowlist",
      additionalAllowedDomains: ["api.github.com"],
    });

    // 1. Create sandbox (runs setup sandbox -> snapshots -> boots agent sandbox; re-mints on edge 401)
    const handle = await provider.create({
      runId: "run_modal_1",
      sessionId: "sess_modal_1",
      providerId: "modal",
      workspace: { type: "empty" },
      setupCommands: ["npm install"],
      policy,
    });

    assert.ok(handle.id.startsWith("modal-"));
    assert.equal(handle.sessionKey, "", "SandboxHandle must never expose plaintext sessionKey");
    assert.equal(handle.ports[8080], undefined, "Daemon port 8080 tunnel URL must never be exposed");
    assert.equal(handle.ports[3000], "https://preview-3000.modal.host");
    assert.ok(mintedCount >= 2, "Edge 401 must trigger connect token re-mint");

    const rec = await records.get(handle.id);
    assert.ok(rec);
    assert.ok(rec!.sessionKeyEnc.startsWith("ENC:"), "Session key in record store must be encrypted");

    // 2. Health and exec via attached transport
    const health = await provider.health(handle);
    assert.equal(health.ok, true);
    assert.equal(health.osEnforced, true);

    const { transport } = await provider.attach(handle.id);
    const execRes = await transport.request("POST", "/shell/main/exec", { command: "pwd" });
    assert.equal(execRes.status, 200);
    assert.equal(execRes.body.output, "modal-ok");

    // 3. Pause -> snapshot -> terminate, then Resume keeping the SAME handle ID
    const originalHandleId = handle.id;
    await provider.pause(handle);
    const pausedRec = await records.get(originalHandleId);
    assert.equal(pausedRec?.status, "snapshotted");
    assert.ok(pausedRec?.lastSnapshotImageId?.startsWith("im-snap-"));

    await provider.resume(handle);
    assert.equal(handle.id, originalHandleId, "Resume must preserve the exact same handle ID");
    assert.equal(handle.status, "running");

    // 4. Rollover & cost calculation
    const activeRec = (await records.get(originalHandleId))!;
    assert.equal(needsRollover(activeRec, 30 * 60_000, activeRec.createdAt + 10_000), false);
    assert.equal(
      needsRollover(activeRec, 30 * 60_000, activeRec.createdAt + activeRec.timeoutMs - 60_000),
      true
    );
    const cost = accumulateSandboxCost(activeRec, activeRec.billedUntil + 100_000);
    assert.ok(cost.usd > 0);

    // 5. Orphan reaper kills unowned sandboxes
    await fakeApi.create({
      imageId: "im-base",
      command: ["sleep", "infinity"],
      env: {},
      workdir: "/workspace",
      cpu: 1,
      memoryMiB: 1024,
      timeoutMs: 60_000,
      runtime: "vm",
      encryptedPorts: [],
      tags: { oh: "1" },
    });
    const reaped = await reapOrphans(fakeApi, records, async (runId) => runId === "run_modal_1");
    assert.ok(reaped.length >= 1, "Orphan sandbox must be terminated by reaper");

    // 6. Destroy
    await provider.destroy(handle);
    assert.equal((await records.get(originalHandleId))?.status, "terminated");
  } finally {
    await new Promise<void>((resolve) => daemonServer.close(() => resolve()));
  }
});
