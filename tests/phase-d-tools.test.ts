import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInitialRunState } from "../packages/core/src/agent/engine.ts";
import {
  compileSandboxPolicy,
  ManagedDaemonSandboxProvider,
} from "../packages/core/src/sandbox/index.ts";
import {
  enforceToolOutputLimit,
  StandardToolRouter,
} from "../packages/core/src/tools/index.ts";

test("Phase D Acceptance: in a Docker sandbox, agent sets up a Node and Python sample repo, edits files with edit/apply_patch, runs project test suites, starts dev server, takes browser screenshot, and spills >2000-line output to disk", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-phase-d-ws-"));
  const dockerProvider = new ManagedDaemonSandboxProvider("docker");
  const policy = compileSandboxPolicy({
    runId: "run_d_1",
    workspacePath: workspaceDir,
    networkMode: "allowlist",
    presets: ["package-registries", "github-read"],
  });

  const handle = await dockerProvider.create({
    runId: "run_d_1",
    sessionId: "sess_d_1",
    workspace: { type: "bind", hostPath: workspaceDir },
    policy,
  });

  const router = new StandardToolRouter({
    workspaceRoot: handle.workspacePath,
    sandboxEnabled: true,
  });

  const state = createInitialRunState({
    runId: "run_d_1",
    sessionId: "sess_d_1",
    phase: "building",
    sandboxHandleId: handle.id,
  });

  // Verify stable tool list with policy masking ("mask, don't remove")
  const buildingTools = router.listTools(state);
  const planningState = { ...state, phase: "planning" as const };
  const planningTools = router.listTools(planningState);
  assert.equal(buildingTools.length, planningTools.length);
  const bashInPlan = planningTools.find((t) => t.name === "bash");
  assert.equal(bashInPlan?.masked, true);
  const readInPlan = planningTools.find((t) => t.name === "read_file");
  assert.equal(readInPlan?.masked, false);

  const ctx = {
    runId: "run_d_1",
    sessionId: "sess_d_1",
    tenantId: "default",
    workspaceRoot: handle.workspacePath,
    sandboxHandleId: handle.id,
    state,
  };

  // 1. Create a sample Node + Python project inside the sandbox
  await router.executeTool("call_0", "write_file", { path: "package.json", content: JSON.stringify({ name: "sample", type: "module" }) }, ctx);
  await router.executeTool(
    "call_1",
    "write_file",
    {
      path: "math.js",
      content: "export function add(a, b) {\n  return a - b;\n}\n",
    },
    ctx
  );
  await router.executeTool(
    "call_2",
    "write_file",
    {
      path: "calc.py",
      content: "def multiply(a, b):\n    return a + b\n",
    },
    ctx
  );
  await router.executeTool(
    "call_3",
    "write_file",
    {
      path: "test_all.py",
      content:
        "from calc import multiply\nassert multiply(3, 4) == 12, f'Expected 12, got {multiply(3, 4)}'\nprint('PYTHON_TESTS_PASSED')\n",
    },
    ctx
  );

  // 2. Make a multi-file change with `edit` (str_replace) and `apply_patch`
  const editRes = await router.executeTool(
    "call_4",
    "edit",
    {
      command: "str_replace",
      path: "math.js",
      old_str: "return a - b;",
      new_str: "return a + b;",
    },
    ctx
  );
  assert.equal(editRes.error, undefined);
  assert.deepEqual((editRes.output as { diagnostics: string[] }).diagnostics, []);

  const patchRes = await router.executeTool(
    "call_5",
    "apply_patch",
    {
      patch: [
        "*** Begin Patch",
        "*** Update File: calc.py",
        "-    return a + b",
        "+    return a * b",
        "*** End Patch",
      ].join("\n"),
    },
    ctx
  );
  assert.equal(patchRes.error, undefined);

  // 3. Run the project's Node and Python test suites via `bash`
  const bashTestRes = await router.executeTool(
    "call_6",
    "bash",
    {
      command:
        "node --input-type=module -e \"import { add } from './math.js'; if (add(2, 3) !== 5) process.exit(1); console.log('NODE_TESTS_PASSED');\" && python3 test_all.py",
    },
    ctx
  );
  assert.equal(bashTestRes.error, undefined);
  assert.match(String((bashTestRes.output as { output: string }).output), /NODE_TESTS_PASSED/);
  assert.match(String((bashTestRes.output as { output: string }).output), /PYTHON_TESTS_PASSED/);

  // 4. Start dev server via `process_start`, get `preview_url`, navigate and take `browser_screenshot`
  const procStart = await router.executeTool(
    "call_7",
    "process_start",
    {
      command: "echo 'Listening on http://127.0.0.1:43210' && sleep 2",
      port: 43210,
    },
    ctx
  );
  assert.equal(procStart.error, undefined);

  const previewRes = await router.executeTool("call_8", "preview_url", { port: 43210 }, ctx);
  assert.equal(
    (previewRes.output as { previewUrl: string }).previewUrl,
    "http://127.0.0.1:43210"
  );

  const navRes = await router.executeTool(
    "call_9",
    "browser_navigate",
    { url: "http://127.0.0.1:43210" },
    ctx
  );
  assert.equal(navRes.error, undefined);
  assert.equal(navRes.untrusted, true);

  const shotRes = await router.executeTool("call_10", "browser_screenshot", {}, ctx);
  assert.equal(shotRes.error, undefined);
  assert.equal((shotRes.output as { mimeType: string }).mimeType, "image/png");
  assert.ok((shotRes.output as { dataBase64: string }).dataBase64.length > 20);

  // 5. Verify 50 KB / 2,000-line output truncation spills to .openharness/outputs/<callId>.txt
  const giantLines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}: output data`).join("\n");
  const truncated = enforceToolOutputLimit(giantLines, "call_giant_1", handle.workspacePath);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.spillPath, ".openharness/outputs/call_giant_1.txt");
  assert.ok(
    fs.existsSync(path.join(handle.workspacePath, ".openharness", "outputs", "call_giant_1.txt"))
  );

  await dockerProvider.destroy(handle);
});
