import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileSandboxPolicy,
  createInitialRunState,
  InProcessEventBus,
  LocalStateStore,
  enforceToolOutputLimit,
  evaluateNetworkAccess,
  LayeredContextManager,
  registerSandboxTransport,
  StandardToolRouter,
  runStep,
  unregisterSandboxTransport,
} from "../packages/core/src/index.ts";
import { getAllowedToolsForSubagent, normalizeSubagentRole } from "../packages/server/src/subagents.ts";
import { RunLimiter } from "../packages/server/src/run-limiter.ts";
import { OpenHarnessServer } from "../packages/server/src/server.ts";
import type { EngineDeps } from "../packages/core/src/agent/deps.ts";

function tempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("tool bundles expose the small chat surface and load optional web, MCP, and skill groups", async () => {
  const root = tempDir("oh-tool-bundles-");
  const router = new StandardToolRouter({ workspaceRoot: root, dataDir: root });
  const state = createInitialRunState({ runId: "bundle-run", sessionId: "bundle-session", mode: "chat", phase: "building" });
  const chatNames = router.listTools(state).map((tool) => tool.name);
  assert.deepEqual(chatNames.sort(), ["ask_user", "glob", "list", "read_file", "search"].sort());

  state.mode = "task";
  state.initialPrompt = "Fix this Python function";
  let names = router.listTools(state).map((tool) => tool.name);
  assert.ok(names.includes("load_tools"));
  assert.ok(!names.includes("browser_navigate"));
  assert.ok(!names.includes("skill"));

  const ctx = { runId: state.runId, sessionId: state.sessionId, tenantId: state.tenantId, workspaceRoot: root, state };
  await router.executeTool("load-web", "load_tools", { group: "web" }, ctx);
  await router.executeTool("load-mcp", "load_tools", { group: "mcp" }, ctx);
  await router.executeTool("load-skills", "load_tools", { group: "skills" }, ctx);
  names = router.listTools(state).map((tool) => tool.name);
  assert.ok(names.includes("browser_navigate"));
  assert.ok(names.some((name) => name.startsWith("mcp__")));
  assert.ok(names.includes("skill"));
  assert.deepEqual(state.loadedGroups?.sort(), ["mcp", "skills"]);

  state.loadedGroups = [];
  state.webTools = false;
  state.initialPrompt = "Build a React dashboard";
  assert.ok(router.listTools(state).some((tool) => tool.name === "browser_navigate"), "web intent enables the web bundle automatically");
  fs.rmSync(root, { recursive: true, force: true });
});

test("tool output caps and proactive pruning retain only the latest browser/log outputs and three bash results", () => {
  const root = tempDir("oh-output-prune-");
  const bounded = enforceToolOutputLimit(`${"H".repeat(15_000)}${"T".repeat(15_000)}`, "large", root, { maxChars: 12_000 });
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.output.includes("H".repeat(100)));
  assert.ok(bounded.output.includes("T".repeat(100)));
  assert.ok(bounded.spillPath && fs.existsSync(path.join(root, bounded.spillPath)));

  const manager = new LayeredContextManager({ workspaceRoot: root });
  const makeTool = (tool: string, callId: string, output: unknown) => ({
    info: { id: `m-${callId}`, role: "assistant" as const },
    createdAt: Date.now(),
    parts: [{ type: "tool" as const, tool, callId, state: "completed" as const, input: {}, output }],
  });
  const pruned = manager.clearOldToolResults([
    makeTool("browser_screenshot", "shot-old", { mimeType: "image/png", dataBase64: "x".repeat(250) }),
    makeTool("browser_screenshot", "shot-new", { mimeType: "image/png", dataBase64: "y".repeat(250) }),
    makeTool("process_logs", "logs-old", { logs: "first\nsecond" }),
    makeTool("process_logs", "logs-new", { logs: "latest" }),
    makeTool("bash", "bash-1", "old"),
    makeTool("bash", "bash-2", "two"),
    makeTool("bash", "bash-3", "three"),
    makeTool("bash", "bash-4", "newest"),
  ], root);
  const output = (id: string) => pruned.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.callId === id);
  const oldShot = output("shot-old");
  const latestShot = output("shot-new");
  assert.ok(oldShot?.type === "tool" && typeof oldShot.output === "string" && oldShot.output.startsWith("[cleared browser_screenshot:"));
  assert.ok(latestShot?.type === "tool" && typeof latestShot.output === "object");
  const bash1 = output("bash-1");
  const bash2 = output("bash-2");
  const bash4 = output("bash-4");
  assert.ok(bash1?.type === "tool" && typeof bash1.output === "string");
  assert.ok(bash2?.type === "tool" && bash2.output === "two");
  assert.ok(bash4?.type === "tool" && bash4.output === "newest");
  fs.rmSync(root, { recursive: true, force: true });
});

