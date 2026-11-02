import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUILTIN_SKILLS,
  McpClientManager,
  SkillsRegistry,
  RECOMMENDED_REMOTE_SKILLS,
  StandardToolRouter,
  compileSandboxPolicy,
  createInitialRunState,
  LayeredContextManager,
  normalizeSkillImportUrl,
  resolveModelProfile,
  toWireMessages,
} from "../packages/core/src/index.ts";
import { SandboxDaemon } from "../packages/sandboxd/src/server.ts";
import { OpenHarnessServer } from "../packages/server/src/server.ts";
import { getAllowedToolsForSubagent, normalizeSubagentRole } from "../packages/server/src/subagents.ts";

const temp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("binary workspace reads preserve bytes and raw file access is tenant scoped", async () => {
  const root = temp("oh-doc-binary-");
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  const daemon = new SandboxDaemon({ sessionId: "s", runId: "r", sessionKey: "key", workspacePath: workspace, memoriesPath: path.join(root, "memories"), tmpPath: path.join(root, "tmp"), shadowGitDir: path.join(root, "git"), policy: compileSandboxPolicy({ runId: "r", phase: "agent", workspacePath: workspace, networkMode: "none" }) });
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x80, 0xff, 0x00]);
  try {
    const write = await daemon.handleRequest("POST", "/files/write_bytes", { "x-session-key": "key" }, { path: "report.pdf", dataBase64: bytes.toString("base64") });
    assert.equal(write.status, 200);
    const read = await daemon.handleRequest("POST", "/files/read_bytes", { "x-session-key": "key" }, { path: "report.pdf" });
    assert.equal(read.status, 200);
    assert.equal(read.body.mimeType, "application/pdf");
    assert.deepEqual(Buffer.from(String(read.body.dataBase64), "base64"), bytes);

    const server = new OpenHarnessServer({ dataDir: path.join(root, "data"), workspaceRoot: workspace, defaultModel: "mock/demo" });
    try {
      const owner = { tenantId: "tenant-a", userId: "u", admin: false };
      const catalog = await server.handleAuthenticatedRequest(owner, "GET", new URL("http://local/v1/skills/catalog"));
      assert.equal(catalog.status, 200);
      assert.ok(Array.isArray(catalog.body) && (catalog.body as Array<any>).some((item) => item.id === RECOMMENDED_REMOTE_SKILLS[0]!.id));
      const agents = await server.handleAuthenticatedRequest(owner, "GET", new URL("http://local/v1/agents"));
      assert.ok((agents.body as Array<any>).some((item) => item.name === "document"));
      const created = await server.handleAuthenticatedRequest(owner, "POST", new URL("http://local/v1/sessions"), {}, { title: "Binary" });
      const id = String((created.body as any).id);
      fs.writeFileSync(path.join((server as any).getSessionWorkspaceRoot("tenant-a", id), "report.pdf"), bytes);
      const raw = await server.readSessionRawFile(owner, id, "report.pdf");
      assert.equal(raw.status, 200); assert.equal(raw.mimeType, "application/pdf"); assert.equal(raw.filename, "report.pdf");
      assert.deepEqual(raw.buffer, bytes);
      const streamed = await server.handleAuthenticatedRequest(owner, "GET", new URL(`http://local/v1/sessions/${id}/file/raw?path=report.pdf&download=1`));
      assert.deepEqual(streamed.body, bytes);
      assert.equal(streamed.headers?.["content-type"], "application/pdf");
      assert.match(streamed.headers?.["content-disposition"] ?? "", /attachment; filename="report\.pdf"/);
      assert.equal((await server.readSessionRawFile({ ...owner, tenantId: "tenant-b" }, id, "report.pdf")).status, 404);
      assert.equal((await server.readSessionRawFile(owner, id, "../report.pdf")).status, 400);
    } finally { await server.stop(); }
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("Document Studio skills, recommended import normalization, and persistent registry", () => {
  const expected = ["word-document-studio", "excel-financial-modeler", "pdf-executive-publisher", "presentation-deck-designer", "visual-diagram-and-charting", "universal-doc-converter", "collaborative-doc-spec"];
  for (const id of expected) assert.ok(BUILTIN_SKILLS.some((skill) => skill.id === id), `missing ${id}`);
  assert.equal(normalizeSkillImportUrl("https://github.com/anthropics/skills/blob/main/skills/xlsx/SKILL.md"), "https://raw.githubusercontent.com/anthropics/skills/main/skills/xlsx/SKILL.md");
  const root = temp("oh-skill-store-");
  try {
    const registry = new SkillsRegistry({ workspaceRoot: root, dataDir: path.join(root, "data") });
    const saved = registry.saveSkill({ id: RECOMMENDED_REMOTE_SKILLS[0]!.id, name: "Recommended", content: "# Imported\nPersistent content" });
    assert.equal(saved.id, RECOMMENDED_REMOTE_SKILLS[0]!.id);
    assert.ok(fs.existsSync(path.join(root, "data", "skills", saved.id, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(root, ".openharness", "skills", saved.id, "SKILL.md")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("offline generate_image creates a real PNG in the workspace and records the changed file", async () => {
  const root = temp("oh-doc-image-");
  const router = new StandardToolRouter({ workspaceRoot: root, dataDir: root });
  const state = createInitialRunState({ runId: "img-run", sessionId: "img-session", model: "mock/demo", phase: "building", mode: "task" });
  const ctx = { runId: state.runId, sessionId: state.sessionId, tenantId: state.tenantId, workspaceRoot: root, state };
  try {
    const tool = router.getTool("generate_image"); assert.ok(tool);
    const result = await tool.execute({ prompt: "editorial header", output_path: "assets/hero.png", aspect_ratio: "16:9" }, ctx);
    assert.equal(result.error, undefined);
    const image = fs.readFileSync(path.join(root, "assets/hero.png"));
    assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.deepEqual(state.changedFiles, ["assets/hero.png"]);
    assert.equal((result.output as any).width, 1280);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("document preview vision wire strips encoded page data and counts bounded image tokens", () => {
  const page = "a".repeat(50_000);
  const message = { info: { id: "m", role: "assistant" as const }, createdAt: Date.now(), parts: [{ type: "tool" as const, tool: "render_document_preview", callId: "c", state: "completed" as const, input: { path: "report.pdf" }, output: { pageCount: 2, formulaErrors: [], pages: [{ page: 1, mimeType: "image/jpeg", dataBase64: page }, { page: 2, mimeType: "image/jpeg", dataBase64: page }] } }] };
  const wire = toWireMessages([message], resolveModelProfile("gpt-4o"));
  const toolMessage = wire.find((item) => item.role === "tool")!;
  assert.equal(JSON.stringify(toolMessage).includes(page), false);
  assert.equal(wire.filter((item) => item.role === "user").length, 2);
  assert.ok(JSON.stringify(wire).includes("image_url"));
  const manager = new LayeredContextManager({ workspaceRoot: temp("oh-doc-tokens-") });
  assert.ok(manager.estimateMessageTokens(message) < 4_000);
});

test("document-studio MCP, document role, and intent-based tool selection stay scoped", async () => {
  const root = temp("oh-doc-mcp-");
  const manager = new McpClientManager({ workspaceRoot: root });
  try {
    assert.equal(manager.listServers().find((server) => server.name === "document-studio")?.status, "connected");
    const presets = manager.listPresets().map((preset) => preset.id);
    for (const id of ["mcp-pandoc", "office-word", "excel", "word-to-pdf", "sery-files"]) assert.ok(presets.includes(id));
    const state = createInitialRunState({ runId: "mcp-run", sessionId: "mcp-session", phase: "building", mode: "task" });
    const ctx = { runId: state.runId, sessionId: state.sessionId, tenantId: state.tenantId, workspaceRoot: root, state };
    const tool = manager.buildTools().find((entry) => entry.name === "mcp__document_studio__render_mermaid"); assert.ok(tool);
    const rendered = await tool.execute({ code: "flowchart TD\n A-->B", outputPath: "diagram.svg" }, ctx);
    assert.equal(rendered.error, undefined); assert.ok(fs.existsSync(path.join(root, "diagram.svg")));
    assert.equal(normalizeSubagentRole("document"), "document"); assert.equal(normalizeSubagentRole("publisher"), "document");
    assert.throws(() => normalizeSubagentRole("bogus"), /explore, tester, reviewer, general/);
    const router = new StandardToolRouter({ workspaceRoot: root, mcpManager: manager });
    state.initialPrompt = "Create an executive Q4 financial model in Excel and PDF summary";
    let names = router.listTools(state).map((entry) => entry.name);
    assert.ok(names.includes("generate_image") && names.includes("render_document_preview") && names.includes("skill") && names.includes("mcp__document_studio__render_mermaid"));
    state.initialPrompt = "Fix this Python function"; state.agent = "code"; state.loadedGroups = [];
    names = router.listTools(state).map((entry) => entry.name);
    assert.ok(!names.includes("skill") && !names.includes("generate_image"));
    state.agent = "document";
    assert.ok(getAllowedToolsForSubagent("document", router.listTools(state)).some((entry) => entry.name === "render_document_preview"));
  } finally { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
