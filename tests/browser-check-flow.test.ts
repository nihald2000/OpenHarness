import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BrowserBridge } from "../packages/sandboxd/src/browser-bridge.ts";
import { browserSignature, formatBrowserEvidence } from "../packages/core/src/agent/verification.ts";
import { createInitialRunState, registerSandboxTransport, StandardToolRouter, unregisterSandboxTransport } from "../packages/core/src/index.ts";

test("browser check evidence includes the failing step, visible text, network failures, and stable signature", () => {
  const failure = {
    passed: false,
    failedStep: 1,
    step: { expectText: { role: "heading", name: "Saved" }, contains: "done" },
    error: "expected done, got no at http://127.0.0.1:3000/",
    url: "http://127.0.0.1:3000/",
    text: "Welcome alice",
    errors: ["pageerror: broken"],
    failedRequests: ["POST http://127.0.0.1:3000/api/todos -> 500"],
    log: [{ step: 1, action: "goto" }],
  };
  const evidence = formatBrowserEvidence("counter", 3, failure, "npm run dev");
  assert.match(evidence, /failed at step 2\/3/);
  assert.match(evidence, /Welcome alice/);
  assert.match(evidence, /POST .*api\/todos -> 500/);
  assert.match(browserSignature("counter", failure), /^browser:counter:1:/);
  assert.equal(browserSignature("counter", failure), browserSignature("counter", { ...failure, error: "expected done, got no at http://127.0.0.1:5173/" }));
});

test("run_flow rejects the reserved daemon port before starting Chromium", async () => {
  const bridge = new BrowserBridge({ workerPath: path.resolve("packages/sandboxd/browser-worker.mjs") });
  try {
    const result = await bridge.send("run_flow", { port: 8080, steps: [{ goto: "/" }] });
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /valid preview port/);
  } finally {
    await bridge.close();
  }
});

test("browser_check_def runs immediately, preserves its first definition, and hides screenshot bytes", async () => {
  const calls: Array<{ method: string; route: string; body?: unknown }> = [];
  registerSandboxTransport("browser-check-sandbox", {
    async request(method, route, body) {
      calls.push({ method, route, body });
      if (route === "/ports") return { status: 200, body: { ports: [{ port: 3000 }] } };
      if (route === "/browser/run_flow") return { status: 200, body: { passed: true, screenshotJpegBase64: "x".repeat(500), url: "http://127.0.0.1:3000/", log: [] } };
      return { status: 404, body: { error: "not found" } };
    },
  });
  const state = createInitialRunState({ runId: "browser-check-run", sessionId: "browser-check-session", tenantId: "tenant", mode: "task", phase: "building" });
  state.webTools = true;
  state.sandboxHandleId = "browser-check-sandbox";
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oh-browser-check-tool-"));
  const router = new StandardToolRouter({ workspaceRoot });
  const ctx = { runId: state.runId, sessionId: state.sessionId, tenantId: state.tenantId, workspaceRoot, sandboxHandleId: state.sandboxHandleId, state };
  const definition = { name: "counter", port: 3000, steps: [{ goto: "/" }, { expectText: { role: "heading", name: "Counter" }, contains: "0" }] };
  try {
    const first = await router.executeTool("define-1", "browser_check_def", definition, ctx);
    assert.equal((first.output as any).passed, true);
    assert.equal(JSON.stringify(first.output).includes("screenshotJpegBase64"), false);
    const changed = await router.executeTool("define-2", "browser_check_def", { ...definition, steps: [{ goto: "/other" }] }, ctx);
    assert.match(String(changed.error), /immutable/);
    assert.deepEqual(state.browserChecks?.[0]?.steps, definition.steps);
    assert.deepEqual(state.browserCheckTampering, ["counter"]);
    assert.equal(calls.filter((call) => call.route === "/browser/run_flow").length, 1);
  } finally {
    unregisterSandboxTransport("browser-check-sandbox");
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("normalizeBrowserCheckSteps preserves CSS selectors, extracts text/value for fill/type steps, and read_file resolves .openharness/outputs across roots", async () => {
  const { normalizeBrowserCheckSteps } = await import("../packages/core/src/tools/catalog.ts");
  const normalized = normalizeBrowserCheckSteps([
    { action: "navigate", path: "/" },
    { action: "click", selector: "input[value='express']" },
    { action: "type", selector: "#name", text: "Ada Lovelace" },
    { type: "#email", text: "ada@example.com" },
    { fill: "#zip", text: "94107" },
    { action: "assert_text", selector: "#summary", text: "$75.00" },
    { expectText: "Express" },
  ]);
  assert.deepEqual(normalized, [
    { goto: "/" },
    { click: { css: "input[value='express']" } },
    { fill: { css: "#name" }, value: "Ada Lovelace" },
    { fill: "#email", value: "ada@example.com" },
    { fill: "#zip", value: "94107" },
    { expectText: { css: "#summary" }, contains: "$75.00" },
    { expectText: { css: "body" }, contains: "Express" },
  ]);

  const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oh-outputs-fallback-"));
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oh-outputs-session-"));
  try {
    const outDir = path.join(fallbackRoot, ".openharness", "outputs");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "call_test123.txt"), "spilled content ok", "utf8");
    const state = createInitialRunState({ runId: "r", sessionId: "s", tenantId: "t", mode: "task", phase: "building" });
    const router = new StandardToolRouter({ workspaceRoot: fallbackRoot });
    const ctx = { runId: "r", sessionId: "s", tenantId: "t", workspaceRoot: sessionRoot, state };
    const readRes = await router.executeTool("c1", "read_file", { path: ".openharness/outputs/call_test123.txt" }, ctx);
    assert.equal(readRes.error, undefined);
    assert.equal(readRes.output, "spilled content ok");
    const listRes = await router.executeTool("c2", "list", { path: ".openharness/outputs" }, ctx);
    assert.equal(listRes.error, undefined);
    assert.deepEqual(listRes.output, [{ name: "call_test123.txt", type: "file" }]);
  } finally {
    fs.rmSync(fallbackRoot, { recursive: true, force: true });
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});
