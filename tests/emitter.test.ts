import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenHarnessEvent } from "@openharness/sdk";
import { InProcessEventBus, LocalStateStore } from "../packages/core/src/index.ts";
import { RunEventEmitter } from "../packages/server/src/worker/emitter.ts";

test("Step 6b (H2): RunEventEmitter persists monotonic per-session seq, updates session.lastSeq, and batches streaming deltas without persisting each token to disk", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-emitter-"));
  const stateStore = new LocalStateStore({ dataDir });
  const eventBus = new InProcessEventBus();
  await stateStore.saveSession("default", {
    id: "sess_em_1",
    title: "Emitter test",
    agent: "assistant",
    status: "running",
    updatedAt: Date.now(),
  });

  const emitter = new RunEventEmitter({ stateStore, eventBus, batchWindowMs: 20 });
  const liveEvents: OpenHarnessEvent[] = [];
  eventBus.subscribe({ tenantId: "default", sessionId: "sess_em_1" }, (env) => {
    liveEvents.push(env.event);
  });

  const env1 = await emitter.emit("default", "sess_em_1", {
    type: "run.created",
    sessionId: "sess_em_1",
    runId: "run_1",
  });
  assert.equal(env1.seq, 1);

  // Stream 3 token deltas rapidly; they should batch into a single part.delta broadcast and NOT be written to disk
  emitter.emitDelta("default", "sess_em_1", "Hello ", "msg_1");
  emitter.emitDelta("default", "sess_em_1", "world", "msg_1");
  emitter.emitDelta("default", "sess_em_1", "!", "msg_1");
  await emitter.flushDelta("sess_em_1");

  const deltaEvents = liveEvents.filter((e) => e.type === "part.delta");
  assert.equal(deltaEvents.length, 1);
  assert.equal((deltaEvents[0] as any).delta, "Hello world!");

  const env2 = await emitter.emit("default", "sess_em_1", {
    type: "run.completed",
    sessionId: "sess_em_1",
    runId: "run_1",
  });
  assert.equal(env2.seq, 2, "Deltas must not increment persisted event log seq");

  const session = await stateStore.getSession("default", "sess_em_1");
  assert.equal(session?.lastSeq, 2);

  const persisted = await stateStore.listEventsAfter("default", 0, "sess_em_1");
  assert.equal(persisted.length, 2);
});
