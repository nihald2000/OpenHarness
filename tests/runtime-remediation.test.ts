import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInitialRunState } from "../packages/core/src/index.ts";
import { compileSandboxPolicy } from "../packages/core/src/sandbox/policy.ts";
import { SandboxDaemon } from "../packages/sandboxd/src/server.ts";
import { createSandboxHubServer } from "../packages/sandboxd/src/hub.ts";
import { OpenHarnessServer } from "../packages/server/src/server.ts";

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function largePng(): Buffer {
  const tiny = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMfoAAAAASUVORK5CYII=", "base64");
  const iend = tiny.lastIndexOf(Buffer.from("IEND")) - 4;
  const payload = crypto.randomBytes(180_000);
  return Buffer.concat([tiny.subarray(0, iend), pngChunk("raNd", payload), tiny.subarray(iend)]);
}

function daemonFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-remediation-daemon-"));
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  const daemon = new SandboxDaemon({
    sessionId: "remediation-session", runId: "remediation-run", sessionKey: "remediation-session-key",
    workspacePath, memoriesPath: path.join(root, "memories"), tmpPath: path.join(root, "tmp"),
    shadowGitDir: path.join(root, "shadow-git"),
    policy: compileSandboxPolicy({ runId: "remediation-run", phase: "agent", workspacePath, networkMode: "none" }),
  });
  return { root, workspacePath, daemon };
}

