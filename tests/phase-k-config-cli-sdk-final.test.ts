import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileSandboxPolicy,
  createInitialRunState,
  DockerSandboxProvider,
  InProcessEventBus,
  InProcessJobQueue,
  LayeredContextManager,
  LocalStateStore,
  ModelAgnosticProviderAdapter,
  RiskPolicyGate,
  runToStopOrWait,
  StandardToolRouter,
  validateOpenHarnessConfig,
  validateToolArgumentsAgainstSchema,
} from "../packages/core/src/index.ts";
import { OpenHarnessServer } from "../packages/server/src/index.ts";
import { runOhCli } from "../packages/cli/src/index.ts";

test("§14 & §15 Acceptance: fail-closed configuration validation rejects unknown keys while accepting the full §14 config, and all §15 package layout modules exist", async () => {
  // 1. Validate exact §14 configuration structure
  const validSpecConfig = {
    mode: { default: "chat" },
    providers: {
      llama: {
        wire: "openai-chat",
        baseUrl: "https://api.llama.com/compat/v1",
        apiKey: "{secret:LLAMA_API_KEY}",
        models: {
          "Llama-4-Maverick-17B-128E-Instruct-FP8": {
            profile: "meta-llama-4",
            contextWindow: 128000,
          },
        },
      },
    },
    agents: {
      reviewer: {
        model: "openai/gpt-5",
        tools: ["read_file", "search", "glob", "list"],
      },
    },
    sandbox: {
      default: "local",
      allowUnsandboxedAutonomy: false,
      docker: {
        image: "openharness/sandbox:node22-py312",
        cpus: 2,
        memoryMb: 4096,
        diskMb: 20480,
      },
      modal: {
        app: "openharness-sandboxes",
        runtime: "vm",
        idleTtlSec: 900,
      },
      filesystem: { extraAllowWrite: [], extraDenyRead: [] },
      network: {
        setupPresets: ["package-registries"],
        agentPresets: [],
        allowedDomains: [],
        methods: ["GET", "HEAD"],
      },
      pauseIdleTtlSec: 900,
    },
    limits: {
      chat: {},
      task: {},
      long_task: { maxCostPerTask: 25 },
    },
    context: {
      clearAfterTurns: 6,
      recitationEveryTurns: 8,
      keepRecentTokens: 20000,
      handoffAtRatio: 0.6,
      precompute: true,
    },
    verify: { commands: [], maxIterations: 6, noProgressLimit: 2, e2e: [] },
    confirmation: { policy: "risky", unattended: { onConfirm: "deny" } },
    stuckDetection: {
      actionObservation: 4,
      actionError: 3,
      monologue: 3,
      alternating: 6,
      malformed: 5,
    },
    schedules: [],
  };

  const validRes = validateOpenHarnessConfig(validSpecConfig);
  assert.equal(validRes.valid, true, `Unexpected validation errors: ${validRes.errors.join(", ")}`);

  // Unknown keys must fail closed (§0 rule 10, §14)
  const invalidRes = validateOpenHarnessConfig({
    ...validSpecConfig,
    unknownTopLevelKey: true,
    sandbox: { ...validSpecConfig.sandbox, unknownNestedKey: 123 },
  });
  assert.equal(invalidRes.valid, false);
  assert.equal(invalidRes.errors.length, 2);

  // 2. Verify all §15 files exist on disk
  const requiredPaths = [
    "packages/core/src/agent/engine.ts",
    "packages/core/src/agent/phases.ts",
    "packages/core/src/agent/loop.ts",
    "packages/core/src/agent/stuck.ts",
    "packages/core/src/agent/budget.ts",
    "packages/core/src/agent/long-task.ts",
    "packages/core/src/agent/reviewer.ts",
    "packages/core/src/agent/deps.ts",
    "packages/core/src/provider/profiles.ts",
    "packages/core/src/provider/openai-chat.ts",
    "packages/core/src/provider/anthropic.ts",
    "packages/core/src/provider/bedrock.ts",
    "packages/core/src/provider/toolcall.ts",
    "packages/core/src/provider/json-repair.ts",
    "packages/core/src/provider/retry.ts",
    "packages/core/src/provider/probe.ts",
    "packages/core/src/context/manager.ts",
    "packages/core/src/context/clearing.ts",
    "packages/core/src/context/compaction.ts",
    "packages/core/src/context/precompute.ts",
    "packages/core/src/context/hard-reset.ts",
    "packages/core/src/context/recitation.ts",
    "packages/core/src/context/handoff.ts",
    "packages/core/src/context/instructions.ts",
    "packages/core/src/sandbox/contracts.ts",
    "packages/core/src/sandbox/policy.ts",
    "packages/core/src/sandbox/local.ts",
    "packages/core/src/sandbox/srt-local.ts",
    "packages/core/src/sandbox/docker.ts",
    "packages/core/src/sandbox/modal.ts",
    "packages/core/src/sandbox/client.ts",
    "packages/core/src/security/risk.ts",
    "packages/core/src/security/shell-parse.ts",
    "packages/core/src/security/taint.ts",
    "packages/core/src/security/hooks.ts",
    "packages/core/src/checkpoint/shadow-git.ts",
    "packages/core/src/checkpoint/rewind.ts",
    "packages/core/src/checkpoint/fork.ts",
    "packages/core/src/scheduler/cron.ts",
    "packages/core/src/scheduler/webhook.ts",
    "deploy/sandbox/Dockerfile.node22-py312",
    "docs/SANDBOX.md",
    "docs/LONG_TASKS.md",
  ];
  for (const rel of requiredPaths) {
    assert.ok(fs.existsSync(rel), `Missing §15/§17 file: ${rel}`);
  }
});

