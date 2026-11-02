import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createInitialRunState,
  LayeredContextManager,
  mapFramePointToViewport,
  resolveModelProfile,
  validateOpenHarnessConfig,
} from "../packages/core/src/index.ts";
import type { Message, Part } from "@openharness/sdk";
import { OpenHarnessServer } from "../packages/server/src/server.ts";

function message(id: string, part: Part, role: "user" | "assistant" = "assistant"): Message {
  return { info: { id, role }, createdAt: Date.now(), parts: [part] };
}

function toolMessage(id: string, tool: string, output: unknown): Message {
  return message(id, { type: "tool", tool, callId: id, state: "completed", output });
}

test("context windows follow model profiles and only explicit environment limits cap them", async () => {
  const original = process.env.OH_CONTEXT_BUDGET_TOKENS;
  delete process.env.OH_CONTEXT_BUDGET_TOKENS;
  try {
    const manager = new LayeredContextManager();
    assert.equal(manager.resolveContextWindow("muse-spark-1.3"), 128_000);
    assert.equal(manager.getTriggerTokens(128_000), 108_800);
    const safeOverride = resolveModelProfile("muse-spark-1.3", {
      "muse-spark-1.3": { contextWindow: 96_000, baseUrl: "https://invalid.example/v1", apiKeyEnv: "INVALID_KEY", wire: "anthropic" },
    });
    assert.equal(safeOverride.contextWindow, 96_000);
    assert.equal(safeOverride.baseUrl, "https://api.meta.ai/v1");
    assert.equal(safeOverride.apiKeyEnv, "MODEL_API_KEY");
    assert.equal(safeOverride.wire, "openai-chat");
    assert.equal(validateOpenHarnessConfig({
      compaction: { enabled: false, triggerAt: 0.9, keepRecentTokens: 4_000 },
      limits: { chat: {}, task: {}, long_task: { maxCostPerTask: 25 }, maxSessionContextTokens: 96_000 },
    }).valid, true);
    const state = createInitialRunState({ runId: "window-run", sessionId: "window-session", model: "muse-spark-1.3", mode: "chat" });
    const result = await manager.prepareTurnContext(state, [message("long-user", { type: "text", text: "x".repeat(140_000) }, "user")]);
    assert.equal(result.compacted, false);
    assert.equal(result.hardReset, false);

    process.env.OH_CONTEXT_BUDGET_TOKENS = "50000";
    assert.equal(new LayeredContextManager().resolveContextWindow("muse-spark-1.3"), 50_000);
  } finally {
    if (original === undefined) delete process.env.OH_CONTEXT_BUDGET_TOKENS;
    else process.env.OH_CONTEXT_BUDGET_TOKENS = original;
  }
});

