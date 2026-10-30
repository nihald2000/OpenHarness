import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenHarnessServer } from "../packages/server/src/server.ts";
import {
  LocalSandboxProvider,
  ManagedDaemonSandboxProvider,
  type SandboxProvider,
} from "../packages/core/src/index.ts";

test("Step 8 (R4, R5, S3, S4, S8): task run on local fails closed without allowUnsandboxedAutonomy; /v1/runtimes reports honest health; task run on sandboxed daemon creates real shadow-git checkpoint, runs verification + reviewer, and rewinds with 404/409/200 validation", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-step8-ws-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-step8-data-"));

  // Seed a sample repo file and a simple passing verification command in .openharness/verify.json
  fs.mkdirSync(path.join(workspaceDir, ".openharness"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, ".openharness", "verify.json"),
    JSON.stringify({ commands: ["test -f app.txt"] }),
    "utf8"
  );
  fs.writeFileSync(path.join(workspaceDir, "app.txt"), "initial-v1\n", "utf8");

  // 1. Server with default (fail-closed) settings
  const server = new OpenHarnessServer({
    dataDir,
    workspaceRoot: workspaceDir,
  });

  // (a) GET /v1/runtimes reports honest health: local is active with osEnforced: false; modal without tokens is active: false with detail
  const runtimesRes = await server.handleRequest("GET", "/v1/runtimes");
  assert.equal(runtimesRes.status, 200);
  const runtimes = runtimesRes.body as Array<{
    id: string;
    active: boolean;
    detail?: string;
    capabilities: { osEnforced: boolean };
  }>;
  const localRt = runtimes.find((r) => r.id === "local")!;
  assert.equal(localRt.active, true);
  assert.equal(localRt.capabilities.osEnforced, false);

  const modalRt = runtimes.find((r) => r.id === "modal")!;
  if (!process.env.MODAL_TOKEN_ID) {
    assert.equal(modalRt.active, false);
    assert.match(String(modalRt.detail), /MODAL_TOKEN_ID/);
  }

  // (b) A `task` run on `local` without `allowUnsandboxedAutonomy: true` fails closed
  const localSessRes = await server.handleRequest(
    "POST",
    "/v1/sessions",
    {},
    { title: "Local Task Fail-Closed", runtime: "local", mode: "task" }
  );
  assert.equal(localSessRes.status, 201);
  const localSessId = (localSessRes.body as { id: string }).id;

  const localPromptRes = await server.handleRequest(
    "POST",
    `/v1/sessions/${localSessId}/prompt`,
    {},
    { text: "Run autonomous task on local", mode: "task" }
  );
  assert.equal(localPromptRes.status, 202);
  const localRunId = (localPromptRes.body as { runId: string }).runId;

  const failedRunRes = await server.handleRequest("GET", `/v1/runs/${localRunId}`);
  assert.equal(failedRunRes.status, 200);
  const failedRun = failedRunRes.body as { status: string; error?: string };
  assert.equal(failedRun.status, "failed");
  assert.match(String(failedRun.error), /task mode requires a sandboxed runtime/);

  // (c) Rewind with unknown SHA returns 404; rewind with `files: true` and no sandbox returns 409
  const unknownRewind = await server.handleRequest(
    "POST",
    `/v1/sessions/${localSessId}/rewind`,
    {},
    { checkpoint: "nonexistent_sha_0000" }
  );
  assert.equal(unknownRewind.status, 404);

  await server.stateStore.saveCheckpointInfo("default", localSessId, {
    sha: "deadbeef1234567890",
    message: "Manual checkpoint without sandbox",
    createdAt: Date.now(),
    sessionId: localSessId,
  });

  const noSandboxFilesRewind = await server.handleRequest(
    "POST",
    `/v1/sessions/${localSessId}/rewind`,
    {},
    { checkpoint: "deadbeef1234567890", files: true }
  );
  assert.equal(noSandboxFilesRewind.status, 409);

  // 2. Task run with a sandboxed provider (in-process oh-sandboxd) and scripted tool call:
  //    edits a file, creates a real shadow-git checkpoint, runs verification + reviewer, and completes!
  const sandboxProviders = new Map<string, SandboxProvider>([
    ["local", new LocalSandboxProvider()],
    ["docker", new ManagedDaemonSandboxProvider("docker")],
  ]);

  const sbServer = new OpenHarnessServer({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "oh-step8-sbdata-")),
    workspaceRoot: workspaceDir,
    defaultRuntime: "docker",
    osEnforcedSandbox: true,
    providers: sandboxProviders,
  });

  // Override provider.generateTurn to emit a plan -> write_file("app.txt", "updated-v2\n") -> final summary
  let turnNum = 0;
  sbServer.deps.provider.generateTurn = async () => {
    turnNum += 1;
    if (turnNum === 1) {
      return {
        text: "Plan ready",
        toolCalls: [
          {
            id: "call_plan_1",
            name: "update_plan",
            arguments: {
              title: "Update app.txt",
              steps: [{ id: "s1", title: "Write app.txt", status: "completed" }],
            },
          },
        ],
        usage: { input: 20, output: 10 },
      };
    }
    if (turnNum === 2) {
      return {
        text: "Editing app.txt",
        toolCalls: [
          {
            id: "call_write_1",
            name: "write_file",
            arguments: { path: "app.txt", content: "updated-v2\n" },
          },
        ],
        usage: { input: 30, output: 15 },
      };
    }
    return {
      text: "Completed update to app.txt.",
      toolCalls: [],
      usage: { input: 25, output: 12 },
    };
  };

  const sbSessRes = await sbServer.handleRequest(
    "POST",
    "/v1/sessions",
    {},
    { title: "Sandboxed Task Run", runtime: "docker", mode: "task" }
  );
  assert.equal(sbSessRes.status, 201);
  const sbSessId = (sbSessRes.body as { id: string }).id;

  const sbPromptRes = await sbServer.handleRequest(
    "POST",
    `/v1/sessions/${sbSessId}/prompt`,
    {},
    { text: "Update app.txt and verify", mode: "task" }
  );
  assert.equal(sbPromptRes.status, 202);
  const sbRunId = (sbPromptRes.body as { runId: string }).runId;

  const sbRunRes = await sbServer.handleRequest("GET", `/v1/runs/${sbRunId}`);
  assert.equal(sbRunRes.status, 200);
  const sbRun = sbRunRes.body as { status: string; phase: string; lastCheckpoint?: string; sandboxHandleId?: string };
  assert.equal(sbRun.status, "completed");
  assert.equal(sbRun.phase, "completed");
  assert.ok(sbRun.sandboxHandleId);
  assert.ok(sbRun.lastCheckpoint);

  // Verify file was updated to updated-v2
  assert.equal(fs.readFileSync(path.join(workspaceDir, "app.txt"), "utf8"), "updated-v2\n");

  // Verify checkpoints were recorded in stateStore from oh-sandboxd shadow-git
  const cpsRes = await sbServer.handleRequest("GET", `/v1/sessions/${sbSessId}/checkpoints`);
  assert.equal(cpsRes.status, 200);
  const cps = (cpsRes.body as { checkpoints: Array<{ sha: string; message: string }> }).checkpoints;
  assert.ok(cps.length >= 2);
  const preWriteCp = cps[0]!;
  assert.ok(preWriteCp.sha.length >= 7);

  // Verify /v1/sandboxes lists the recorded sandbox without leaking sessionKeyEnc
  const sbListRes = await sbServer.handleRequest("GET", "/v1/sandboxes");
  assert.equal(sbListRes.status, 200);
  const sbList = (sbListRes.body as { sandboxes: Array<Record<string, unknown>> }).sandboxes;
  assert.ok(sbList.some((s) => s.id === sbRun.sandboxHandleId));
  assert.equal(sbList[0]?.sessionKeyEnc, undefined);

  // Rewind to the pre-edit checkpoint SHA with files: true -> restores app.txt to "initial-v1\n"!
  const rewindValid = await sbServer.handleRequest(
    "POST",
    `/v1/sessions/${sbSessId}/rewind`,
    {},
    { checkpoint: preWriteCp.sha, files: true }
  );
  assert.equal(rewindValid.status, 200);
  assert.equal(fs.readFileSync(path.join(workspaceDir, "app.txt"), "utf8"), "initial-v1\n");
});
