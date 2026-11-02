import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxDaemon } from "../packages/sandboxd/src/server.ts";
import { compileSandboxPolicy } from "../packages/core/src/sandbox/policy.ts";
import { BrowserBridge } from "../packages/sandboxd/src/browser-bridge.ts";
import { createInitialRunState, StandardToolRouter } from "../packages/core/src/index.ts";
import { McpClientManager } from "../packages/core/src/mcp/client.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-studio-regression-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const daemon = new SandboxDaemon({
    sessionId: "studio-session",
    runId: "studio-run",
    sessionKey: "studio-key",
    workspacePath: workspace,
    memoriesPath: path.join(root, "memories"),
    tmpPath: path.join(root, "tmp"),
    shadowGitDir: path.join(root, "shadow-git"),
    policy: compileSandboxPolicy({ runId: "studio-run", phase: "agent", workspacePath: workspace, networkMode: "none" }),
  });
  return { root, workspace, daemon };
}

test("run_flow returns a bounded daemon response for invalid ports without waiting for Chromium", async () => {
  const bridge = new BrowserBridge({ workerPath: path.resolve("packages/sandboxd/browser-worker.mjs") });
  try {
    const response = await bridge.send("run_flow", { port: 8080, steps: [{ goto: "/" }] }, 2_000);
    assert.equal(response.status, 400);
    assert.match(String(response.body.error), /valid preview port/);
  } finally {
    await bridge.close();
  }
});

test("artifact inspection returns bounded structured data for CSV and HTML files", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.workspace, "model.csv"), "Name,Amount\nA,2\nB,3\n", "utf8");
    fs.writeFileSync(path.join(f.workspace, "dashboard.html"), "<h1>Revenue</h1>", "utf8");
    const csv = await f.daemon.handleRequest("POST", "/files/inspect_artifact", { "x-session-key": "studio-key" }, { path: "model.csv" });
    assert.equal(csv.status, 200);
    assert.equal(csv.body.kind, "spreadsheet");
    assert.equal((csv.body.sheets as Array<{ rows: unknown[] }>)[0]?.rows.length, 3);
    const html = await f.daemon.handleRequest("POST", "/files/inspect_artifact", { "x-session-key": "studio-key" }, { path: "dashboard.html" });
    assert.equal(html.status, 200);
    assert.equal(html.body.kind, "html_artifact");
    assert.equal(html.body.content, "<h1>Revenue</h1>");
  } finally {
    await f.daemon.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("preview_document uses the isolated artifact worker and returns JPEG page data for an image", async () => {
  const f = fixture();
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMfoAAAAASUVORK5CYII=", "base64");
    fs.writeFileSync(path.join(f.workspace, "pixel.png"), png);
    const result = await f.daemon.handleRequest("POST", "/files/preview_document", { "x-session-key": "studio-key" }, { path: "pixel.png" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const pages = result.body.pages as Array<{ mimeType: string; dataBase64: string }>;
    assert.equal(pages[0]?.mimeType, "image/jpeg");
    assert.ok(Buffer.from(pages[0]!.dataBase64, "base64").byteLength > 100);
  } finally {
    await f.daemon.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("tool execution automatically reports created deliverable artifacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-artifact-capture-"));
  const state = createInitialRunState({ runId: "artifact-run", sessionId: "artifact-session", tenantId: "tenant-a", mode: "task", phase: "building" });
  const router = new StandardToolRouter({ workspaceRoot: root });
  try {
    const result = await router.executeTool("call-artifact", "write_file", { path: "deliverables/summary.csv", content: "metric,value\nusers,12\n" }, {
      runId: state.runId, sessionId: state.sessionId, tenantId: state.tenantId, workspaceRoot: root, state,
    });
    assert.equal(result.error, undefined);
    assert.ok(Array.isArray(result.metadata?.artifacts));
    assert.equal((result.metadata?.artifacts as Array<{ path: string }>)[0]?.path, "deliverables/summary.csv");
  } finally {
    await router.mcpManager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the first document MCP call provisions its sandbox and uses the structured extraction endpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-mcp-doc-first-call-"));
  const state = createInitialRunState({ runId: "mcp-doc-run", sessionId: "mcp-doc-session", tenantId: "tenant-a", mode: "task", phase: "building" });
  let provisioned = false;
  const requests: string[] = [];
  const manager = new McpClientManager({ workspaceRoot: root });
  const router = new StandardToolRouter({
    workspaceRoot: root,
    mcpManager: manager,
    ensureSandbox: async () => { provisioned = true; return { id: "mcp-doc-sandbox", workspacePath: root }; },
    requestSandbox: async (_handle, _method, route) => {
      requests.push(route);
      return { status: 200, body: { path: "report.docx", markdown: "# Summary\nRevenue grew." } };
    },
  });
  try {
    const result = await router.executeTool("mcp-doc-call", "mcp__document_studio__extract_markdown", { path: "report.docx" }, {
      runId: state.runId, sessionId: state.sessionId, tenantId: state.tenantId, workspaceRoot: root, state,
    });
    assert.equal(provisioned, true);
    assert.equal(state.sandboxHandleId, "mcp-doc-sandbox");
    assert.equal(requests.filter((route) => route === "/files/extract_markdown").length, 1);
    assert.equal((result.output as { markdown?: string }).markdown, "# Summary\nRevenue grew.");
  } finally {
    await manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
