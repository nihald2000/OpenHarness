import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalStateStore } from "../packages/core/src/index.ts";
import { RunStateMachine } from "../packages/server/src/worker/run-state.ts";

test("Step 6b (H1, H10): RunStateMachine enforces one active run per session, deduplicates clientTurnId, freezes snapshot, and validates compare-and-set transitions", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-runstate-"));
  const stateStore = new LocalStateStore({ dataDir });
  await stateStore.saveSession("default", {
    id: "sess_1",
    title: "Test",
    agent: "assistant",
    model: "gpt-4o",
    status: "idle",
    updatedAt: Date.now(),
  });

  const sm = new RunStateMachine({ dataDir, stateStore });

  // 1. Create run and verify frozen snapshot (H10)
  const { run: run1, deduplicated: dedup1 } = await sm.createRun({
    sessionId: "sess_1",
    prompt: "Build counter app",
    model: "gpt-4o",
    clientTurnId: "turn_abc",
    tools: ["read_file", "write_file"],
  });
  assert.equal(dedup1, false);
  assert.equal(run1.status, "queued");
  assert.equal(run1.snapshot.model, "gpt-4o");
  assert.equal(run1.snapshot.promptVersion, "coding-agent@1");
  assert.deepEqual(run1.snapshot.tools, ["read_file", "write_file"]);

  // 2. Duplicate submit with same clientTurnId returns existing run (H1)
  const { run: run1Dup, deduplicated: dedup2 } = await sm.createRun({
    sessionId: "sess_1",
    prompt: "Build counter app",
    model: "gpt-4o",
    clientTurnId: "turn_abc",
  });
  assert.equal(dedup2, true);
  assert.equal(run1Dup.id, run1.id);

  // 3. Concurrent submit with different clientTurnId on active session is rejected with 409 (H1)
  await assert.rejects(
    () =>
      sm.createRun({
        sessionId: "sess_1",
        prompt: "Another prompt while active",
        model: "gpt-4o",
        clientTurnId: "turn_xyz",
      }),
    /already has an active run/
  );

  // 4. Compare-and-set transitions
  const badFrom = await sm.transition(run1.id, "running", "completed");
  assert.equal(badFrom.ok, false, "Must reject CAS when expectedFrom does not match queued");

  const toRunning = await sm.transition(run1.id, "queued", "running");
  assert.equal(toRunning.ok, true);
  assert.equal(toRunning.run?.status, "running");

  const toCompleted = await sm.transition(run1.id, "running", "completed");
  assert.equal(toCompleted.ok, true);

  const sessionAfter = await stateStore.getSession("default", "sess_1");
  assert.equal(sessionAfter?.activeRunId, null, "Terminal transition must clear session.activeRunId");

  const fromTerminal = await sm.transition(run1.id, "completed", "running");
  assert.equal(fromTerminal.ok, false, "Terminal status must not transition back to running");
});