test("large browser audit payload travels over stdin and writes valid PNG proof", async () => {
  const f = daemonFixture();
  try {
    const source = largePng();
    const imageBase64 = source.toString("base64");
    assert.ok(imageBase64.length > 200_000);
    const response = await f.daemon.handleRequest("POST", "/files/visual_audit", { "x-session-key": "remediation-session-key" }, {
      imageBase64,
      outputPath: "deliverables/large-audit.png",
      regions: [{ label: "viewport", box: [0, 0, 1, 1] }],
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const resultPath = path.join(f.workspacePath, "deliverables", "large-audit.png");
    const rendered = fs.readFileSync(resultPath);
    assert.deepEqual(rendered.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(response.body.outputPath, "deliverables/large-audit.png");
  } finally {
    await f.daemon.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("shell may inspect skill metadata but remains blocked from modifying protected harness paths", async () => {
  const f = daemonFixture();
  try {
    const headers = { "x-session-key": "remediation-session-key" };
    const read = await f.daemon.handleRequest("POST", "/shell/main/exec", headers, { command: "ls .openharness/skills 2>/dev/null", timeoutSec: 5 });
    assert.notEqual(read.status, 403);
    assert.doesNotMatch(String(read.body.output ?? ""), /Mandatory sandbox deny rule blocked write/);

    const shellWrite = await f.daemon.handleRequest("POST", "/shell/main/exec", headers, { command: "echo pwn > .openharness/skills/evil.md", timeoutSec: 5 });
    assert.equal(shellWrite.status, 403);
    assert.match(String(shellWrite.body.output), /Mandatory sandbox deny rule blocked write/);

    const fileWrite = await f.daemon.handleRequest("POST", "/files/create", headers, { path: ".openharness/skills/evil.md", content: "pwn" });
    assert.equal(fileWrite.status, 403);
    assert.equal(fileWrite.body.kind, "mandatory_deny");
  } finally {
    await f.daemon.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("budget resume stores a continuation, clears pause UI state, and executes an available tool", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-budget-resume-"));
  const previousBudget = process.env.OH_MAX_INPUT_TOKENS_PER_RUN;
  const server = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, defaultModel: "mock/demo" });
  const priorToolRouter = server.deps.toolRouter;
  const priorGenerateTurn = server.deps.provider.generateTurn.bind(server.deps.provider);
  try {
    process.env.OH_MAX_INPUT_TOKENS_PER_RUN = "800000";
    await server.stateStore.saveSession("default", {
      id: "budget-resume-session", title: "Resume", agent: "assistant", model: "mock/demo", runtime: "local",
      status: "awaiting_input", pauseReason: "paused_budget", updatedAt: Date.now(),
    });
    const { run } = await server.runStateMachine.createRun({
      runId: "budget-resume-run", sessionId: "budget-resume-session", tenantId: "default", prompt: "Finish the task",
      model: "mock/demo", mode: "task", runtime: "local",
    });
    await server.runStateMachine.transition(run.id, "queued", "running", { phase: "paused", pauseReason: "paused_budget" });
    await server.runStateMachine.transition(run.id, "running", "awaiting_input", { phase: "paused", pauseReason: "paused_budget" });
    const state = createInitialRunState({ runId: run.id, sessionId: run.sessionId, tenantId: "default", model: "mock/demo", runtime: "local", mode: "task", phase: "paused" });
    state.pauseReason = "paused_budget";
    state.inputTokensThisRun = 300_001;
    state.iteration = 1;
    await server.stateStore.saveStepCheckpoint({
      runId: run.id, sessionId: run.sessionId, tenantId: "default", stepIndex: 1, state,
      transcriptCursor: 0, usage: state.usage, cost: 0, pendingApproval: null, sandboxHandleId: null,
      lastCheckpointSha: null, inFlightToolCalls: [], completedToolCallIds: [], savedAt: Date.now(),
    });

    const executed: string[] = [];
    const registered = {
      name: "resume_probe", description: "Test tool used to validate continuation.", readOnly: false, idempotent: true,
      parameters: { type: "object", properties: {} }, execute: async () => ({ output: "tool executed" }),
    } as any;
    (server.deps as any).toolRouter = {
      listTools: () => [registered], getTool: () => registered,
      executeTool: async (_callId: string, name: string) => { executed.push(name); return { output: "tool executed" }; },
    };
    let calls = 0;
    (server.deps.provider as any).generateTurn = async (request: { tools: unknown[] }) => {
      calls++;
      if (calls === 1) {
        assert.ok(request.tools.some((tool: any) => tool.name === "resume_probe"));
        return { text: "", toolCalls: [{ id: "resume-tool-call", name: "resume_probe", arguments: {} }], usage: { input: 20, output: 2 } };
      }
      return { text: "Completed the remaining work.", toolCalls: [], usage: { input: 20, output: 4 } };
    };

    let resumed: Promise<void> | undefined;
    server.runWorker.setRunLauncher((id) => { resumed = server.runWorker.startRun(id); });
    const result = await server.runWorker.resumeRun(run.id);
    assert.equal(result?.pauseReason, undefined);
    await resumed;

    const { messages } = await server.stateStore.getMessages("default", run.sessionId);
    assert.ok(messages.some((message) => message.info.role === "user" && message.info.id.startsWith("budget_resume_") && message.parts.some((part: any) => part.text?.includes("Continue executing"))));
    assert.deepEqual(executed, ["resume_probe"]);
    assert.equal((await server.stateStore.getSession("default", run.sessionId))?.pauseReason, undefined);
    assert.ok((await server.runWorker.getRun(run.id))?.status === "completed");
  } finally {
    (server.deps as any).toolRouter = priorToolRouter;
    (server.deps.provider as any).generateTurn = priorGenerateTurn;
    if (previousBudget === undefined) delete process.env.OH_MAX_INPUT_TOKENS_PER_RUN;
    else process.env.OH_MAX_INPUT_TOKENS_PER_RUN = previousBudget;
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox hub marks forwarded daemon errors and allows visual regions during human control", async () => {
  const originalVm = process.env.OH_VM_ISOLATED;
  const originalSrt = process.env.OH_DISABLE_SRT;
  process.env.OH_VM_ISOLATED = "1";
  process.env.OH_DISABLE_SRT = "1";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-hub-visual-regression-"));
  const sessionKey = "hub-visual-test-key-0123456789-abcdef";
  const hub = createSandboxHubServer({ root: path.join(root, "workspaces"), sessionKey });
  const request = (port: number, method: string, route: string, body: Record<string, unknown>) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: route, headers: { "x-session-key": sessionKey, "x-oh-sandbox-id": "hub-visual-session", "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.once("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
  try {
    await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
    const port = (hub.address() as { port: number }).port;
    const init = await request(port, "POST", "/sessions/init", {});
    assert.equal(init.status, 200);
    const denied = await request(port, "POST", "/files/create", { path: ".git/hooks/pre-commit", content: "blocked" });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers["x-oh-daemon"], "1");
    const locked = await request(port, "POST", "/browser/lock", { owner: "human" });
    assert.equal(locked.status, 200);
    const visual = await request(port, "POST", "/browser/visual_regions", {});
    assert.notEqual(visual.status, 423);
    assert.equal(visual.headers["x-oh-daemon"], "1");
  } finally {
    await hub.closeHub();
    fs.rmSync(root, { recursive: true, force: true });
    if (originalVm === undefined) delete process.env.OH_VM_ISOLATED; else process.env.OH_VM_ISOLATED = originalVm;
    if (originalSrt === undefined) delete process.env.OH_DISABLE_SRT; else process.env.OH_DISABLE_SRT = originalSrt;
  }
});
