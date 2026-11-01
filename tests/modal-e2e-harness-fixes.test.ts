import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONSERVATIVE_DEFAULT_PROFILE,
  ModalSandboxProvider,
  ModalSdkApi,
  InMemorySandboxRecordStore,
  compileSandboxPolicy,
  createInitialRunState,
  resolveModelProfile,
  StandardToolRouter,
  supportsVisionModel,
  toWireMessages,
  registerSandboxTransport,
  unregisterSandboxTransport,
} from "../packages/core/src/index.ts";
import type { ModalApi, ModalCreateParams, ModalSandboxRef } from "../packages/core/src/sandbox/modal-api.ts";
import { SandboxDaemon } from "../packages/sandboxd/src/server.ts";
import { OpenHarnessServer } from "../packages/server/src/server.ts";

test("Modal E2E fixes: Muse profiles and the tool catalog retain the full harness surface", () => {
  const glimmer = resolveModelProfile("meta-models/Muse-Glimmer-30B");
  assert.equal(glimmer.contextWindow, 131072);
  assert.equal(glimmer.apiKeyEnv, "MUSE_GLIMMER_API_KEY");
  assert.equal(resolveModelProfile("meta-models/Muse-Spark-Open-1026").contextWindow, 256000);
  assert.equal(CONSERVATIVE_DEFAULT_PROFILE.maxTools, 64);
  const router = new StandardToolRouter({ workspaceRoot: process.cwd() });
  const tools = router.listTools(createInitialRunState({ runId: "r", sessionId: "s", phase: "building" }));
  assert.ok(tools.length > 38, `expected full catalog, got ${tools.length}`);
  assert.ok(tools.some((tool) => tool.name === "ask_user"));
  assert.ok(tools.some((tool) => tool.name === "skill"));
  assert.ok(tools.some((tool) => tool.name.startsWith("mcp__")));
});

test("Modal E2E fixes: vision wire attaches screenshot PNGs without base64 tool-result bloat", () => {
  assert.equal(supportsVisionModel("muse-glimmer"), true);
  const screenshot = "A".repeat(256);
  const wire = toWireMessages([{
    info: { id: "assistant-1", role: "assistant" },
    createdAt: Date.now(),
    parts: [{ type: "tool", tool: "browser_screenshot", callId: "c1", state: "completed", output: {
      url: "http://127.0.0.1:3000", title: "Preview", mimeType: "image/png", dataBase64: screenshot,
    } }],
  }], resolveModelProfile("muse-glimmer"));
  const tool = wire.find((message) => message.role === "tool")!;
  assert.equal(String(tool.content).includes(screenshot), false);
  assert.match(String(tool.content), /screenshotAttached/);
  const visual = wire.find((message) => message.role === "user" && Array.isArray(message.content))!;
  assert.ok((visual.content as Array<Record<string, any>>).some((part) => part.type === "image_url" && part.image_url.url.endsWith(screenshot)));
});

test("Modal E2E fixes: empty allowlists retain setup domains and preview tunnels exclude daemon port", async () => {
  let captured: ModalCreateParams | undefined;
  const ref = (id: string): ModalSandboxRef => ({
    id, async poll() { return null; }, async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async writeBytes() {}, async readBytes() { return new Uint8Array(); },
    async connectToken() { return { url: "http://localhost", token: "t" }; },
    async tunnels() { return { 8080: "https://daemon.example", 3000: "https://preview-3000.modal.host" }; },
    async snapshotFilesystem() { return "snapshot"; }, async terminate() {},
  });
  const api: ModalApi = {
    async create(params) { captured = params; return ref("sb1"); },
    async fromId(id) { return ref(id); }, async *list() {},
  };
  const records = new InMemorySandboxRecordStore();
  const provider = new ModalSandboxProvider(api, {
    baseImageId: "image", bootTimeoutMs: 100, encrypt: (value) => value, decrypt: (value) => value,
    transportFactory: () => ({ async request() { return { status: 200, body: { ok: true } }; } }),
  }, records);
  const policy = compileSandboxPolicy({ runId: "run1", phase: "agent", networkMode: "allowlist", additionalAllowedDomains: [] });
  const handle = await provider.create({ runId: "run1", sessionId: "session1", workspace: { kind: "empty" } as any, policy });
  assert.ok((captured?.outboundDomainAllowlist?.length ?? 0) > 0);
  assert.equal(handle.ports[8080], undefined);
  assert.equal(await provider.resolveTunnelUrl(handle.id, 3000), "https://preview-3000.modal.host");
  assert.equal(await provider.resolveTunnelUrl(handle.id, 8080), undefined);
  await provider.destroy(handle);
});

