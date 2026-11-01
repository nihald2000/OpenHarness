import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FallbackSandboxTransport,
  InMemorySandboxRecordStore,
  LocalStateStore,
  ModalSandboxProvider,
  ModalSdkApi,
  compileSandboxPolicy,
  createInitialRunState,
} from "../packages/core/src/index.ts";
import type { ModalApi, ModalCreateParams, ModalSandboxRef } from "../packages/core/src/sandbox/modal-api.ts";
import type { SandboxTransport } from "../packages/core/src/sandbox/transport.ts";
import { SandboxDaemon } from "../packages/sandboxd/src/server.ts";
import { createRunHooks } from "../packages/server/src/run-hooks.ts";

const waitForListen = (server: http.Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const serverPort = (server: http.Server) => (server.address() as { port: number }).port;

function setVmIsolation(value: string | undefined): () => void {
  const old = process.env.OH_VM_ISOLATED;
  if (value === undefined) delete process.env.OH_VM_ISOLATED;
  else process.env.OH_VM_ISOLATED = value;
  return () => {
    if (old === undefined) delete process.env.OH_VM_ISOLATED;
    else process.env.OH_VM_ISOLATED = old;
  };
}

function makeDaemon(root: string, sessionKey = "session-key"): SandboxDaemon {
  const policy = compileSandboxPolicy({ runId: "run-connectivity", phase: "agent", workspacePath: path.join(root, "workspace"), networkMode: "allowlist" });
  return new SandboxDaemon({
    sessionId: "session-connectivity", runId: "run-connectivity", sessionKey,
    workspacePath: path.join(root, "workspace"), memoriesPath: path.join(root, "memories"),
    tmpPath: path.join(root, "tmp"), shadowGitDir: path.join(root, "shadow-git"),
    policy, requireSrt: true, srtProbe: () => false,
  });
}

function makeExecRef(daemon: SandboxDaemon, id = "sandbox-connectivity"): ModalSandboxRef {
  return {
    id,
    async poll() { return null; },
    async waitUntilReady() {},
    async readStartupLogs() { return { stdout: "", stderr: "" }; },
    async exec(argv) {
      const [method, route, _port, key, requestId, bodyB64] = argv.slice(4);
      daemon.config.sessionKey = key!;
      const body = bodyB64 ? JSON.parse(Buffer.from(bodyB64, "base64").toString("utf8")) : undefined;
      const response = await daemon.handleRequest(method!, route!, { "x-session-key": key, "x-oh-request-id": requestId }, body);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ status: response.status, daemon: "1", text: JSON.stringify(response.body) }),
        stderr: "",
      };
    },
    async writeBytes() {}, async readBytes() { return new Uint8Array(); },
    async connectToken() { return { url: "http://127.0.0.1:1", token: "connect-token" }; },
    async tunnels() { return { 8080: "http://127.0.0.1:2", 3000: "https://preview-3000.modal.host" }; },
    async snapshotFilesystem() { return "snapshot-image"; }, async terminate() {},
  };
}

function makeProvider(api: ModalApi, records = new InMemorySandboxRecordStore(), transportFactory?: (ref: ModalSandboxRef, key: string, rec: any) => SandboxTransport): ModalSandboxProvider {
  return new ModalSandboxProvider(api, {
    baseImageId: "im-test", bootTimeoutMs: 1_000, encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, ""),
    transportFactory,
  }, records);
}

function makeApi(ref: ModalSandboxRef, onCreate?: (params: ModalCreateParams) => void): ModalApi {
  return {
    async create(params) { onCreate?.(params); return ref; },
    async fromId() { return ref; },
    async *list() {},
  };
}

test("Modal connectivity: three-tier failover reaches the daemon through authenticated Modal exec", async () => {
  const restore = setVmIsolation("1");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-modal-three-tier-"));
  const daemon = makeDaemon(root);
  const badConnect = http.createServer((_req, res) => { res.writeHead(502).end("proxy cold route"); });
  const badTunnel = http.createServer((_req, res) => { res.writeHead(504).end("tunnel cold route"); });
  await Promise.all([waitForListen(badConnect), waitForListen(badTunnel)]);
  const ref = makeExecRef(daemon);
  ref.connectToken = async () => ({ url: `http://127.0.0.1:${serverPort(badConnect)}`, token: "jwt" });
  ref.tunnels = async () => ({ 8080: `http://127.0.0.1:${serverPort(badTunnel)}`, 3000: "https://preview-3000.modal.host" });
  let createParams: ModalCreateParams | undefined;
  const provider = makeProvider(makeApi(ref, (params) => { createParams = params; }));
  try {
    const handle = await provider.create({
      runId: "run-connectivity", sessionId: "session-connectivity", tenantId: "tenant-connectivity",
      workspace: { kind: "empty" } as any,
      policy: compileSandboxPolicy({ runId: "run-connectivity", phase: "agent", workspacePath: "/workspace", networkMode: "allowlist" }),
    });
    assert.equal(createParams?.readinessPort, 8080);
    const response = await handle.transport!.request("POST", "/files/create", { path: "hello.txt", content: "modal exec works" });
    assert.equal(response.status, 200);
    assert.equal((await handle.transport!.request("POST", "/shell/main/exec", { command: "echo sandbox_ok", timeoutSec: 10 })).status, 200);
    assert.equal((handle.transport as FallbackSandboxTransport).activeChannel, "exec-loopback");
    assert.equal(fs.readFileSync(path.join(root, "workspace", "hello.txt"), "utf8"), "modal exec works");
    await provider.destroy(handle);
  } finally {
    await Promise.all([new Promise<void>((r) => badConnect.close(() => r())), new Promise<void>((r) => badTunnel.close(() => r()))]);
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
    restore();
  }
});

