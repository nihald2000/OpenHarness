import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InProcessEventBus, LocalStateStore } from "../packages/core/src/infra/index.ts";
import { createInitialRunState, runStep } from "../packages/core/src/agent/engine.ts";

test("Ask mode completes a model turn without provisioning a sandbox", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-ask-no-sandbox-"));
  const stateStore = new LocalStateStore({ dataDir });
  const eventBus = new InProcessEventBus();
  let sandboxRequests = 0;

  await stateStore.saveSession("default", {
    id: "session-ask",
    title: "Ask without sandbox",
    agent: "assistant",
    model: "provider/model",
    runtime: "modal",
    status: "running",
    updatedAt: Date.now(),
  });

  const state = createInitialRunState({
    runId: "run-ask",
    sessionId: "session-ask",
    tenantId: "default",
    model: "provider/model",
    runtime: "modal",
    mode: "ask",
    phase: "building",
  });
  const result = await runStep(state, {
    clock: { now: () => Date.now(), sleep: async () => {} },
    stateStore,
    eventBus,
    workspaceRoot: dataDir,
    contextManager: {
      prepareTurnContext: async (_state, messages) => ({
        systemPrompt: "Answer the user's question.",
        messages,
        estimatedTokens: 10,
        events: [],
      }),
      handleContextOverflow: async (_state, messages) => messages,
    },
    provider: {
      generateTurn: async () => ({
        text: "The answer works without a sandbox.",
        toolCalls: [],
        usage: { input: 10, output: 8 },
      }),
    },
    toolRouter: {
      listTools: () => [],
      getTool: () => undefined,
      executeTool: async () => ({ output: null }),
    },
    policyGate: {
      evaluateToolCall: async () => ({ action: "allow", risk: "low" }),
      recordPermissionReply: async () => {},
    },
    ensureSandbox: async () => {
      sandboxRequests += 1;
      throw new Error("sandbox should not be requested in Ask mode");
    },
  } as any);

  assert.equal(sandboxRequests, 0);
  assert.equal(result.state.phase, "completed");
  const { messages } = await stateStore.getMessages("default", "session-ask");
  assert.ok(messages.some((message) =>
    message.parts.some((part) => part.type === "text" && part.text.includes("works without a sandbox"))
  ));
});
