import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createInitialRunState,
  InProcessEventBus,
  LayeredContextManager,
  LocalStateStore,
  ModelAgnosticProviderAdapter,
  RiskPolicyGate,
  runToStopOrWait,
  StandardToolRouter,
} from "../packages/core/src/index.ts";

test("Step 3 (M3, M4, H9): verification failure injects condensedError into transcript, model fixes on next turn, and repeated failure signature stops loop with toolsDisabled", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-fixloop-ws-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-fixloop-data-"));
  fs.writeFileSync(path.join(workspaceDir, "math.js"), "export const add = (a, b) => a - b;\n", "utf8");

  const store = new LocalStateStore({ dataDir });
  const bus = new InProcessEventBus();
  await store.saveSession("default", {
    id: "sess_fix_1",
    title: "Fix math",
    agent: "assistant",
    model: "gpt-4o",
    status: "running",
    updatedAt: Date.now(),
  });

  let verifyCount = 0;
  let sawVerificationFailureInMessages = false;

  const provider = new ModelAgnosticProviderAdapter({
    transport: async (payload) => {
      const msgs = payload.messages ?? [];
      const allContent = JSON.stringify(msgs);
      if (allContent.includes("AssertionError: expected 5 got -1")) {
        sawVerificationFailureInMessages = true;
      }
      return {
        text: sawVerificationFailureInMessages ? "Fixed add function." : "Initial attempt.",
        tool_calls: [],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      };
    },
  });

  const deps = {
    clock: { now: () => Date.now(), sleep: async () => {} },
    stateStore: store,
    eventBus: bus,
    provider,
    toolRouter: new StandardToolRouter({ workspaceRoot: workspaceDir, sandboxEnabled: true }),
    policyGate: new RiskPolicyGate({ osEnforcedSandbox: true, defaultConfirmationPolicy: "never" }),
    contextManager: new LayeredContextManager({ workspaceRoot: workspaceDir }),
    workspaceRoot: workspaceDir,
    onRunVerification: async () => {
      verifyCount += 1;
      if (verifyCount === 1) {
        return {
          passed: false,
          signature: "sig_fail_1",
          condensedError: "AssertionError: expected 5 got -1",
          results: [
            {
              name: "test",
              command: "npm test",
              passed: false,
              exitCode: 1,
              output: "AssertionError: expected 5 got -1",
            },
          ],
        };
      }
      return {
        passed: true,
        signature: "pass",
        condensedError: "",
        results: [{ name: "test", command: "npm test", passed: true, exitCode: 0, output: "OK" }],
      };
    },
  };

  const initState = createInitialRunState({
    runId: "run_fix_1",
    sessionId: "sess_fix_1",
    model: "gpt-4o",
    mode: "task",
    phase: "building",
  });

  const { state: doneState } = await runToStopOrWait(initState, deps);
  assert.equal(sawVerificationFailureInMessages, true, "Model must receive verification failure message (M3)");
  assert.equal(doneState.phase, "completed");
  assert.equal(doneState.verificationPassed, true);

  // Now test convergence guard: two identical failure signatures disable tools and end run cleanly
  let turnToolsLengths: number[] = [];
  const stuckProvider = new ModelAgnosticProviderAdapter({
    transport: async (payload) => {
      turnToolsLengths.push((payload.tools ?? []).length);
      return {
        text: "Still trying or explaining.",
        tool_calls: [],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      };
    },
  });

  const stuckDeps = {
    ...deps,
    provider: stuckProvider,
    onRunVerification: async () => ({
      passed: false,
      signature: "same_sig",
      condensedError: "Same error every time",
      results: [{ name: "test", command: "npm test", passed: false, exitCode: 1, output: "Same error every time" }],
    }),
  };

  const stuckInit = createInitialRunState({
    runId: "run_fix_stuck",
    sessionId: "sess_fix_1",
    model: "gpt-4o",
    mode: "task",
    phase: "building",
  });

  const { state: stuckFinal } = await runToStopOrWait(stuckInit, stuckDeps);
  assert.equal(stuckFinal.phase, "completed");
  assert.equal(stuckFinal.verifyFailures.length, 2, "Must stop after 2 identical failure signatures");
  assert.equal(turnToolsLengths[turnToolsLengths.length - 1], 0, "Final wrap-up turn must have tools disabled");
});