test("Modal connectivity: tunnel failover is promoted and reused after a broken connect token", async () => {
  let connectHits = 0;
  let tunnelHits = 0;
  const ref: ModalSandboxRef = {
    id: "sandbox-tunnel-failover", async poll() { return null; }, async waitUntilReady() {},
    async readStartupLogs() { return { stdout: "", stderr: "" }; },
    async exec() { throw new Error("exec channel unavailable in this fixture"); },
    async writeBytes() {}, async readBytes() { return new Uint8Array(); },
    async connectToken() { return { url: "https://connect-token.invalid", token: "jwt" }; },
    async tunnels() { return { 3000: "https://preview.modal.host" }; },
    async snapshotFilesystem() { return "snapshot"; }, async terminate() {},
  };
  const provider = makeProvider(makeApi(ref), new InMemorySandboxRecordStore(), () => new FallbackSandboxTransport([
    { name: "connect-token", transport: { async request() { connectHits++; return { status: 502, body: {} }; } } },
    { name: "encrypted-tunnel", transport: { async request() { tunnelHits++; return { status: 200, body: { ok: true, osEnforced: true }, daemon: true }; } } },
  ]));
  try {
    const handle = await provider.create({
      runId: "run-tunnel", sessionId: "session-tunnel", tenantId: "tenant-tunnel", workspace: { kind: "empty" } as any,
      policy: compileSandboxPolicy({ runId: "run-tunnel", phase: "agent", workspacePath: "/workspace", networkMode: "allowlist" }),
    });
    assert.equal((handle.transport as FallbackSandboxTransport).activeChannel, "encrypted-tunnel");
    assert.equal((await handle.transport!.request("GET", "/health")).status, 200);
    assert.equal(connectHits, 1, "broken connect-token channel should only be tried once");
    assert.equal(tunnelHits, 2, "healthy tunnel should be reused without re-hitting connect-token channel");
    await provider.destroy(handle);
  } finally {
    // The fake transports and sandbox ref hold no external resources.
  }
});

test("Modal connectivity: early sandbox exit includes startup stderr without waiting for health timeout", async () => {
  const ref: ModalSandboxRef = {
    id: "sandbox-crashed", async poll() { return 1; }, async waitUntilReady() {},
    async readStartupLogs() { return { stdout: "", stderr: "SyntaxError: broken bundle" }; },
    async exec() { return { exitCode: 1, stdout: "", stderr: "SyntaxError: broken bundle" }; },
    async writeBytes() {}, async readBytes() { return new Uint8Array(); }, async connectToken() { return { url: "", token: "" }; },
    async tunnels() { return {}; }, async snapshotFilesystem() { return "snapshot"; }, async terminate() {},
  };
  const provider = makeProvider(makeApi(ref));
  const start = Date.now();
  await assert.rejects(provider.create({
    runId: "run-crash", sessionId: "session-crash", workspace: { kind: "empty" } as any,
    policy: compileSandboxPolicy({ runId: "run-crash", phase: "agent", workspacePath: "/workspace", networkMode: "allowlist" }),
  }), /SyntaxError: broken bundle/);
  assert.ok(Date.now() - start < 2_000, "crash should be detected immediately rather than polling /health");
});

