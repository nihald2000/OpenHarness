import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InProcessEventBus,
  InProcessJobQueue,
  LocalStateStore,
  DurableWorker,
} from "../packages/core/src/infra/index.ts";
import {
  createInitialRunState,
  persistStepCheckpoint,
  runStep,
} from "../packages/core/src/agent/engine.ts";
import { mapPhaseToSessionStatus } from "../packages/core/src/agent/phases.ts";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oh-phase-a-"));
}

test("Phase A.1: mapPhaseToSessionStatus maps all RunPhases onto legacy RunStatus values", () => {
  assert.equal(mapPhaseToSessionStatus("planning"), "running");
  assert.equal(mapPhaseToSessionStatus("building"), "running");
  assert.equal(mapPhaseToSessionStatus("testing"), "verifying");
  assert.equal(mapPhaseToSessionStatus("fixing"), "running");
  assert.equal(mapPhaseToSessionStatus("reviewing"), "running");
  assert.equal(mapPhaseToSessionStatus("awaiting_permission"), "awaiting_permission");
  assert.equal(mapPhaseToSessionStatus("paused"), "idle");
  assert.equal(mapPhaseToSessionStatus("stuck"), "idle");
  assert.equal(mapPhaseToSessionStatus("completed"), "completed");
  assert.equal(mapPhaseToSessionStatus("failed"), "failed");
  assert.equal(mapPhaseToSessionStatus("cancelled"), "cancelled");
});

test("Phase A.2: mid-run restart resumes from last step checkpoint without re-executing non-idempotent tool calls or duplicating SSE events", async () => {
  const dataDir = makeTempDir();
  let nonIdempotentExecCount = 0;
  let idempotentExecCount = 0;

  const makeDeps = (store, bus) => ({
    clock: {
      now: () => Date.now(),
      sleep: async () => {},
    },
    stateStore: store,
    eventBus: bus,
    workspaceRoot: dataDir,
    contextManager: {
      prepareTurnContext: async (_state, messages) => ({
        systemPrompt: "System prompt",
        messages,
        estimatedTokens: 100,
        events: [],
      }),
      handleContextOverflow: async (_state, messages) => messages,
    },
    policyGate: {
      evaluateToolCall: async () => ({ action: "allow", risk: "low" }),
      recordPermissionReply: async () => {},
    },
    toolRouter: {
      listTools: () => [
        {
          name: "write_file",
          description: "Non-idempotent write",
          readOnly: false,
          idempotent: false,
          parameters: { type: "object" },
          execute: async () => {
            nonIdempotentExecCount += 1;
            return { output: "written" };
          },
        },
        {
          name: "read_file",
          description: "Idempotent read",
          readOnly: true,
          idempotent: true,
          parameters: { type: "object" },
          execute: async () => {
            idempotentExecCount += 1;
            return { output: "file contents" };
          },
        },
      ],
      getTool: (name) => {
        if (name === "write_file") {
          return {
            name: "write_file",
            description: "Non-idempotent write",
            readOnly: false,
            idempotent: false,
            parameters: { type: "object" },
            execute: async () => {
              nonIdempotentExecCount += 1;
              return { output: "written" };
            },
          };
        }
        if (name === "read_file") {
          return {
            name: "read_file",
            description: "Idempotent read",
            readOnly: true,
            idempotent: true,
            parameters: { type: "object" },
            execute: async () => {
              idempotentExecCount += 1;
              return { output: "file contents" };
            },
          };
        }
        return undefined;
      },
      executeTool: async (_callId, name, _input) => {
        if (name === "write_file") {
          nonIdempotentExecCount += 1;
          return { output: "written" };
        }
        idempotentExecCount += 1;
        return { output: "file contents" };
      },
    },
    provider: {
      generateTurn: async (req) => {
        // First turn calls write_file; second turn finishes
        const assistantMsgs = req.messages.filter((m) => m.info.role === "assistant");
        if (assistantMsgs.length === 0) {
          return {
            text: "Writing file...",
            toolCalls: [{ id: "call_write_1", name: "write_file", arguments: { path: "a.txt" } }],
            usage: { input: 50, output: 20 },
          };
        }
        return {
          text: "All done!",
          toolCalls: [],
          usage: { input: 60, output: 15 },
        };
      },
    },
  });

  // --- Worker 1 runs Step 1 and crashes before Step 2 ---
  const store1 = new LocalStateStore({ dataDir });
  const bus1 = new InProcessEventBus();
  const deps1 = makeDeps(store1, bus1);

  await store1.saveSession("default", {
    id: "sess-1",
    title: "Test",
    agent: "assistant",
    status: "running",
    updatedAt: Date.now(),
  });

  const initialState = createInitialRunState({
    runId: "run-1",
    sessionId: "sess-1",
    tenantId: "default",
    mode: "chat",
  });

  // Execute step 1 (calls write_file)
  const step1 = await runStep(initialState, deps1);
  assert.equal(nonIdempotentExecCount, 1);
  assert.equal(step1.state.iteration, 1);
  assert.ok(step1.state.completedToolCalls["call_write_1"]);

  // Simulate an in-flight non-idempotent tool call AND an in-flight idempotent tool call when Worker 1 dies
  const crashingState = structuredClone(step1.state);
  crashingState.inFlightToolCalls = [
    {
      callId: "call_inflight_non_idem",
      tool: "write_file",
      input: { path: "b.txt" },
      idempotent: false,
      startedAt: Date.now() - 500,
      partialOutput: "partial write log",
    },
    {
      callId: "call_inflight_idem",
      tool: "read_file",
      input: { path: "a.txt" },
      idempotent: true,
      startedAt: Date.now() - 400,
    },
  ];
  await persistStepCheckpoint(deps1, crashingState);
  const seqBeforeRestart = await store1.getLastSeq("default", "sess-1");
  assert.ok(seqBeforeRestart > 0);

  // --- Simulate Process Restart: Worker 2 loads from disk ---
  const store2 = new LocalStateStore({ dataDir });
  const bus2 = new InProcessEventBus();
  const queue2 = new InProcessJobQueue({ dataDir });
  const deps2 = makeDeps(store2, bus2);
  const worker2 = new DurableWorker(queue2, deps2);

  await queue2.enqueue({
    id: "job-1",
    runId: "run-1",
    sessionId: "sess-1",
    tenantId: "default",
    prompt: "Finish work",
    agent: "assistant",
    model: "mock/demo",
    mode: "chat",
  });

  const res2 = await worker2.processNextJob();
  assert.ok(res2.state);
  assert.equal(res2.state.phase, "completed");

  // Non-idempotent write_file was NOT re-executed on restart (stayed at 1!)
  assert.equal(nonIdempotentExecCount, 1);
  // Idempotent read_file WAS re-executed on restart (incremented to 1!)
  assert.equal(idempotentExecCount, 1);
  // In-flight non-idempotent call was marked as interrupted with partial output
  assert.equal(res2.state.completedToolCalls["call_inflight_non_idem"]?.state, "interrupted");
  assert.match(res2.state.completedToolCalls["call_inflight_non_idem"]?.error ?? "", /partial write log/);

  // Verify SSE sequence IDs are strictly monotonic across restart with no gaps or duplicates
  const allEvents = await store2.listEventsAfter("default", 0, "sess-1");
  for (let i = 0; i < allEvents.length; i++) {
    assert.equal(allEvents[i].seq, i + 1);
  }
  assert.ok(allEvents.length > seqBeforeRestart);
});