test("Modal E2E fixes: SDK connect token uses one object argument and Modal provider has Starter burst defaults", async () => {
  let tokenArgs: unknown[] = [];
  const fakeSandbox = {
    sandboxId: "modal-sdk-sandbox",
    async poll() { return null; }, async terminate() {},
    createConnectToken(...args: unknown[]) { tokenArgs = args; return { url: "https://connect.modal.host", token: "token" }; },
    async tunnels() { return {}; }, async snapshotFilesystem() { return { imageId: "snapshot" }; },
    async exec() { return { wait: async () => 0, stdout: { readText: async () => "" }, stderr: { readText: async () => "" } }; },
    filesystem: { async writeBytes() {}, async readBytes() { return new Uint8Array(); } },
  };
  const sdk = new ModalSdkApi({ appName: "test" }) as any;
  sdk.client = {
    apps: { fromName: async () => ({}) },
    images: { fromId: async () => ({}) },
    sandboxes: { create: async () => fakeSandbox },
  };
  const ref = await sdk.create({
    imageId: "image", command: ["sleep", "infinity"], env: {}, workdir: "/workspace",
    cpu: 0.25, memoryMiB: 512, timeoutMs: 60_000, runtime: "gvisor", encryptedPorts: [], tags: {},
  });
  await ref.connectToken(8080, { tenant: "t", session: "s" });
  assert.equal(tokenArgs.length, 1);
  assert.deepEqual(tokenArgs[0], { port: 8080, userMetadata: JSON.stringify({ tenant: "t", session: "s" }) });

  let created: ModalCreateParams | undefined;
  const modalRef: ModalSandboxRef = {
    id: "default-modal", async poll() { return null; }, async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async writeBytes() {}, async readBytes() { return new Uint8Array(); }, async connectToken() { return { url: "", token: "" }; },
    async tunnels() { return {}; }, async snapshotFilesystem() { return "snapshot"; }, async terminate() {},
  };
  const api: ModalApi = {
    async create(params) { created = params; return modalRef; }, async fromId() { return modalRef; }, async *list() {},
  };
  const provider = new ModalSandboxProvider(api, {
    baseImageId: "image", inboundCidrAllowlist: [], encrypt: (s) => s, decrypt: (s) => s,
    transportFactory: () => ({ async request() { return { status: 200, body: { ok: true } }; } }),
  }, new InMemorySandboxRecordStore());
  const policy = compileSandboxPolicy({ runId: "default", phase: "agent", networkMode: "allowlist", additionalAllowedDomains: ["example.com"] });
  const handle = await provider.create({ runId: "default", sessionId: "s", workspace: { kind: "empty" } as any, policy });
  assert.equal(created?.cpu, 0.25);
  assert.equal(created?.cpuLimit, 4);
  assert.equal(created?.memoryMiB, 512);
  assert.equal(created?.memoryLimitMiB, 8192);
  assert.equal(created?.idleTimeoutMs, 300_000);
  assert.equal(created?.runtime, "gvisor");
  assert.equal(created?.inboundCidrAllowlist, undefined);
  await provider.destroy(handle);
});