test("§13 Phase K CLI & §17 Final Acceptance Criterion #1: Meta Llama 4 Maverick task run in an in-process daemon sandbox recovers from a 429 and a malformed tool call, fixes a failing Node test, passes verification and review, and creates a shadow-git checkpoint", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-final-llama-ws-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-final-llama-data-"));

  // Seed a sample Node project with a failing test in workspaceDir
  fs.writeFileSync(
    path.join(workspaceDir, "package.json"),
    JSON.stringify({ name: "llama-fix-demo", type: "module" }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspaceDir, "price.js"),
    "export function applyDiscount(amount, pct) {\n  return amount + (amount * pct) / 100;\n}\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspaceDir, "price.test.js"),
    "import assert from 'node:assert/strict';\nimport { applyDiscount } from './price.js';\nassert.equal(applyDiscount(100, 20), 80);\nconsole.log('TEST_SUITE_GREEN');\n",
    "utf8"
  );

  // Create Docker sandbox
  const dockerProvider = new DockerSandboxProvider();
  const policy = compileSandboxPolicy({
    runId: "run_llama_final",
    workspacePath: workspaceDir,
    networkMode: "none",
  });
  const handle = await dockerProvider.create({
    runId: "run_llama_final",
    sessionId: "sess_llama_final",
    workspace: { type: "bind", hostPath: workspaceDir },
    policy,
  });

  const store = new LocalStateStore({ dataDir });
  const bus = new InProcessEventBus();
  await store.saveSession("default", {
    id: "sess_llama_final",
    title: "Fix applyDiscount bug",
    agent: "assistant",
    model: "Llama-4-Maverick-17B-128E-Instruct-FP8",
    runtime: "docker",
    status: "running",
    updatedAt: Date.now(),
  });

  const toolRouter = new StandardToolRouter({
    workspaceRoot: handle.workspacePath,
    sandboxEnabled: true,
  });

  let httpAttempt = 0;
  let retryOccurred = false;
  let malformedRecovered = false;

  const provider = new ModelAgnosticProviderAdapter({
    baseRetryDelayMs: 5,
    onRetryEvent: () => {
      retryOccurred = true;
    },
    transport: async (_payload) => {
      httpAttempt += 1;
      // 1. First HTTP request hits a 429 rate limit with Retry-After
      if (httpAttempt === 1) {
        const err = new Error("Llama API 429 Too Many Requests");
        err.status = 429;
        err.headers = { "retry-after-ms": "10" };
        throw err;
      }
      // 2. Second request (Turn 1) publishes the plan via update_plan
      if (httpAttempt === 2) {
        return {
          text: "Publishing plan",
          tool_calls: [
            {
              function: {
                name: "update_plan",
                arguments: JSON.stringify({
                  title: "Fix discount calculation",
                  steps: [{ id: "1", title: "Fix operator in price.js", status: "pending" }],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 30 },
        };
      }
      // 3. Third request (Turn 2) emits a malformed/unknown tool call first (which the engine catches and feeds back into context without failing the run!)
      if (httpAttempt === 3) {
        malformedRecovered = true;
        return {
          text: "Attempting malformed tool call",
          tool_calls: [
            {
              function: {
                name: "non_existent_tool",
                arguments: "{bad json",
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 20 },
        };
      }
      // 4. Fourth request (Turn 3) uses `edit` with trailing-comma Llama JSON to fix `price.js`
      if (httpAttempt === 4) {
        return {
          text: "Fixing price.js",
          tool_calls: [
            {
              function: {
                name: "edit",
                arguments:
                  "{'command': 'str_replace', 'path': 'price.js', 'old_str': 'return amount + (amount * pct) / 100;', 'new_str': 'return amount - (amount * pct) / 100;', }",
              },
            },
          ],
          usage: { prompt_tokens: 150, completion_tokens: 35 },
        };
      }
      // 5. Fifth request (Turn 4) finishes build phase so engine transitions to testing -> reviewing -> checkpoint -> completed!
      return {
        text: "Fix applied and verified.",
        toolCalls: [],
        usage: { prompt_tokens: 160, completion_tokens: 15 },
      };
    },
  });

  const deps = {
    clock: { now: () => Date.now(), sleep: async () => {} },
    stateStore: store,
    eventBus: bus,
    provider,
    toolRouter,
    policyGate: new RiskPolicyGate({ osEnforcedSandbox: true, defaultConfirmationPolicy: "risky" }),
    contextManager: new LayeredContextManager({ workspaceRoot: handle.workspacePath }),
    workspaceRoot: handle.workspacePath,
    onRunVerification: async () => {
      const execRes = await toolRouter.executeTool(
        "verify_call",
        "bash",
        { command: "node price.test.js" },
        {
          runId: "run_llama_final",
          sessionId: "sess_llama_final",
          tenantId: "default",
          workspaceRoot: handle.workspacePath,
          sandboxHandleId: handle.id,
          state: createInitialRunState({ runId: "run_llama_final", sessionId: "sess_llama_final" }),
        }
      );
      const outObj = typeof execRes.output === "string" ? JSON.parse(execRes.output) : (execRes.output as { exitCode: number; output: string });
      const passed = outObj.exitCode === 0 && outObj.output.includes("TEST_SUITE_GREEN");
      return {
        passed,
        signature: passed ? "pass" : "fail",
        condensedError: passed ? "" : outObj.output,
        results: [
          {
            name: "node-test",
            command: "node price.test.js",
            passed,
            exitCode: outObj.exitCode,
            output: outObj.output,
          },
        ],
      };
    },
    onRunReviewer: async () => ({
      verdict: "pass" as const,
      issues: [],
      tamperingDetected: false,
    }),
    onCreateCheckpoint: async (state, message, automatic) => ({
      sha: `cp_llama_${state.iteration}`,
      message,
      createdAt: Date.now(),
      sessionId: state.sessionId,
      runId: state.runId,
      automatic,
    }),
  };

  const initialState = createInitialRunState({
    runId: "run_llama_final",
    sessionId: "sess_llama_final",
    model: "Llama-4-Maverick-17B-128E-Instruct-FP8",
    mode: "task",
    phase: "planning",
    sandboxHandleId: handle.id,
  });

  const { state: finalState, events } = await runToStopOrWait(initialState, deps);
  assert.equal(retryOccurred, true, "Expected recovery from 429 rate limit");
  assert.equal(malformedRecovered, true, "Expected recovery from malformed tool call");
  assert.equal(finalState.phase, "completed");
  assert.ok(finalState.lastCheckpoint, "Expected shadow-git checkpoint on completion");
  assert.ok(events.some((e) => e.type === "checkpoint.created"));

  // Test Phase K CLI commands (`oh run --mode long_task --sandbox docker --budget-usd 20`, `oh runs`, `oh run pause|resume|extend`, `oh sandbox ls|shell|destroy`)
  const server = new OpenHarnessServer({ dataDir, workspaceRoot: workspaceDir });
  const cliRun = await runOhCli(
    ["run", "--mode", "long_task", "--sandbox", "docker", "--budget-usd", "20", "Build analytics service", "--json"],
    server
  );
  assert.equal(cliRun.exitCode, 0);
  const runData = cliRun.data as { runId: string; mode: string; sandbox: string; budgetUsd: number };
  assert.equal(runData.mode, "long_task");
  assert.equal(runData.sandbox, "docker");
  assert.equal(runData.budgetUsd, 20);

  const cliRunsList = await runOhCli(["runs", "--json"], server);
  assert.equal(cliRunsList.exitCode, 0);

  const cliPause = await runOhCli(["run", "pause", runData.runId, "--json"], server);
  assert.equal(cliPause.exitCode, 0);

  const cliExtend = await runOhCli(["run", "extend", runData.runId, "--json"], server);
  assert.equal(cliExtend.exitCode, 0);

  const cliSbLs = await runOhCli(["sandbox", "ls", "--json"], server);
  assert.equal(cliSbLs.exitCode, 0);

  const cliSbShell = await runOhCli(["sandbox", "shell", "sb_default", "--cmd", "pwd", "--json"], server);
  assert.equal(cliSbShell.exitCode, 0);

  const cliSbDestroy = await runOhCli(["sandbox", "destroy", "sb_default", "--json"], server);
  assert.equal(cliSbDestroy.exitCode, 0);

  await dockerProvider.destroy(handle);
});
