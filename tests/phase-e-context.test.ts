import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInitialRunState } from "../packages/core/src/agent/engine.ts";
import { LayeredContextManager } from "../packages/core/src/context/index.ts";

test("Phase E Acceptance: scripted 300-step run with a 32K-context mock model completes without overflow; summary contains current feature, files, and next move; cleared tool outputs remain retrievable from disk; precomputed summary is used when available", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-phase-e-ws-"));
  const contextWindow = 32_000;

  let summarizerCallCount = 0;
  const ctxManager = new LayeredContextManager({
    contextWindow,
    clearAfterTurns: 6,
    recitationEveryTurns: 8,
    keepRecentTokens: 4_000,
    workspaceRoot: workspaceDir,
    summarizer: async (_shortened, state) => {
      summarizerCallCount += 1;
      return `Precomputed LLM summary at step ${state.iteration} for feature ${state.featureId}`;
    },
  });

  const state = createInitialRunState({
    runId: "run_e_300",
    sessionId: "sess_e_300",
    mode: "long_task",
    phase: "building",
  });
  state.featureId = "feat-auth-token";
  state.features = [
    {
      id: "feat-auth-token",
      title: "JWT Token Validation",
      description: "Validate bearer tokens",
      acceptance: ["Rejects invalid JWT"],
      verification: ["npm test"],
      status: "in_progress",
      attempts: 1,
    },
  ];
  state.todos = [
    {
      id: "todo-1",
      content: "Implement verifyJwt in src/auth/jwt.ts",
      status: "in_progress",
    },
  ];

  let transcript = [
    {
      info: { id: "msg-u-0", role: "user" as const },
      createdAt: Date.now(),
      parts: [
        {
          type: "text" as const,
          text: "Implement JWT token validation in src/auth/jwt.ts and verify all tests pass.",
        },
      ],
    },
  ];

  let compactionsTriggered = 0;
  let precomputedUsedCount = 0;
  const firstPrefix = ctxManager.buildStableSystemPrompt(state);

  // Run 300 steps with a 32K context window
  for (let step = 1; step <= 300; step++) {
    state.iteration = step;
    const hadPrecomputeBefore = Boolean((ctxManager as unknown as { precomputed: unknown }).precomputed);

    const prepared = await ctxManager.prepareTurnContext(state, transcript);
    // Prefix must remain byte-identical across turns
    assert.equal(prepared.systemPrompt, firstPrefix);
    // Must NEVER overflow the 32K context window
    assert.ok(
      prepared.estimatedTokens < contextWindow,
      `Step ${step} overflowed 32K window: ${prepared.estimatedTokens}`
    );

    if (prepared.compacted) {
      compactionsTriggered += 1;
      if (hadPrecomputeBefore) {
        precomputedUsedCount += 1;
      }
      // Keep compacted transcript moving forward
      transcript = prepared.messages.filter((m) => !m.parts.some((p) => p.type === "text" && p.synthetic));
    } else {
      transcript = prepared.messages.filter((m) => !m.parts.some((p) => p.type === "text" && p.synthetic));
    }

    // Append simulated assistant turn with tool output (~600 chars each step)
    const callId = `call_step_${step}`;
    const toolOutputText = `Step ${step} file inspection of src/auth/jwt.ts:\n` + "export const tokenCheck = true;\n".repeat(18);
    transcript.push({
      info: { id: `msg-a-${step}`, role: "assistant" as const },
      createdAt: Date.now(),
      parts: [
        {
          type: "text" as const,
          text: `Decided to update src/auth/jwt.ts at step ${step}. ` + " Verified token claims, issuer, audience, and clock skew handling across middleware layers.".repeat(4),
        },
        {
          type: "tool" as const,
          tool: "read_file",
          callId,
          state: "completed" as const,
          input: { path: "src/auth/jwt.ts" },
          output: toolOutputText,
        },
      ],
    });
  }

  assert.ok(compactionsTriggered >= 2, `Expected multiple compactions over 300 steps, got ${compactionsTriggered}`);
  assert.ok(precomputedUsedCount >= 1, "Expected background precomputed summary to be used when available");
  assert.ok(summarizerCallCount >= 2);

  // Verify the compaction summary contains the current feature, relevant files, and next move
  const summaryMsg = transcript.find((m) => m.info.summary && m.parts.some((p) => p.type === "compaction"));
  assert.ok(summaryMsg, "Expected compaction summary message in transcript");
  const compPart = summaryMsg.parts.find((p) => p.type === "compaction");
  assert.ok(compPart && compPart.type === "compaction");
  assert.match(compPart.summary, /feat-auth-token/);
  assert.match(compPart.summary, /src\/auth\/jwt\.ts/);
  assert.match(compPart.summary, /Implement verifyJwt in src\/auth\/jwt\.ts/);

  // Verify cleared tool outputs remain retrievable from disk (.openharness/outputs/<callId>.txt)
  const step1SpillFile = path.join(workspaceDir, ".openharness", "outputs", "call_step_1.txt");
  assert.ok(fs.existsSync(step1SpillFile), "Cleared tool output should remain on disk");
  const diskContent = fs.readFileSync(step1SpillFile, "utf8");
  assert.match(diskContent, /Step 1 file inspection of src\/auth\/jwt\.ts/);
});
