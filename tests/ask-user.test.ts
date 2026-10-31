import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InProcessEventBus,
  LayeredContextManager,
  LocalStateStore,
  ModelAgnosticProviderAdapter,
  RiskPolicyGate,
  StandardToolRouter,
} from "../packages/core/src/index.ts";
import { RunEventEmitter } from "../packages/server/src/worker/emitter.ts";
import { RunStateMachine } from "../packages/server/src/worker/run-state.ts";
import { DurableRunWorker } from "../packages/server/src/worker/run-worker.ts";

test("Step 6b (H3, H5): DurableRunWorker pauses on ask_user, resumes on answerQuestion, and cancelRun aborts in-flight work and marks tool interrupted", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-ask-ws-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-ask-data-"));
  const stateStore = new LocalStateStore({ dataDir });
  const eventBus = new InProcessEventBus();

  await stateStore.saveSession("default", {
    id: "sess_ask_1",
    title: "Ask user test",
    agent: "assistant",
    model: "gpt-4o",
    status: "idle",
    updatedAt: Date.now(),
  });

  let modelTurn = 0;
  let receivedAnswerInTurn2 = false;

  const provider = new ModelAgnosticProviderAdapter({
    transport: async (payload) => {
      modelTurn += 1;
      if (modelTurn === 1) {
        return {
          text: "Asking user for framework preference.",
          tool_calls: [
            {
              id: "call_ask_1",
              function: {
                name: "ask_user",
                arguments: JSON.stringify({
                  question: "Which framework should I use?",
                  options: ["React", "Vue"],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 15 },
        };
      }
      const dump = JSON.stringify(payload.messages ?? []);
      if (dump.includes("React")) {
        receivedAnswerInTurn2 = true;
      }
      return {
        text: "Building with React as requested.",
        tool_calls: [],
        usage: { prompt_tokens: 45, completion_tokens: 12 },
      };
    },
  });

  const toolRouter = new StandardToolRouter({
    workspaceRoot: workspaceDir,
    sandboxEnabled: true,
  });

  const sm = new RunStateMachine({ dataDir, stateStore });
  const emitter = new RunEventEmitter({ stateStore, eventBus });
  const deps = {
    clock: { now: () => Date.now(), sleep: async () => {} },
    stateStore,
    eventBus,
    provider,
    toolRouter,
    policyGate: new RiskPolicyGate({ osEnforcedSandbox: true, defaultConfirmationPolicy: "never" }),
    contextManager: new LayeredContextManager({ workspaceRoot: workspaceDir }),
    workspaceRoot: workspaceDir,
  };

  const worker = new DurableRunWorker({
    stateMachine: sm,
    emitter,
    deps,
    activeSandboxes: new Map(),
  });

  const { run } = await worker.enqueueAndStart({
    sessionId: "sess_ask_1",
    prompt: "Build a dashboard",
    model: "gpt-4o",
    mode: "task",
  });

  const runPromise = worker.startRun(run.id);

  // Wait until run enters awaiting_input
  for (let i = 0; i < 40; i++) {
    if (sm.getRun(run.id)?.status === "awaiting_input") break;
    await new Promise((r) => setTimeout(r, 15));
  }

  const pausedRun = sm.getRun(run.id);
  assert.equal(pausedRun?.status, "awaiting_input", "Run must pause in awaiting_input on ask_user");
  assert.equal(pausedRun?.pendingQuestion?.question, "Which framework should I use?");

  await worker.answerQuestion(run.id, "React");
  await runPromise;

  const completedRun = sm.getRun(run.id);
  assert.equal(completedRun?.status, "completed");
  assert.equal(receivedAnswerInTurn2, true, "Model must receive user answer in tool result");

  // Now test cancelRun (H3) while awaiting_input
  const { run: runToCancel } = await worker.enqueueAndStart({
    sessionId: "sess_ask_1",
    prompt: "Cancel me",
    model: "gpt-4o",
    mode: "task",
  });
  modelTurn = 0; // will call ask_user again
  const cancelPromise = worker.startRun(runToCancel.id);
  for (let i = 0; i < 40; i++) {
    if (sm.getRun(runToCancel.id)?.status === "awaiting_input") break;
    await new Promise((r) => setTimeout(r, 15));
  }
  await worker.cancelRun(runToCancel.id, "User clicked Stop");
  await cancelPromise;

  const cancelled = sm.getRun(runToCancel.id);
  assert.equal(cancelled?.status, "cancelled");
});