test("Modal connectivity: VM-isolated daemon reports enforcement and executes shell where POSIX shell is available", async () => {
  const restore = setVmIsolation("1");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-modal-vm-isolated-"));
  const daemon = makeDaemon(root);
  try {
    await daemon.listen(0, "127.0.0.1");
    const health = await daemon.handleRequest("GET", "/health", {});
    assert.equal(health.body.osEnforced, true);
    if (process.platform === "win32") return;
    const result = await daemon.handleRequest("POST", "/shell/main/exec", { "x-session-key": "session-key" }, { command: "echo hello", timeoutSec: 10 });
    assert.equal(result.status, 200);
    assert.equal(result.body.exitCode, 0);
    assert.match(String(result.body.output), /hello/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
    restore();
  }
});

test("Modal connectivity: ensureSandbox reattaches a live Modal handle from durable records after scale-to-zero", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-modal-reattach-"));
  const stateStore = new LocalStateStore({ dataDir: root });
  const sessionKeyEnc = "encrypted-session-key";
  const statePolicy = compileSandboxPolicy({ runId: "run-restart", phase: "agent", workspacePath: "/workspace", networkMode: "allowlist" });
  await stateStore.saveSession("tenant-restart", {
    id: "session-restart", title: "Restart", model: "gpt-4o", agent: "assistant", runtime: "modal",
    status: "running", sandboxHandleId: "modal-persisted", updatedAt: Date.now(),
  });
  const records = new InMemorySandboxRecordStore();
  await records.save({
    handleId: "modal-persisted", providerId: "modal", tenantId: "tenant-restart", sessionId: "session-restart", runId: "run-restart",
    status: "running", modalSandboxId: "sdk-sandbox-1", sessionKeyEnc, cpu: 0.5, memoryMiB: 1024, createdAt: Date.now(),
    timeoutMs: 60_000, billedUntil: Date.now(), ports: { 3000: "https://preview.modal.host" }, policy: statePolicy,
  });
  const attachedTransport = { async request() { return { status: 200, body: { ok: true } }; } };
  let createCalls = 0;
  const modalProvider = {
    id: "modal", capabilities: { osEnforced: true },
    async attach(id: string) { assert.equal(id, "modal-persisted"); return { ref: {}, transport: attachedTransport }; },
    async create() { createCalls++; throw new Error("should reuse live handle"); },
    async health() { return { ok: true }; }, async resume() {}, async pause() {}, async snapshot() { throw new Error("unused"); }, async restore() { throw new Error("unused"); }, async destroy() {},
  } as any;
  const activeSandboxes = new Map();
  const hooks = createRunHooks({
    providers: new Map([["modal", modalProvider]]) as any, activeSandboxes, sandboxRecords: records,
    stateStore, eventBus: { subscribe() { return () => {}; }, publish() {} } as any, provider: {} as any, workspaceRoot: root,
    emit: async () => {}, defaultSpecFor: () => { throw new Error("should not create a replacement"); },
  });
  try {
    const state = createInitialRunState({ runId: "run-restart", sessionId: "session-restart", tenantId: "tenant-restart", runtime: "modal" });
    state.sandboxHandleId = null;
    const handle = await hooks.ensureSandbox(state);
    assert.equal(handle.id, "modal-persisted");
    assert.equal(handle.status, "running");
    assert.equal(handle.transport, attachedTransport);
    assert.equal(activeSandboxes.get(handle.id), handle);
    assert.equal(createCalls, 0);
  } finally {
    (stateStore as any).close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Modal SDK: create attaches a native TCP readiness probe and exposes startup logs", async () => {
  const fakeSandbox = {
    sandboxId: "sdk-readiness", async poll() { return null; }, async terminate() {},
    async waitUntilReady() {}, stdout: { async readText() { return "stdout"; } }, stderr: { async readText() { return "stderr"; } },
    createConnectToken() { return { url: "", token: "" }; }, async tunnels() { return {}; }, async snapshotFilesystem() { return { imageId: "snapshot" }; },
    async exec() { return { wait: async () => 0, stdout: { readText: async () => "" }, stderr: { readText: async () => "" } }; },
    filesystem: { async writeBytes() {}, async readBytes() { return new Uint8Array(); } },
  };
  const sdk = new ModalSdkApi({ appName: "test" }) as any;
  let params: any;
  sdk.client = {
    apps: { fromName: async () => ({}) }, images: { fromId: async () => ({}) },
    sandboxes: { create: async (_app: unknown, _image: unknown, p: unknown) => { params = p; return fakeSandbox; } },
  };
  const ref = await sdk.create({
    imageId: "image", command: ["sleep", "infinity"], env: {}, workdir: "/workspace", cpu: 0.5,
    memoryMiB: 1024, timeoutMs: 60_000, runtime: "gvisor", encryptedPorts: [8080], tags: {}, readinessPort: 8080,
  });
  assert.ok(params.readinessProbe);
  assert.equal(params.readinessPort, undefined);
  await ref.waitUntilReady?.(2_000);
  assert.deepEqual(await ref.readStartupLogs?.(), { stdout: "stdout", stderr: "stderr" });
});