test("Modal E2E fixes: process_start and preview_url return tunnel and in-sandbox URLs", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oh-modal-preview-"));
  registerSandboxTransport("modal-preview", {
    async request(_method, route) {
      if (route === "/processes") return { status: 200, body: { id: "p1", port: 3000, previewUrl: "http://127.0.0.1:3000" } };
      if (route === "/ports") return { status: 200, body: { ports: [{ port: 3000, previewUrl: "http://127.0.0.1:3000" }] } };
      return { status: 404, body: {} };
    },
  });
  const router = new StandardToolRouter({ workspaceRoot: workspace, resolvePreviewUrl: () => "https://preview-3000.modal.host" });
  const ctx = { runId: "r", sessionId: "s", tenantId: "t", workspaceRoot: workspace, sandboxHandleId: "modal-preview", state: createInitialRunState({ runId: "r", sessionId: "s", tenantId: "t" }) };
  try {
    const started = await router.executeTool("c1", "process_start", { command: "npm run dev", port: 3000 }, ctx);
    assert.equal((started.output as any).previewUrl, "https://preview-3000.modal.host");
    assert.equal((started.output as any).internalUrl, "http://127.0.0.1:3000");
    const preview = await router.executeTool("c2", "preview_url", { port: 3000 }, ctx);
    assert.equal((preview.output as any).previewUrl, "https://preview-3000.modal.host");
    assert.equal((preview.output as any).internalUrl, "http://127.0.0.1:3000");
  } finally {
    unregisterSandboxTransport("modal-preview");
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Modal E2E fixes: fresh shadow git diffs include one-commit untracked files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-modal-diff-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const daemon = new SandboxDaemon({
    sessionId: "session", runId: "run", sessionKey: "key", workspacePath: workspace,
    memoriesPath: path.join(root, "memories"), tmpPath: path.join(root, "tmp"), shadowGitDir: path.join(root, "git"),
    policy: compileSandboxPolicy({ runId: "run", phase: "agent", workspacePath: workspace, networkMode: "none" }),
  });
  try {
    fs.writeFileSync(path.join(workspace, "server.js"), "console.log('hello');\n");
    const result = await daemon.handleRequest("POST", "/checkpoints/diff", { "x-session-key": "key" }, {});
    assert.equal(result.status, 200);
    assert.deepEqual((result.body as any).files, ["server.js"]);
    assert.match((result.body as any).diff, /console\.log/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Modal E2E fixes: hosted sessions hide the host workspace and get tenant/session roots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-modal-isolation-"));
  fs.writeFileSync(path.join(root, "package.json"), "host repository marker");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "host instructions marker");
  const server = new OpenHarnessServer({ dataDir: path.join(root, "data"), workspaceRoot: root, loopback: false, isolateSessions: true, defaultModel: "mock/demo" });
  try {
    const isolatedDataDir = path.join(root, "data");
    assert.equal(server.deps.workspaceRoot, path.resolve(isolatedDataDir, "workspaces", "_empty"));
    assert.notEqual(server.deps.workspaceRoot, process.cwd());
    const getRoot = (server as any).getSessionWorkspaceRoot.bind(server);
    const a = getRoot("tenant-a", "session-a");
    const b = getRoot("tenant-b", "session-a");
    assert.notEqual(a, b);
    assert.equal(fs.existsSync(path.join(a, "package.json")), false);
    const identity = { tenantId: "tenant-a", userId: "user", admin: false } as any;
    const info = await server.handleAuthenticatedRequest(identity, "GET", new URL("http://localhost/v1/info"), {}, undefined);
    assert.equal((info.body as any).workspace, "/workspace");
    const created = await server.handleAuthenticatedRequest(identity, "POST", new URL("http://localhost/v1/sessions"), {}, { title: "isolated" });
    const sessionId = (created.body as any).id as string;
    const files = await server.handleAuthenticatedRequest(identity, "GET", new URL(`http://localhost/v1/sessions/${sessionId}/files`), {}, undefined);
    assert.deepEqual((files.body as any).files, []);
    assert.equal((files.body as any).files.includes("package.json"), false);
    assert.equal((files.body as any).files.includes("AGENTS.md"), false);
    const state = createInitialRunState({ runId: "r", sessionId, tenantId: "tenant-a", phase: "building" });
    const ctx = { runId: "r", sessionId, tenantId: "tenant-a", workspaceRoot: a, state };
    const read = await server.deps.toolRouter.getTool("read_file")!.execute({ path: "package.json" }, ctx);
    assert.ok(read.error);
    const tree = await server.deps.toolRouter.getTool("mcp__filesystem__directory_tree")!.execute({ path: "." }, ctx);
    assert.equal(JSON.stringify(tree.output).includes("package.json"), false);
    assert.equal(JSON.stringify(tree.output).includes("AGENTS.md"), false);
    const shell = await server.handleAuthenticatedRequest(identity, "POST", new URL("http://localhost/v1/sandboxes/missing/shell"), {}, { command: "pwd" });
    assert.equal(shell.status, 404);
    assert.deepEqual(shell.body, { error: "Sandbox is no longer running" });
  } finally {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Modal E2E fixes: v2 permission approval transitions to awaiting_permission and resumes the run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-modal-permission-"));
  const server = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, defaultModel: "mock/demo" });
  let turns = 0;
  server.deps.provider.generateTurn = async () => {
    turns++;
    return turns === 1
      ? { text: "I will create the file.", toolCalls: [{ id: "write-once", name: "write_file", arguments: { path: "approval.txt", content: "approved", _risk: "high" } }] }
      : { text: "The file is ready.", toolCalls: [] };
  };
  try {
    const created = await server.handleRequest("POST", "/v1/sessions", {}, { title: "Permission test" });
    const sessionId = (created.body as { id: string }).id;
    const prompt = await server.handleRequest("POST", `/v1/sessions/${sessionId}/prompt`, {}, { text: "Write a file", mode: "chat", async: true });
    const runId = (prompt.body as { runId: string }).runId;
    for (let i = 0; i < 100; i++) {
      const run = await server.runWorker.getRun(runId);
      if (run?.status === "awaiting_permission" || run?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const waiting = await server.runWorker.getRun(runId);
    assert.equal(waiting?.status, "awaiting_permission", JSON.stringify(waiting?.diagnostic));
    const checkpoint = await server.stateStore.getStepCheckpoint("default", runId);
    const requestId = checkpoint?.state.pendingApproval?.id;
    assert.ok(requestId);
    const reply = await server.handleRequest("POST", `/v1/permissions/${requestId}/reply`, {}, { reply: "once" });
    assert.equal(reply.status, 200);
    for (let i = 0; i < 150; i++) {
      const run = await server.runWorker.getRun(runId);
      if (run?.status === "completed" || run?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal((await server.runWorker.getRun(runId))?.status, "completed");
    assert.equal(fs.readFileSync(path.join(root, "approval.txt"), "utf8"), "approved");
  } finally {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Modal E2E fixes: Modal boot failure is reported without changing the runtime to local", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-modal-no-downgrade-"));
  const server = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, defaultModel: "mock/demo", defaultRuntime: "modal" });
  let localCreateCalls = 0;
  server.providers.set("modal", { id: "modal", capabilities: {} as any, async health() { return { ok: true } as any; }, async create() { throw new Error("Modal sandbox failed to become healthy: boot timeout"); } } as any);
  const local = server.providers.get("local")!;
  const originalCreate = local.create.bind(local);
  local.create = async (...args: any[]) => { localCreateCalls++; return originalCreate(args[0]); };
  try {
    const created = await server.handleRequest("POST", "/v1/sessions", {}, { title: "Modal failure" });
    const sessionId = (created.body as { id: string }).id;
    const prompt = await server.handleRequest("POST", `/v1/sessions/${sessionId}/prompt`, {}, { text: "Run in Modal", mode: "task", async: true });
    const runId = (prompt.body as { runId: string }).runId;
    for (let i = 0; i < 100; i++) {
      const run = await server.runWorker.getRun(runId);
      if (run?.status === "failed" || run?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const run = await server.runWorker.getRun(runId);
    assert.equal(run?.status, "failed");
    assert.equal(run?.diagnostic?.code, "SANDBOX_BOOT_FAILED");
    assert.equal(localCreateCalls, 0);
    assert.equal((await server.stateStore.getSession("default", sessionId))?.runtime, "modal");
  } finally {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
