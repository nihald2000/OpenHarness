import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInitialRunState } from "../packages/core/src/agent/engine.ts";
import { OpenHarnessServer } from "../packages/server/src/server.ts";

test("Ask mode starts in the building phase", () => {
  assert.equal(
    createInitialRunState({ runId: "ask-phase", sessionId: "ask-session", mode: "ask" }).phase,
    "building"
  );
  assert.equal(
    createInitialRunState({ runId: "task-phase", sessionId: "task-session", mode: "task" }).phase,
    "planning"
  );
});

test("async session prompts register with DurableRunWorker and return 202", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-async-prompt-"));
  const server = new OpenHarnessServer({
    dataDir,
    workspaceRoot: dataDir,
    defaultModel: "mock/demo",
  });
  let modelTurn = 0;
  server.deps.provider.generateTurn = async () => {
    modelTurn++;
    if (modelTurn === 1) {
      return {
        text: "I need one clarification.",
        toolCalls: [
          {
            id: "ask-async-question",
            name: "ask_user",
            arguments: { question: "Which framework?", options: ["React", "Vue"] },
          },
        ],
      };
    }
    return { text: "Using React.", toolCalls: [] };
  };
  let activeRunId: string | undefined;

  try {
    const created = await server.handleRequest("POST", "/v1/sessions", {}, { title: "Async ask" });
    assert.equal(created.status, 201);
    const session = created.body as { id: string };

    const response = await server.handleRequest(
      "POST",
      `/v1/sessions/${encodeURIComponent(session.id)}/prompt`,
      {},
      { text: "Build a web app", mode: "ask", async: true, clientTurnId: "turn-async-1" }
    );

    assert.equal(response.status, 202);
    const result = response.body as { messageId: string; runId: string };
    activeRunId = result.runId;
    assert.ok(result.messageId);
    const run = await server.runWorker.getRun(result.runId);
    assert.ok(run);
    assert.equal(run?.mode, "ask");
    assert.equal(await server.jobQueue.getJobByRunId(result.runId), null);

    for (let i = 0; i < 100; i++) {
      const current = await server.runWorker.getRun(result.runId);
      if (current?.status === "awaiting_input" || current?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const waitingRun = await server.runWorker.getRun(result.runId);
    assert.equal(waitingRun?.status, "awaiting_input", JSON.stringify(waitingRun?.diagnostic));

    const pending = await server.handleRequest(
      "GET",
      `/v1/sessions/${encodeURIComponent(session.id)}/pending`
    );
    assert.equal((pending.body as { pendingQuestion?: { question: string } }).pendingQuestion?.question, "Which framework?");

    const listedRuns = await server.handleRequest("GET", "/v1/runs");
    assert.ok((listedRuns.body as { runs: Array<{ id: string }> }).runs.some((item) => item.id === result.runId));

    const answer = await server.handleRequest(
      "POST",
      `/v1/runs/${encodeURIComponent(result.runId)}/answer`,
      {},
      { answer: "React" }
    );
    assert.equal(answer.status, 200);

    for (let i = 0; i < 100; i++) {
      const current = await server.runWorker.getRun(result.runId);
      if (current?.status === "completed" || current?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await server.runWorker.getRun(result.runId))?.status, "completed");
    assert.equal(modelTurn, 2);
  } finally {
    if (activeRunId) await server.runWorker.cancelRun(activeRunId).catch(() => null);
    await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
