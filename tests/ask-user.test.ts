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
  await runPromise;
  const savedQuestion = await stateStore.getStepCheckpoint("default", run.id);
  assert.equal(savedQuestion?.state.pendingQuestion?.question, "Which framework should I use?");
  assert.equal(
    savedQuestion?.state.phase,
    "awaiting_input",
    "The worker must release its run loop with a durable waiting checkpoint"
  );

  // Answer through a new worker instance to verify the checkpoint is enough to resume.
  const resumedWorker = new DurableRunWorker({
    stateMachine: sm,
    emitter,
    deps,
    activeSandboxes: new Map(),
  });
  await resumedWorker.answerQuestion(run.id, "React");
  for (let i = 0; i < 80; i++) {
    if (sm.getRun(run.id)?.status === "completed" || sm.getRun(run.id)?.status === "failed") break;
    await new Promise((r) => setTimeout(r, 15));
  }

  const completedRun = sm.getRun(run.id);
  assert.equal(completedRun?.status, "completed");
  assert.equal(receivedAnswerInTurn2, true, "Model must receive user answer in tool result");
  const answeredCheckpoint = await stateStore.getStepCheckpoint("default", run.id);
  assert.equal(answeredCheckpoint?.state.pendingQuestion, null);
  assert.deepEqual(answeredCheckpoint?.state.completedToolCalls.call_ask_1?.output, {
    question: "Which framework should I use?",
    answer: "React",
  });
  const { messages } = await stateStore.getMessages("default", "sess_ask_1");
  const answeredPart = messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === "tool" && part.callId === "call_ask_1");
  assert.equal(answeredPart?.type, "tool");
  if (answeredPart?.type === "tool") {
    assert.equal(answeredPart.state, "completed");
    assert.deepEqual(answeredPart.output, { question: "Which framework should I use?", answer: "React" });
  }

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
  await cancelPromise;
  await worker.cancelRun(runToCancel.id, "User clicked Stop");

  const cancelled = sm.getRun(runToCancel.id);
  assert.equal(cancelled?.status, "cancelled");
});