test("image payloads use bounded vision estimates and pruning keeps two snapshots", async () => {
  const manager = new LayeredContextManager({ clearAfterTurns: 20 });
  const screenshot = toolMessage("shot", "browser_screenshot", {
    mimeType: "image/png",
    url: "http://127.0.0.1:3000/",
    dataBase64: "A".repeat(200_000),
  });
  assert.ok(manager.estimateMessageTokens(screenshot) < 2_500);
  const screenshotRun = await manager.prepareTurnContext(
    createInitialRunState({ runId: "image-run", sessionId: "image-session", model: "mock/demo", mode: "chat" }),
    [screenshot],
  );
  assert.equal(screenshotRun.compacted, false);
  assert.equal(screenshotRun.hardReset, false);

  const transcript = [
    toolMessage("snap-1", "browser_snapshot", "old snapshot"),
    toolMessage("snap-2", "browser_snapshot", "middle snapshot"),
    toolMessage("snap-3", "browser_snapshot", "latest snapshot"),
    toolMessage("shot-1", "browser_screenshot", "old screen"),
    toolMessage("shot-2", "browser_screenshot", "latest screen"),
    toolMessage("logs-1", "process_logs", "old logs"),
    toolMessage("logs-2", "process_logs", "latest logs"),
    ...[1, 2, 3, 4].map((n) => toolMessage(`bash-${n}`, "bash", `bash output ${n}`)),
  ];
  const pruned = manager.clearOldToolResults(transcript);
  const result = (id: string) => String(pruned.find((entry) => entry.info.id === id)?.parts[0] && (pruned.find((entry) => entry.info.id === id)!.parts[0] as any).output);
  assert.match(result("snap-2"), /middle snapshot/);
  assert.match(result("snap-3"), /latest snapshot/);
  assert.match(result("snap-1"), /^\[cleared/);
  assert.match(result("shot-2"), /latest screen/);
  assert.match(result("shot-1"), /^\[cleared/);
  assert.match(result("logs-2"), /latest logs/);
  assert.match(result("logs-1"), /^\[cleared/);
  for (const n of [2, 3, 4]) assert.ok(result(`bash-${n}`).includes(`bash output ${n}`));
  assert.match(result("bash-1"), /^\[cleared/);
});

test("session context, manual compaction, dynamic settings, and task tools use effective config", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-context-routes-"));
  const server = new OpenHarnessServer({ dataDir: root, workspaceRoot: root, defaultModel: "muse-spark-1.3" });
  const admin = { tenantId: "default", userId: "test-admin", admin: true };
  const settingsRequest = (section: string, value: unknown) => server.handleAuthenticatedRequest(
    admin,
    "PATCH",
    new URL("http://localhost/v1/admin/settings"),
    {},
    { section, value },
  );
  try {
    const created = await server.handleRequest("POST", "/v1/sessions", {}, {
      title: "Context test", mode: "task", model: "muse-spark-1.3",
    });
    assert.equal(created.status, 201);
    const sessionId = (created.body as { id: string }).id;

    const initialContext = await server.handleRequest("GET", `/v1/sessions/${sessionId}/context`);
    const initialUsage = (initialContext.body as any).contextUsage;
    assert.equal(initialUsage.contextWindow, 128_000);
    assert.equal(initialUsage.triggerAt, 108_800);

    const short = await server.handleRequest("POST", `/v1/sessions/${sessionId}/compact`, {}, {});
    assert.equal(short.status, 400);
    assert.deepEqual(short.body, { error: "Nothing to compact yet." });

    server.deps.provider.generateTurn = async () => ({ text: "Preserve the request, file changes, and next step.", toolCalls: [] });
    const events: string[] = [];
    server.eventBus.subscribe({ tenantId: "default", sessionId }, (envelope) => events.push(envelope.event.type));
    for (let index = 0; index < 4; index++) {
      await server.stateStore.saveMessage("default", sessionId, message(
        `transcript-${index}`,
        { type: "text", text: `Conversation turn ${index}: preserve the key decision and next action.` },
        index % 2 === 0 ? "user" : "assistant",
      ));
    }
    const compacted = await server.handleRequest("POST", `/v1/sessions/${sessionId}/compact`, {}, {});
    assert.equal(compacted.status, 200);
    assert.equal((compacted.body as any).compacted, true);
    const saved = await server.stateStore.getMessages("default", sessionId);
    const compactPart = saved.messages.flatMap((entry) => entry.parts).find((part) => part.type === "compaction");
    assert.equal(compactPart?.type, "compaction");
    assert.equal(compactPart?.reason, "manual");
    assert.ok(events.includes("part.updated"));

    await settingsRequest("compaction", { enabled: false, triggerAt: 0.9 });
    await settingsRequest("limits", { maxSessionContextTokens: 96_000 });
    const configuredContext = await server.handleRequest("GET", `/v1/sessions/${sessionId}/context`);
    const configuredUsage = (configuredContext.body as any).contextUsage;
    assert.equal(configuredUsage.contextWindow, 96_000);
    assert.equal(configuredUsage.triggerAt, 86_400);

    const disabledState = createInitialRunState({ runId: "disabled-run", sessionId, tenantId: "default", model: "muse-spark-1.3", mode: "chat" });
    const disabled = await server.deps.contextManager.prepareTurnContext(disabledState, [
      message("large-current-turn", { type: "text", text: "z".repeat(352_000) }, "user"),
    ]);
    assert.equal(disabled.compacted, false);
    assert.equal(disabled.hardReset, false);

    const taskCatalog = await server.handleRequest("GET", "/v1/tools?agent=assistant");
    const taskNames = new Set((taskCatalog.body as Array<{ name: string }>).map((tool) => tool.name));
    for (const name of ["write_file", "bash", "process_start", "browser_navigate", "browser_check_def", "request_takeover"]) {
      assert.ok(taskNames.has(name), `task catalog must include ${name}`);
    }
    const askCatalog = await server.handleRequest("GET", "/v1/tools?agent=assistant&mode=ask");
    const askTools = askCatalog.body as Array<{ name: string; readOnly: boolean }>;
    assert.ok(askTools.some((tool) => tool.name === "ask_user"));
    assert.ok(askTools.every((tool) => tool.readOnly || tool.name === "ask_user"));
  } finally {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live-browser viewport mapping handles letterbox and pillarbox areas", () => {
  assert.deepEqual(mapFramePointToViewport(640, 400, { left: 0, top: 0, width: 1280, height: 800 }, 1280, 800), { x: 640, y: 400 });
  assert.deepEqual(mapFramePointToViewport(800, 400, { left: 0, top: 0, width: 1600, height: 800 }, 1280, 800), { x: 640, y: 400 });
  assert.equal(mapFramePointToViewport(50, 400, { left: 0, top: 0, width: 1600, height: 800 }, 1280, 800), null);
  assert.deepEqual(mapFramePointToViewport(400, 400, { left: 0, top: 0, width: 800, height: 800 }, 1280, 800), { x: 640, y: 400 });
  assert.equal(mapFramePointToViewport(400, 50, { left: 0, top: 0, width: 800, height: 800 }, 1280, 800), null);
});

test("browser worker preserves active screencast state and never resets scroll after input", () => {
  const worker = fs.readFileSync(path.resolve("packages/sandboxd/browser-worker.mjs"), "utf8");
  assert.doesNotMatch(worker, /await dispatchInput\(\{\s*kind:\s*["']scrollTo["'],\s*y:\s*0\s*\}\)/);
  assert.match(worker, /const internalPages = new WeakSet\(\)/);
  assert.match(worker, /suppressPageSwitchCount\+\+/);
  assert.match(worker, /internalPages\.has\(nextPage\)/);
  assert.match(worker, /stopCast\(\{ preserveDesired: true \}\)/);
  assert.match(worker, /if \(resumeCast\) await startCast\(resumeQuality\)/);
  assert.match(worker, /emit\("page", \{ url: page\.url\(\), title:/);
});
