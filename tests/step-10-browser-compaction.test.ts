import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxDaemon } from "../packages/sandboxd/src/server.ts";
import { compileSandboxPolicy, createInitialRunState } from "../packages/core/src/index.ts";
import { OpenHarnessServer } from "../packages/server/src/server.ts";

test("Step 10 (F2, F3): /browser/* fails closed with 503 when requirePlaywright is set and Playwright is unavailable; LayeredContextManager calls the LLM summarizer on non-mock models", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oh-step10-"));
  const wsDir = path.join(tmpRoot, "workspace");
  const memDir = path.join(tmpRoot, "memories");
  const tmpDir = path.join(tmpRoot, "tmp");
  const gitDir = path.join(tmpRoot, ".shadow-git");

  const policy = compileSandboxPolicy({
    runId: "run_step10",
    phase: "agent",
    workspacePath: wsDir,
    memoriesPath: memDir,
    tmpPath: tmpDir,
    networkMode: "allowlist",
  });

  // 1. Browser fail-closed 503 when requirePlaywright is true
  const daemon = new SandboxDaemon({
    sessionId: "sess_step10",
    runId: "run_step10",
    sessionKey: "key_step10",
    workspacePath: wsDir,
    memoriesPath: memDir,
    tmpPath: tmpDir,
    shadowGitDir: gitDir,
    requirePlaywright: true,
    policy,
  });

  const navRes = await daemon.handleRequest(
    "POST",
    "/browser/navigate",
    { "x-session-key": "key_step10" },
    { url: "https://api.github.com" }
  );
  assert.equal(navRes.status, 503);
  assert.match(String(navRes.body.error), /Playwright browser worker unavailable/);

  const shotRes = await daemon.handleRequest(
    "POST",
    "/browser/screenshot",
    { "x-session-key": "key_step10" },
    {}
  );
  assert.equal(shotRes.status, 503);
  await daemon.close();

  // 2. LayeredContextManager in OpenHarnessServer calls provider.generateTurn via summarizer for non-mock models
  const server = new OpenHarnessServer({
    dataDir: path.join(tmpRoot, "data"),
    workspaceRoot: wsDir,
  });

  let summarizerCalls = 0;
  server.deps.provider.generateTurn = async (req) => {
    summarizerCalls += 1;
    return {
      text: `LLM_SUMMARY_MARKER: compacted ${req.messages.length} transcript message(s) for ${req.model}`,
      toolCalls: [],
      usage: { input: 50, output: 25 },
    };
  };

  const state = createInitialRunState({
    runId: "run_compaction_10",
    sessionId: "sess_compaction_10",
    model: "gpt-4o",
    mode: "task",
  });

  // Create enough large messages to exceed context window and trigger compaction
  const bigChunk = "A".repeat(40_000);
  const messages = Array.from({ length: 14 }, (_, idx) => ({
    info: {
      id: `m_${idx + 1}`,
      role: (idx % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    },
    createdAt: Date.now() + idx * 100,
    parts: [{ type: "text" as const, text: `Turn ${idx + 1}: ${bigChunk}` }],
  }));

  const prepared = await server.deps.contextManager.prepareTurnContext(state, messages);
  assert.equal(prepared.compacted, true);
  assert.ok(summarizerCalls >= 1, "Expected LLM summarizer to be invoked for non-mock model");
  const summaryMsg = prepared.messages[0]!;
  const compPart = summaryMsg.parts.find((p) => p.type === "compaction");
  assert.ok(compPart && compPart.type === "compaction");
  assert.match(compPart.summary, /LLM_SUMMARY_MARKER/);
});
