import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUILT_IN_PROVIDER_FIXTURES,
  ModelAgnosticProviderAdapter,
  OpenHarnessTracer,
  ProviderFixtureRecorder,
  RunMetricsCollector,
  runEvalSuite,
  SMOKE_20_EVAL_SUITE,
} from "../packages/core/src/index.ts";

test("Phase J.1 & J.2 Acceptance: OpenTelemetry GenAI semantic spans (invoke_agent, chat, execute_tool, sandbox.create, sandbox.exec, verify.run, compaction) with OTLP export and per-run/per-feature metrics", async () => {
  const exportedPayloads = [];
  const tracer = new OpenHarnessTracer({
    endpoint: "http://127.0.0.1:4318/v1/traces",
    transport: async (_url, body) => {
      exportedPayloads.push(body);
    },
  });

  await tracer.withSpan("invoke_agent", { "openharness.run_id": "run_j_1" }, async (rootSpan) => {
    await tracer.withSpan("sandbox.create", { provider: "docker" }, async () => {}, rootSpan);
    tracer.recordChatSpan({
      model: "Llama-4-Maverick-17B-128E-Instruct-FP8",
      provider: "meta-llama",
      usage: { input: 512, output: 128, reasoning: 64, cacheRead: 0, estimated: false },
      durationMs: 420,
      runId: "run_j_1",
      traceId: rootSpan.traceId,
      parentSpanId: rootSpan.spanId,
    });
    await tracer.withSpan("execute_tool", { tool: "bash" }, async () => {}, rootSpan);
    await tracer.withSpan("sandbox.exec", { command: "npm test" }, async () => {}, rootSpan);
    await tracer.withSpan("verify.run", { passed: true }, async () => {}, rootSpan);
    await tracer.withSpan("compaction", { compacted_messages: 8 }, async () => {}, rootSpan);
  });

  const spanNames = tracer.spans.map((s) => s.name);
  for (const expectedName of [
    "invoke_agent",
    "chat",
    "execute_tool",
    "sandbox.create",
    "sandbox.exec",
    "verify.run",
    "compaction",
  ]) {
    assert.ok(spanNames.includes(expectedName), `Missing OTel span: ${expectedName}`);
  }
  const chatSpan = tracer.spans.find((s) => s.name === "chat");
  assert.equal(chatSpan?.attributes["gen_ai.usage.input_tokens"], 512);
  assert.equal(chatSpan?.attributes["gen_ai.usage.output_tokens"], 128);
  assert.ok(exportedPayloads.length >= 6);

  // Per-run and per-feature metrics
  const metrics = new RunMetricsCollector("run_j_1", "sess_j_1", 1000);
  metrics.recordStep({ featureId: "feat-1", tokensIn: 400, tokensOut: 100, estimated: false, costUsd: 0.01 });
  metrics.recordStep({ featureId: "feat-1", tokensIn: 300, tokensOut: 80, estimated: true, costUsd: 0.008 });
  metrics.recordToolCall({ tool: "edit", isError: false, featureId: "feat-1" });
  metrics.recordToolCall({ tool: "bash", isError: true, featureId: "feat-1" });
  metrics.recordMalformedCall("feat-1");
  metrics.recordRetry("feat-1");
  metrics.recordCompaction("feat-1");
  metrics.recordContextReset("feat-1");
  metrics.recordVerification(false, "feat-1");
  metrics.recordVerification(true, "feat-1");
  metrics.recordStuckEvent("feat-1");

  const snap = metrics.snapshot(5000);
  assert.equal(snap.overall.steps, 2);
  assert.equal(snap.overall.totalToolCalls, 2);
  assert.equal(snap.overall.toolErrors, 1);
  assert.equal(snap.overall.toolErrorRate, 0.5);
  assert.equal(snap.overall.malformedCalls, 1);
  assert.equal(snap.overall.retries, 1);
  assert.equal(snap.overall.compactions, 1);
  assert.equal(snap.overall.contextResets, 1);
  assert.equal(snap.overall.tokensInMeasured, 400);
  assert.equal(snap.overall.tokensInEstimated, 300);
  assert.equal(snap.overall.verificationPassRate, 0.5);
  assert.equal(snap.overall.stuckEvents, 1);
  assert.equal(snap.overall.wallTimeMs, 4000);
  assert.equal(snap.byFeature["feat-1"]?.steps, 2);
});

test("Phase J.3 & J.4 Acceptance: record/replay provider fixtures (OpenAI, Anthropic, Meta Llama, Ollama, Fireworks) and eval suites (20-case smoke, long-horizon, model-compat) reporting pass@1, pass^k, tampering flags, and separate LLM judge rubric", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-phase-j-"));
  const fixtureFile = path.join(tmpDir, "fixtures.json");

  const recorder = new ProviderFixtureRecorder(Object.values(BUILT_IN_PROVIDER_FIXTURES));
  recorder.saveToFile(fixtureFile);
  const loaded = ProviderFixtureRecorder.loadFromFile(fixtureFile);
  const transport = loaded.createReplayTransport();

  const adapter = new ModelAgnosticProviderAdapter({ transport });

  for (const modelId of [
    "gpt-4o",
    "claude-3-7-sonnet",
    "Llama-4-Maverick-17B-128E-Instruct-FP8",
    "local-llama",
    "fireworks/llama-v3p3-70b-instruct",
  ]) {
    const res = await adapter.generateTurn({
      runId: "run_fixture_test",
      sessionId: "sess_fixture_test",
      model: modelId,
      systemPrompt: "Read package.json",
      messages: [],
      tools: [
        {
          name: "read_file",
          description: "Read file",
          parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
        },
      ],
    });
    assert.equal(res.toolCalls.length, 1, `Expected 1 tool call for ${modelId}`);
    assert.equal(res.toolCalls[0].name, "read_file");
    assert.deepEqual(res.toolCalls[0].arguments, { path: "package.json" });
  }

  // 1. 20-case smoke suite with k=3 trials and optional LLM judge
  assert.equal(SMOKE_20_EVAL_SUITE.length, 20);
  const smokeReport = await runEvalSuite("smoke-20", {
    k: 3,
    enableLlmJudge: true,
    trialExecutor: async (spec, trialIdx) => {
      // Make smoke_05 fail on trial 2 so pass@1 is true (trial 0 passed) but pass^k is false!
      const passed = !(spec.id === "smoke_05" && trialIdx === 1);
      return {
        passed,
        costUsd: 0.001,
        durationMs: 5,
        tamperingFlagged: spec.id === "smoke_05",
      };
    },
  });
  assert.equal(smokeReport.totalCases, 20);
  assert.equal(smokeReport.passAt1Rate, 1.0); // all 20 passed on trial 0
  assert.equal(smokeReport.passHatKRate, 19 / 20); // 19 of 20 passed all 3 trials (pass^k)
  assert.equal(smokeReport.tamperingFlagsCount, 1);
  assert.ok(typeof smokeReport.llmJudgeAverageScore === "number");

  // 2. Long-horizon eval suite
  const lhReport = await runEvalSuite("long-horizon", { k: 2 });
  assert.equal(lhReport.totalCases, 2);
  assert.equal(lhReport.passHatKRate, 1.0);

  // 3. Model-compatibility eval suite across all configured profiles including Meta Llama
  const compatReport = await runEvalSuite("model-compat", { k: 2 });
  assert.ok(compatReport.totalCases >= 10);
  assert.equal(compatReport.passHatKRate, 1.0);
});
