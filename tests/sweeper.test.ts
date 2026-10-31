import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InProcessEventBus, LocalStateStore } from "../packages/core/src/index.ts";
import { RunEventEmitter } from "../packages/server/src/worker/emitter.ts";
import { RunStateMachine } from "../packages/server/src/worker/run-state.ts";
import { sweepStalledRuns } from "../packages/server/src/worker/sweeper.ts";

test("Step 6b (H4): sweepStalledRuns marks queued-never-started, first-activity timeout, and stalled running runs as failed while sparing awaiting_input", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-sweeper-"));
  const stateStore = new LocalStateStore({ dataDir });
  const eventBus = new InProcessEventBus();
  for (const id of ["s_queued", "s_stalled", "s_waiting"]) {
    await stateStore.saveSession("default", {
      id,
      title: id,
      agent: "assistant",
      status: "running",
      updatedAt: Date.now(),
    });
  }

  const sm = new RunStateMachine({ dataDir, stateStore });
  const emitter = new RunEventEmitter({ stateStore, eventBus });

  const { run: rQueued } = await sm.createRun({
    sessionId: "s_queued",
    prompt: "Queued forever",
    model: "gpt-4o",
  });
  const { run: rStalled } = await sm.createRun({
    sessionId: "s_stalled",
    prompt: "Stalled mid-run",
    model: "gpt-4o",
  });
  await sm.transition(rStalled.id, "queued", "running", {
    firstActivityAt: Date.now(),
  });

  const { run: rWaiting } = await sm.createRun({
    sessionId: "s_waiting",
    prompt: "Waiting on user",
    model: "gpt-4o",
  });
  await sm.transition(rWaiting.id, "queued", "running");
  await sm.transition(rWaiting.id, "running", "awaiting_input");

  const future = Date.now() + 300_000;
  const swept = await sweepStalledRuns(sm, emitter, future, {
    queuedTimeoutMs: 60_000,
    stallTimeoutMs: 180_000,
  });

  const sweptIds = swept.map((r) => r.id);
  assert.equal(sweptIds.includes(rQueued.id), true, "Queued-never-started run must be swept");
  assert.equal(sweptIds.includes(rStalled.id), true, "Stalled running run must be swept");
  assert.equal(sweptIds.includes(rWaiting.id), false, "awaiting_input run must not be swept at 5 minutes");

  assert.equal(sm.getRun(rQueued.id)?.status, "failed");
  assert.equal(sm.getRun(rQueued.id)?.diagnostic?.code, "FIRST_ACTIVITY_TIMEOUT");
  assert.equal(sm.getRun(rStalled.id)?.status, "failed");
  assert.equal(sm.getRun(rStalled.id)?.diagnostic?.code, "RUN_STALLED");
  assert.equal(sm.getRun(rWaiting.id)?.status, "awaiting_input");
});
