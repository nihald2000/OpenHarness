import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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
  LayeredContextManager,
  supportsVisionModel,
  toWireMessages,
  InProcessEventBus,
  LocalStateStore,
  ModelAgnosticProviderAdapter,
  createHttpTransport,
  registerSandboxTransport,
  unregisterSandboxTransport,
} from "../packages/core/src/index.ts";
import type { ModalApi, ModalCreateParams, ModalSandboxRef } from "../packages/core/src/sandbox/modal-api.ts";
import { SandboxDaemon } from "../packages/sandboxd/src/server.ts";
import { OpenHarnessServer } from "../packages/server/src/server.ts";
import { createHttpServer } from "../packages/server/src/main.ts";
import { createRunHooks } from "../packages/server/src/run-hooks.ts";
import { RunEventEmitter } from "../packages/server/src/worker/emitter.ts";
import { RunStateMachine } from "../packages/server/src/worker/run-state.ts";
import { DurableRunWorker } from "../packages/server/src/worker/run-worker.ts";

test("Modal E2E fixes: Muse profiles and the tool catalog retain the full harness surface", () => {
  const glimmer = resolveModelProfile("meta-models/Muse-Glimmer-30B");
  assert.equal(glimmer.contextWindow, 131072);
  assert.equal(glimmer.apiKeyEnv, "MUSE_GLIMMER_API_KEY");
  assert.equal(resolveModelProfile("meta-models/Muse-Spark-Open-1026").contextWindow, 256000);
  assert.equal(CONSERVATIVE_DEFAULT_PROFILE.maxTools, 64);
  const router = new StandardToolRouter({ workspaceRoot: process.cwd() });
  const state = createInitialRunState({ runId: "r", sessionId: "s", mode: "task", phase: "building" });
  state.webTools = true;
  state.loadedGroups = ["mcp", "skills"];
  const tools = router.listTools(state);
  const names = new Set(tools.map((tool) => tool.name));
  assert.ok(names.has("ask_user"));
  assert.ok(names.has("skill"));
  assert.ok(names.has("mcp__filesystem__read_multiple_files"));
  assert.ok(names.has("mcp__memory__search_nodes"));
  assert.ok(names.has("mcp__web_fetch__web_search"));
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
  assert.equal(created?.cpu, 0.5);
  assert.equal(created?.cpuLimit, 4);
  assert.equal(created?.memoryMiB, 1024);
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
      if (route === "/processes/p1/wait") return { status: 200, body: { ready: true, status: 200, port: 3000, logsTail: "ready" } };
      if (route === "/ports") return { status: 200, body: { ports: [{ port: 3000, previewUrl: "http://127.0.0.1:3000" }] } };
      if (route === "/processes/p1/logs?since=0") return { status: 200, body: { port: 3000, previewUrl: "http://127.0.0.1:3000", logs: "ready" } };
      return { status: 404, body: {} };
    },
  });
  const router = new StandardToolRouter({ workspaceRoot: workspace, resolvePreviewUrl: () => "https://preview-3000.modal.host" });
  const ctx = { runId: "r", sessionId: "s", tenantId: "t", workspaceRoot: workspace, sandboxHandleId: "modal-preview", state: createInitialRunState({ runId: "r", sessionId: "s", tenantId: "t" }) };
  try {
    const started = await router.executeTool("c1", "process_start", { command: "npm run dev -- --host 0.0.0.0", port: 3000, waitFor: { path: "/", timeoutSec: 30 } }, ctx);
    assert.equal((started.output as any).previewUrl, "https://preview-3000.modal.host");
    assert.equal((started.output as any).internalUrl, "http://127.0.0.1:3000");
    assert.equal((started.output as any).readiness.ready, true);
    const preview = await router.executeTool("c2", "preview_url", { port: 3000 }, ctx);
    assert.equal((preview.output as any).previewUrl, "https://preview-3000.modal.host");
    assert.equal((preview.output as any).internalUrl, "http://127.0.0.1:3000");
    const logs = await router.executeTool("c3", "process_logs", { id: "p1" }, ctx);
    assert.equal((logs.output as any).previewUrl, "https://preview-3000.modal.host");
    assert.equal((logs.output as any).internalUrl, "http://127.0.0.1:3000");
    const defaultPreview = await router.executeTool("c4", "preview_url", {}, ctx);
    assert.equal((defaultPreview.output as any).previewUrl, "https://preview-3000.modal.host");
    assert.equal((defaultPreview.output as any).internalUrl, "http://127.0.0.1:3000");
  } finally {
    unregisterSandboxTransport("modal-preview");
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("full-stack service tool returns session-local connection environment", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oh-service-tool-"));
  let request: { method: string; path: string; body?: Record<string, unknown> } | undefined;
  registerSandboxTransport("service-sandbox", {
    async request(method, path, body) {
      request = { method, path, body: body as Record<string, unknown> | undefined };
      return { status: 200, body: { service: "postgres", ready: true, env: { DATABASE_URL: "postgresql://agent@127.0.0.1:54321/postgres" } } };
    },
  });
  const router = new StandardToolRouter({ workspaceRoot: workspace });
  const state = createInitialRunState({ runId: "service-run", sessionId: "service-session", tenantId: "tenant", mode: "task", phase: "building" });
  const ctx = { runId: state.runId, sessionId: state.sessionId, tenantId: state.tenantId, workspaceRoot: workspace, sandboxHandleId: "service-sandbox", state };
  try {
    assert.ok(router.listTools(state).some((tool) => tool.name === "service_start"));
    const result = await router.executeTool("service-call", "service_start", { service: "postgres" }, ctx);
    assert.deepEqual(request, { method: "POST", path: "/services", body: { service: "postgres" } });
    assert.match(String((result.output as any).env.DATABASE_URL), /^postgresql:\/\//);
  } finally {
    unregisterSandboxTransport("service-sandbox");
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("request_takeover pauses the durable run at a tool boundary and persists the takeover reason", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-browser-takeover-"));
  const server = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, defaultModel: "mock/demo" });
  server.deps.setBrowserOwner = async () => {};
  server.deps.provider.generateTurn = async () => ({ text: "Requesting help with browser login.", toolCalls: [{ id: "takeover-1", name: "request_takeover", arguments: { reason: "Sign in", instructions: "Complete the sign-in flow" } }] });
  try {
    const created = await server.handleRequest("POST", "/v1/sessions", {}, { title: "Browser takeover", mode: "task" });
    const sessionId = (created.body as { id: string }).id;
    const prompt = await server.handleRequest("POST", `/v1/sessions/${sessionId}/prompt`, {}, { text: "Sign in to the app", mode: "task", async: true });
    const runId = (prompt.body as { runId: string }).runId;
    for (let i = 0; i < 150; i++) {
      const run = await server.runWorker.getRun(runId);
      if (run?.status === "awaiting_input" || run?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const run = await server.runWorker.getRun(runId);
    assert.equal(run?.status, "awaiting_input", JSON.stringify(run?.diagnostic));
    assert.equal(run?.pauseReason, "takeover");
    const checkpoint = await server.stateStore.getStepCheckpoint("default", runId);
    assert.equal(checkpoint?.state.takeoverRequested, true);
    assert.equal(checkpoint?.state.takeover?.reason, "Sign in");
  } finally {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("paused-budget runs enter browser takeover immediately and restore their previous pause reason", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-paused-takeover-"));
  const server = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, defaultModel: "mock/demo" });
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  registerSandboxTransport("takeover-sandbox", {
    async request(method, route, body) {
      calls.push({ method, path: route, body });
      if (route === "/browser/lock") return { status: 200, body: { owner: (body as any)?.owner } };
      if (route === "/browser/observe") return { status: 200, body: { url: "http://127.0.0.1:3000/", title: "App", text: "Welcome alice", snapshot: "- document [title=App]", screenshotJpegBase64: null } };
      return { status: 200, body: {} };
    },
  });
  try {
    const created = await server.handleRequest("POST", "/v1/sessions", {}, { title: "Paused takeover", mode: "task" });
    const sessionId = (created.body as { id: string }).id;
    const session = await server.stateStore.getSession("default", sessionId);
    assert.ok(session);
    await server.stateStore.saveSession("default", { ...session!, sandboxHandleId: "takeover-sandbox", status: "awaiting_input", pauseReason: "paused_budget" });
    const now = Date.now();
    const { run } = await server.runStateMachine.createRun({ runId: "run_paused_takeover", sessionId, tenantId: "default", prompt: "continue", model: "mock/demo", mode: "task" });
    await server.runStateMachine.transition(run.id, "queued", "running", { phase: "paused" });
    await server.runStateMachine.transition(run.id, "running", "awaiting_input", { phase: "paused", pauseReason: "paused_budget" });
    const state = createInitialRunState({ runId: run.id, sessionId, tenantId: "default", model: "mock/demo", mode: "task", phase: "paused" });
    state.pauseReason = "paused_budget";
    await server.stateStore.saveStepCheckpoint({ runId: run.id, sessionId, tenantId: "default", stepIndex: 0, state, transcriptCursor: 0, usage: state.usage, cost: 0, pendingApproval: null, sandboxHandleId: "takeover-sandbox", lastCheckpointSha: null, inFlightToolCalls: [], completedToolCallIds: [], savedAt: now });

    const takeover = await server.handleRequest("POST", `/v1/runs/${run.id}/takeover`, {}, { reason: "Continue login" });
    assert.equal(takeover.status, 200);
    assert.equal((takeover.body as any).control, "requested");
    assert.equal((await server.runWorker.getRun(run.id))?.pauseReason, "takeover");
    assert.equal((await server.stateStore.getStepCheckpoint("default", run.id))?.state.takeoverPreviousPauseReason, "paused_budget");
    assert.ok(calls.some((call) => call.path === "/browser/lock" && (call.body as any)?.owner === "human"));

    const returned = await server.handleRequest("POST", `/v1/runs/${run.id}/takeover/return`, {}, { note: "Signed in" });
    assert.equal(returned.status, 200);
    assert.equal((await server.runWorker.getRun(run.id))?.status, "awaiting_input");
    assert.equal((await server.runWorker.getRun(run.id))?.pauseReason, "paused_budget");
    const checkpoint = await server.stateStore.getStepCheckpoint("default", run.id);
    assert.equal(checkpoint?.state.pauseReason, "paused_budget");
    assert.match((server as any).takeoverResumeMessages.get(run.id).parts[0].text, /Welcome alice/);
    assert.ok(calls.some((call) => call.path === "/browser/lock" && (call.body as any)?.owner === "agent"));
  } finally {
    unregisterSandboxTransport("takeover-sandbox");
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Modal E2E fixes: delayed sandbox startup and streaming tool-call activity complete without first-activity timeout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-modal-activity-"));
  const server = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, defaultModel: "gpt-4o", defaultRuntime: "modal" });
  let requestCount = 0;
  const providerServer = http.createServer((_req, res) => {
    requestCount++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (requestCount === 1) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-ping", type: "function", function: { name: "ping", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const providerPort = (providerServer.address() as { port: number }).port;
  const stateStore = server.stateStore;
  const eventBus = new InProcessEventBus();
  const stateMachine = new RunStateMachine({ dataDir: root, stateStore });
  const emitter = new RunEventEmitter({ stateStore, eventBus });
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot);
  const tool = {
    name: "ping", description: "Return a small success result.", parameters: { type: "object", properties: {} },
    readOnly: true, idempotent: true, execute: async () => ({ output: { ok: true } }),
  } as any;
  server.deps.toolRouter = {
    listTools: () => [tool], getTool: (name: string) => name === "ping" ? tool : undefined,
    executeTool: async () => ({ output: { ok: true } }),
  } as any;
  server.deps.contextManager = new LayeredContextManager({ workspaceRoot });
  server.deps.workspaceRoot = workspaceRoot;
  server.deps.provider = new ModelAgnosticProviderAdapter({
    transport: createHttpTransport(async () => ({ baseUrl: `http://127.0.0.1:${providerPort}/v1` })),
    maxRetryAttempts: 1,
  });
  server.deps.ensureSandbox = async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { id: "modal-delayed", workspacePath: "/workspace" };
  };
  server.deps.onRunVerification = async () => ({ passed: true, signature: "ok", condensedError: "", results: [] });
  await stateStore.saveSession("default", {
    id: "sess-delayed", title: "Delayed sandbox", model: "gpt-4o", agent: "assistant", runtime: "modal", status: "idle", updatedAt: Date.now(),
  });
  const worker = new DurableRunWorker({ stateMachine, emitter, deps: server.deps, activeSandboxes: new Map() });
  try {
    const { run } = await worker.enqueueAndStart({ sessionId: "sess-delayed", prompt: "Run ping", model: "gpt-4o", runtime: "modal", mode: "task" });
    await worker.startRun(run.id);
    const completed = stateMachine.getRun(run.id);
    assert.equal(completed?.status, "completed", JSON.stringify(completed?.diagnostic));
    assert.ok(completed?.firstActivityAt, "sandbox creation and streamed tool-call activity must mark first activity");
    assert.equal(requestCount, 2, "the streamed tool call should be followed by a final model turn");
  } finally {
    await new Promise<void>((resolve) => providerServer.close(() => resolve()));
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Modal E2E fixes: Modal sandbox creation does not publish preallocated preview tunnels", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-modal-preview-ready-"));
  const stateStore = new LocalStateStore({ dataDir: root });
  await stateStore.saveSession("tenant", { id: "sess", title: "Modal", model: "gpt-4o", agent: "assistant", runtime: "modal", status: "idle", updatedAt: Date.now() });
  const handle = { id: "modal-handle", providerId: "modal", status: "running", ports: { 3000: "https://preview-3000.modal.host", 8000: "https://preview-8000.modal.host" }, policy: {} } as any;
  const provider = { id: "modal", async health() { return { ok: true }; }, async create() { return handle; } } as any;
  const activeSandboxes = new Map();
  const emitted: any[] = [];
  const hooks = createRunHooks({
    providers: new Map([["modal", provider]]) as any, activeSandboxes, sandboxRecords: new InMemorySandboxRecordStore(),
    stateStore, eventBus: new InProcessEventBus(), provider: {} as any, workspaceRoot: root,
    emit: async (_tenant, _session, event) => { emitted.push(event); },
    defaultSpecFor: (state) => ({ runId: state.runId, sessionId: state.sessionId, tenantId: state.tenantId, workspace: { type: "empty" } as any, policy: compileSandboxPolicy({ runId: state.runId, phase: "agent", networkMode: "allowlist" }) }),
  });
  const state = createInitialRunState({ runId: "run", sessionId: "sess", tenantId: "tenant", runtime: "modal" });
  try {
    await hooks.ensureSandbox(state);
    assert.ok(!state.previewUrl);
    assert.equal(emitted.some((event) => event.type === "preview.ready"), false);
  } finally {
    (stateStore as any).close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Modal E2E fixes: SSE endpoint flushes its Vercel preamble immediately", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-modal-sse-flush-"));
  const server = new OpenHarnessServer({ dataDir: root, serverToken: "s".repeat(48), defaultModel: "mock/demo" });
  const app = createHttpServer(server);
  await server.start();
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = (app.address() as { port: number }).port;
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/events`, {
      headers: { authorization: `Bearer ${"s".repeat(48)}` }, signal: controller.signal,
    });
    assert.equal(response.headers.get("x-vercel-cache"), "MISS");
    const first = await response.body!.getReader().read();
    const chunk = new TextDecoder().decode(first.value);
    assert.match(chunk, /^: open /);
    assert.ok((first.value?.byteLength ?? 0) >= 2_000);
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
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
