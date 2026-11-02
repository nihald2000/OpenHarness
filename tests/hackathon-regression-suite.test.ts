import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createInitialRunState,
  McpClientManager,
  StandardToolRouter,
  registerSandboxTransport,
  unregisterSandboxTransport,
} from "../packages/core/src/index.ts";
import { OpenHarnessServer } from "../packages/server/src/server.ts";
import { runSubagent } from "../packages/server/src/subagents.ts";
import { normalizeBrowserCheckSteps } from "../packages/core/src/tools/catalog.ts";

function tempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("SSE announces readiness and planned rotation with the Vercel-safe retry interval", async () => {
  const root = tempDir("oh-meta-sse-");
  const app = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, defaultModel: "mock/demo" });
  class FakeResponse extends EventEmitter {
    writableEnded = false;
    writableLength = 0;
    output = "";
    writeHead(_status: number, _headers: unknown) { return this; }
    write(value: string) { this.output += value; return true; }
    end() { this.writableEnded = true; return this; }
    destroy() { this.writableEnded = true; return this; }
  }
  const response = new FakeResponse();
  try {
    await app.streamEvents({ tenantId: "tenant-a", userId: "user-a", admin: false }, new URL("http://local/v1/events"), { headers: {} } as never, response as never);
    assert.match(response.output, /event: ready\ndata: \{"ok":true\}/);
    assert.match(response.output, /retry: 500/);
    response.emit("close");
  } finally {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Glimmer warmup is optional, returns immediately, and only starts one wake-up per minute", async () => {
  const root = tempDir("oh-meta-warmup-");
  const oldUrl = process.env.MUSE_GLIMMER_BASE_URL;
  const oldFetch = globalThis.fetch;
  let calls = 0;
  process.env.MUSE_GLIMMER_BASE_URL = "https://gpu.example.test/v1/";
  globalThis.fetch = (async () => { calls += 1; return new Response("{}", { status: 200 }); }) as typeof fetch;
  const app = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, defaultModel: "mock/demo" });
  try {
    const first = await app.handleRequest("POST", "/v1/models/warmup", {});
    const second = await app.handleRequest("POST", "/v1/models/warmup", {});
    assert.equal(first.status, 202);
    assert.deepEqual(first.body, { warming: true, model: "muse-glimmer" });
    assert.equal(second.status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
  } finally {
    await app.stop();
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.MUSE_GLIMMER_BASE_URL; else process.env.MUSE_GLIMMER_BASE_URL = oldUrl;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("voice transcription validates media and returns the offline fallback contract", async () => {
  const root = tempDir("oh-meta-voice-");
  const app = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, defaultModel: "mock/demo" });
  try {
    const invalid = await app.transcribeAudio({ tenantId: "t", userId: "u", admin: false }, Buffer.from("x"), "text/plain");
    assert.equal(invalid.status, 415);
    const accepted = await app.transcribeAudio({ tenantId: "t", userId: "u", admin: false }, Buffer.from("audio"), "audio/webm;codecs=opus");
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, { text: "", model: "muse-voice-transcribe", provider: "Meta Model API", offline: true });
  } finally {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("voice transcription sends a real multipart Meta request when the API key is configured", async () => {
  const root = tempDir("oh-meta-voice-http-");
  const oldKey = process.env.MODEL_API_KEY;
  const oldFetch = globalThis.fetch;
  let requestUrl = "";
  let auth = "";
  let modelField = "";
  process.env.MODEL_API_KEY = "test-model-api-key";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    auth = new Headers(init?.headers).get("authorization") ?? "";
    const form = init?.body as FormData;
    modelField = String(form.get("model") ?? "");
    assert.ok(form.get("file") instanceof Blob);
    return new Response(JSON.stringify({ text: "Create a report" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const app = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, defaultBaseUrl: "https://api.meta.example/v1" });
  try {
    const result = await app.transcribeAudio({ tenantId: "t", userId: "u", admin: false }, Buffer.from("audio-bytes"), "audio/webm;codecs=opus", "note.webm");
    assert.equal(result.status, 200);
    assert.equal(result.body.text, "Create a report");
    assert.equal(requestUrl, "https://api.meta.example/v1/audio/transcriptions");
    assert.equal(auth, "Bearer test-model-api-key");
    assert.equal(modelField, "muse-voice-transcribe");
  } finally {
    await app.stop();
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = oldKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runSubagent routes eligible audit roles to Glimmer and falls back after first cold-boot failure", async () => {
  const root = tempDir("oh-meta-subagent-");
  const state = createInitialRunState({ runId: "meta-run", sessionId: "meta-session", tenantId: "tenant-a", model: "muse-spark-1.3", mode: "task", phase: "building" });
  const models: string[] = [];
  const provider = {
    async generateTurn(request: { model: string }) {
      models.push(request.model);
      if (request.model === "muse-glimmer") throw new Error("cold boot timeout");
      return { text: "Audit complete", toolCalls: [] };
    },
  } as never;
  const manager = new McpClientManager({ workspaceRoot: root });
  const router = new StandardToolRouter({ workspaceRoot: root, mcpManager: manager });
  try {
    const result = await runSubagent({
      input: { agent: "reviewer", prompt: "Review the workspace" },
      ctx: { runId: state.runId, sessionId: state.sessionId, tenantId: state.tenantId, workspaceRoot: root, state },
      provider,
      toolRouter: router,
      modelRouting: { glimmerAvailable: true, metaApiAvailable: true },
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(models, ["muse-glimmer", "muse-spark-1.3-contributor"]);
    assert.equal((result.metadata as Record<string, unknown>).model, "muse-spark-1.3-contributor");
  } finally {
    await manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("visual audit rasterizer writes a PNG and reports normalized region intersections", () => {
  const root = tempDir("oh-meta-audit-");
  try {
    const output = path.join(root, "sam_visual_audit.png");
    const source = spawnSync("python", ["-c", "from PIL import Image; import io,base64; b=io.BytesIO(); Image.new('RGB',(80,60),'white').save(b,format='PNG'); print(base64.b64encode(b.getvalue()).decode())"], { encoding: "utf8" });
    if (source.status !== 0) { assert.fail(source.stderr || "Pillow image fixture failed"); }
    const args = Buffer.from(JSON.stringify({ imageBase64: source.stdout.trim(), output, outputPath: "deliverables/sam_visual_audit.png", regions: [
      { label: "first", x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      { label: "second", x: 0.3, y: 0.3, width: 0.5, height: 0.5 },
    ] })).toString("base64");
    const worker = spawnSync("python", ["packages/sandboxd/artifact-worker.py", "audit", args], { encoding: "utf8" });
    assert.equal(worker.status, 0, worker.stderr);
    const result = JSON.parse(worker.stdout) as { regionCount: number; collisions: unknown[]; outputPath: string };
    assert.equal(result.regionCount, 2);
    assert.equal(result.collisions.length, 1);
    assert.equal(result.outputPath, "deliverables/sam_visual_audit.png");
    assert.equal(fs.readFileSync(output).subarray(1, 4).toString("ascii"), "PNG");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("visual_segment_audit returns the SAM label and inline PNG artifact metadata", async () => {
  const root = tempDir("oh-meta-audit-tool-");
  const oldKey = process.env.MODEL_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.MODEL_API_KEY = "test-model-api-key";
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ regions: [{ label: "main panel", x: 0.1, y: 0.1, width: 0.8, height: 0.7 }] }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected API request ${String(input)}`);
  }) as typeof fetch;
  const app = new OpenHarnessServer({ dataDir: root, workspaceRoot: root });
  const state = createInitialRunState({ runId: "sam-run", sessionId: "sam-session", tenantId: "tenant-a", model: "muse-spark-1.3", mode: "task", phase: "building" });
  state.webTools = true;
  const requests: string[] = [];
  try {
    const tool = app.deps.toolRouter.getTool("visual_segment_audit");
    assert.ok(tool);
    const result = await tool.execute({ source: "browser", output_path: "deliverables/sam_visual_audit.png" }, {
      runId: state.runId,
      sessionId: state.sessionId,
      tenantId: state.tenantId,
      workspaceRoot: root,
      sandboxHandleId: "sandbox-a",
      state,
      requestSandbox: async (_method, route) => {
        requests.push(route);
        if (route === "/browser/screenshot") return { status: 200, body: { dataBase64: Buffer.from("png-image").toString("base64"), mimeType: "image/png", url: "http://127.0.0.1:3000/", title: "Dashboard" } };
        if (route === "/browser/visual_regions") return { status: 200, body: { width: 800, height: 600, regions: [{ label: "Submit", x: 400, y: 400, width: 100, height: 40 }] } };
        if (route === "/files/visual_audit") return { status: 200, body: { outputPath: "deliverables/sam_visual_audit.png", regionCount: 2, collisions: [], layoutScore: 100, regions: [] } };
        return { status: 404, body: { error: "unknown route" } };
      },
    });
    assert.equal(result.error, undefined);
    assert.equal((result.output as Record<string, unknown>).model, "sam-3.1");
    assert.equal(result.metadata?.model, "sam-3.1");
    assert.equal((result.metadata?.artifacts as Array<{ path: string }>)[0]?.path, "deliverables/sam_visual_audit.png");
    assert.deepEqual(requests, ["/browser/screenshot", "/browser/visual_regions", "/files/visual_audit"]);
  } finally {
    await app.stop();
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = oldKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser check normalizes common model action and type shapes before execution", () => {
  const steps = normalizeBrowserCheckSteps([
    { action: "navigate", path: "/" },
    { action: "click", text: "Verify Now" },
    { action: "assert_text", text: "VERIFIED" },
    { type: "click", selector: "#again" },
    { action: "fill", target: { role: "textbox", name: "Name" }, value: "Ada" },
    { action: "wait", ms: 250 },
  ]);
  assert.deepEqual(steps, [
    { goto: "/" },
    { click: { text: "Verify Now" } },
    { expectText: "VERIFIED", contains: "VERIFIED" },
    { click: "#again" },
    { fill: { role: "textbox", name: "Name" }, value: "Ada" },
    { waitMs: 250 },
  ]);
  assert.equal(normalizeBrowserCheckSteps([{ action: "unknown" }]), undefined);
});

test("browser_check_def accepts navigate/click/assert_text on its first definition", async () => {
  const root = tempDir("oh-browser-normalize-");
  const handle = "browser-normalize-sandbox";
  const flowBodies: Array<Record<string, unknown>> = [];
  registerSandboxTransport(handle, {
    async request(_method: string, route: string, body?: unknown) {
      if (route === "/ports") return { status: 200, body: { ports: [{ port: 3000 }] } };
      if (route === "/browser/run_flow") { flowBodies.push(body as Record<string, unknown>); return { status: 200, body: { passed: true, failedStep: -1, log: [] } }; }
      return { status: 404, body: { error: "unknown route" } };
    },
  });
  const state = createInitialRunState({ runId: "normalize-run", sessionId: "normalize-session", tenantId: "tenant", mode: "task", phase: "building" });
  state.webTools = true;
  state.sandboxHandleId = handle;
  const router = new StandardToolRouter({ workspaceRoot: root });
  try {
    const result = await router.executeTool("normalize-definition", "browser_check_def", {
      name: "spark-natural-steps",
      steps: [
        { action: "navigate", path: "/" },
        { action: "click", text: "Verify Now" },
        { action: "assert_text", text: "VERIFIED" },
      ],
    }, { runId: state.runId, sessionId: state.sessionId, tenantId: state.tenantId, workspaceRoot: root, sandboxHandleId: handle, state });
    assert.equal(result.error, undefined);
    assert.equal((result.output as Record<string, unknown>).passed, true);
    assert.deepEqual((flowBodies[0]?.steps as unknown[]), [
      { goto: "/" },
      { click: { text: "Verify Now" } },
      { expectText: "VERIFIED", contains: "VERIFIED" },
    ]);
    assert.equal(flowBodies.length, 1);
  } finally {
    unregisterSandboxTransport(handle);
    await router.mcpManager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("artifact preview and inspect handle bounded xlsx and untitled pptx fixtures", { skip: spawnSync("python", ["-c", "import openpyxl, pptx"], { encoding: "utf8" }).status !== 0 }, () => {
  const root = tempDir("oh-artifact-regression-");
  try {
    const fixture = String.raw`
import sys
from pathlib import Path
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches
root = Path(sys.argv[1])
book = Workbook(); sheet = book.active; sheet.title = "Model"
sheet["A1"] = "Revenue"; sheet["A2"] = 10; sheet["A3"] = 20; sheet["A4"] = "=SUM(A2:A3)"
sheet["B1"] = "Broken"; sheet["B2"] = "#DIV/0!"; sheet["B2"].data_type = "e"
book.save(root / "budget.xlsx")
deck = Presentation(); slide = deck.slides.add_slide(deck.slide_layouts[6])
shape = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1)); shape.text = "Untitled layout safe"
table = slide.shapes.add_table(1, 2, Inches(1), Inches(2), Inches(5), Inches(1)).table
table.cell(0, 0).text = "A"; table.cell(0, 1).text = "B"
deck.save(root / "untitled.pptx")
`;
    const created = spawnSync("python", ["-c", fixture, root], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    for (const [file, actions] of [["budget.xlsx", ["preview", "inspect"]], ["untitled.pptx", ["preview", "inspect"]]] as const) {
      for (const action of actions) {
        const args = Buffer.from(JSON.stringify({ path: path.join(root, file), maxPages: 2 })).toString("base64");
        const result = spawnSync("python", ["packages/sandboxd/artifact-worker.py", action, args], { encoding: "utf8" });
        assert.equal(result.status, 0, `${file} ${action}: ${result.stderr}`);
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
        assert.equal(parsed.kind === "spreadsheet" || parsed.kind === "presentation" || Array.isArray(parsed.pages), true);
        if (file === "budget.xlsx" && action === "inspect") {
          assert.ok((parsed.formulaErrors as string[]).some((item) => item.includes("#DIV/0!")));
          const rows = ((parsed.sheets as Array<{ rows: Array<Array<{ formula?: string }>> }>)[0]!).rows;
          assert.equal(rows[3]?.[0]?.formula, "=SUM(A2:A3)");
        }
        if (file === "untitled.pptx" && action === "inspect") {
          assert.equal((parsed.slides as Array<{ title: string }>)[0]?.title, "Untitled layout safe");
          assert.match((parsed.slides as Array<{ bullets: string[] }>)[0]?.bullets.join(" ") ?? "", /A \| B/);
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