test("workspace outline is included initially and after file changes, then omitted on unchanged turns", () => {
  const root = tempDir("oh-outline-");
  fs.writeFileSync(path.join(root, "index.ts"), "export {};");
  const manager = new LayeredContextManager({ workspaceRoot: root });
  const state = createInitialRunState({ runId: "outline", sessionId: "outline", mode: "task" });
  assert.match(manager.buildStableSystemPrompt(state), /## Workspace Outline/);
  state.iteration = 1;
  assert.doesNotMatch(manager.buildStableSystemPrompt(state), /## Workspace Outline/);
  state.workspaceOutlinePending = true;
  assert.match(manager.buildStableSystemPrompt(state), /## Workspace Outline/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("input-token budget asks for a tool-free summary then pauses with a resumable budget marker", async () => {
  const root = tempDir("oh-input-budget-");
  const store = new LocalStateStore({ dataDir: root });
  const bus = new InProcessEventBus();
  await store.saveSession("default", { id: "budget-session", title: "Budget", agent: "assistant", status: "running", updatedAt: Date.now() });
  let toolCount = -1;
  const deps = {
    clock: { now: () => Date.now(), sleep: async () => {} },
    stateStore: store,
    eventBus: bus,
    workspaceRoot: root,
    provider: { generateTurn: async (request: { tools: unknown[] }) => {
      toolCount = request.tools.length;
      return { text: "Completed X. Next do Y.", toolCalls: [], usage: { input: 7, output: 4 } };
    } },
    toolRouter: { listTools: () => [], getTool: () => undefined, executeTool: async () => ({ output: null }) },
    policyGate: { evaluateToolCall: async () => ({ action: "allow", risk: "low" }), recordPermissionReply: async () => {} },
    contextManager: { prepareTurnContext: async (_state: unknown, messages: unknown[]) => ({ systemPrompt: "sys", messages, estimatedTokens: 5, events: [] }), handleContextOverflow: async (_state: unknown, messages: unknown[]) => messages },
  } as unknown as EngineDeps;
  const oldBudget = process.env.OH_MAX_INPUT_TOKENS_PER_RUN;
  process.env.OH_MAX_INPUT_TOKENS_PER_RUN = "5";
  try {
    const state = createInitialRunState({ runId: "budget-run", sessionId: "budget-session", mode: "task", phase: "building" });
    state.inputTokensThisRun = 5;
    const result = await runStep(state, deps);
    assert.equal(toolCount, 0);
    assert.equal(result.state.phase, "paused");
    assert.equal(result.state.pauseReason, "paused_budget");
    assert.ok(result.state.modelCalls === 1);
  } finally {
    if (oldBudget === undefined) delete process.env.OH_MAX_INPUT_TOKENS_PER_RUN;
    else process.env.OH_MAX_INPUT_TOKENS_PER_RUN = oldBudget;
    await store.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("subagent roles use real tool names, general has shared build tools, and unknown roles are rejected", () => {
  const root = tempDir("oh-subagent-roles-");
  const router = new StandardToolRouter({ workspaceRoot: root });
  const state = createInitialRunState({ runId: "roles", sessionId: "roles", mode: "task", phase: "building" });
  state.webTools = true;
  const tools = router.listTools(state);
  const tester = getAllowedToolsForSubagent("tester", tools).map((tool) => tool.name);
  assert.ok(tester.includes("process_start"));
  assert.ok(tester.includes("process_logs"));
  assert.ok(tester.includes("process_stop"));
  assert.ok(tester.includes("browser_navigate"));
  assert.ok(!tester.includes("process"));
  assert.ok(!tester.includes("browser_open"));
  const general = getAllowedToolsForSubagent("worker", tools).map((tool) => tool.name);
  assert.ok(general.includes("write_file"));
  assert.ok(general.includes("bash"));
  assert.ok(!general.includes("delegate"));
  assert.ok(!general.includes("ask_user"));
  assert.equal(normalizeSubagentRole("coder"), "general");
  assert.throws(() => normalizeSubagentRole("bogus"), /explore, tester, reviewer, general/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("isolated sandbox loopback allows dev ports but keeps hub and metadata blocked", () => {
  const policy = compileSandboxPolicy({ runId: "loopback", workspacePath: os.tmpdir(), networkMode: "open" });
  const old = process.env.OH_VM_ISOLATED;
  process.env.OH_VM_ISOLATED = "1";
  try {
    assert.equal(evaluateNetworkAccess(policy, "http://127.0.0.1:3000").allowed, true);
    assert.equal(evaluateNetworkAccess(policy, "http://localhost:5173").allowed, true);
    assert.equal(evaluateNetworkAccess(policy, "http://127.0.0.1:8080").allowed, false);
    assert.equal(evaluateNetworkAccess(policy, "http://169.254.169.254").allowed, false);
    assert.equal(evaluateNetworkAccess(policy, "http://192.168.1.10:3000").allowed, false);
  } finally {
    if (old === undefined) delete process.env.OH_VM_ISOLATED;
    else process.env.OH_VM_ISOLATED = old;
  }
});

test("ask_user releases its active run slot and resumes can reacquire without consuming a second daily run", () => {
  const limiter = new RunLimiter(2, 1, 3);
  assert.deepEqual(limiter.tryAcquire("tenant", "waiting", false), { ok: true });
  limiter.release("tenant", "waiting");
  assert.deepEqual(limiter.tryAcquire("tenant", "another-chat", false), { ok: true });
  limiter.release("tenant", "another-chat");
  assert.deepEqual(limiter.tryAcquire("tenant", "waiting", false, false), { ok: true });
});

test("process_logs always returns a useful string error instead of Error undefined", async () => {
  const root = tempDir("oh-process-logs-");
  registerSandboxTransport("logs-missing", { async request() { return { status: 404, body: {} }; } });
  const router = new StandardToolRouter({ workspaceRoot: root });
  const state = createInitialRunState({ runId: "logs", sessionId: "logs", mode: "task" });
  const result = await router.executeTool("logs-call", "process_logs", { id: "missing" }, {
    runId: state.runId, sessionId: state.sessionId, tenantId: state.tenantId,
    workspaceRoot: root, sandboxHandleId: "logs-missing", state,
  });
  assert.match(result.error ?? "", /process_logs failed with HTTP 404/);
  assert.doesNotMatch(result.error ?? "", /undefined/);
  unregisterSandboxTransport("logs-missing");
  fs.rmSync(root, { recursive: true, force: true });
});

test("foreign or missing sessions do not expose the messages route", async () => {
  const root = tempDir("oh-message-404-");
  const app = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, defaultModel: "mock/demo" });
  try {
    const response = await app.handleAuthenticatedRequest(
      { tenantId: "tenant-a", userId: "user-a", admin: false },
      "GET",
      new URL("http://localhost/v1/sessions/private-session/messages"),
    );
    assert.equal(response.status, 404);
  } finally {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("first user prompt assigns a short session title and publishes the updated session", async () => {
  const root = tempDir("oh-auto-title-");
  const app = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, defaultModel: "mock/demo", defaultRuntime: "local" });
  const events: unknown[] = [];
  app.eventBus.subscribe({ tenantId: "title-tenant" }, (event) => events.push(event.event));
  const identity = { tenantId: "title-tenant", userId: "title-user", admin: false };
  try {
    const created = await app.handleAuthenticatedRequest(identity, "POST", new URL("http://localhost/v1/sessions"), {}, { title: "New chat", model: "mock/demo", runtime: "local", mode: "task" });
    assert.equal(created.status, 201);
    const sessionId = (created.body as { id: string }).id;
    const prompted = await app.handleAuthenticatedRequest(identity, "POST", new URL(`http://localhost/v1/sessions/${sessionId}/prompt`), {}, { text: "Build a blue weather dashboard with maps", mode: "task", async: true });
    assert.equal(prompted.status, 202);
    const session = await app.stateStore.getSession(identity.tenantId, sessionId);
    assert.equal(session?.title, "Build a blue weather dashboard with");
    assert.ok(events.some((event) => (event as { type?: string }).type === "session.updated"));
  } finally {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
