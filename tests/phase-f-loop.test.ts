import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInitialRunState } from "../packages/core/src/agent/engine.ts";
import {
  detectTestTamperingInDiff,
  executeLongHorizonTask,
  resolveVerificationRecipe,
  validateModelFeatureListUpdate,
} from "../packages/core/src/agent/loop.ts";

test("Phase F Acceptance: on a sample repository with a 10-feature list, a long_task run with a scripted model passes features across >=3 context resets, catches a deliberately weakened test as tampering and fixes it, and marks an unfixable feature as blocked while continuing the run", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-phase-f-ws-"));
  fs.writeFileSync(
    path.join(workspaceDir, "package.json"),
    JSON.stringify({
      name: "sample-10-features",
      scripts: { test: "node --test", typecheck: "tsc --noEmit" },
    }),
    "utf8"
  );

  // Verify auto-detection of verification recipe
  const recipe = resolveVerificationRecipe(workspaceDir);
  assert.equal(recipe.source, "auto_detected");
  assert.deepEqual(
    recipe.checks.map((c) => c.name),
    ["typecheck", "test"]
  );

  // Build 10 features (9 completable + 1 unfixable feature #5 to verify blocked handling & continuation,
  // or 10 completable in Scenario 1 and 1 unfixable in Scenario 2)
  const makeTenFeatures = () =>
    Array.from({ length: 10 }, (_, idx) => ({
      id: `feat-${idx + 1}`,
      title: `Feature ${idx + 1}`,
      description: `Implement module ${idx + 1}`,
      acceptance: [`Module ${idx + 1} works`],
      verification: ["npm test"],
    }));

  // Scenario 1: All 10 features pass across 9 context resets, including catching a deliberately weakened test on feat-3 attempt 1 and fixing it on attempt 2!
  const state1 = createInitialRunState({
    runId: "run_f_all_pass",
    sessionId: "sess_f_1",
    mode: "long_task",
  });

  const summary1 = await executeLongHorizonTask(state1, {
    taskId: "task_10_pass",
    workspaceRoot: workspaceDir,
    sandboxed: true,
    initialFeatures: makeTenFeatures(),
    buildFeatureStep: async (feature, attempt) => {
      // On feat-3 attempt 1, model tries to weaken an assertion / skip a test!
      if (feature.id === "feat-3" && attempt === 1) {
        return {
          diffText: [
            "--- a/tests/feat3.test.ts",
            "+++ b/tests/feat3.test.ts",
            "@@ -1,4 +1,4 @@",
            "-  assert.equal(compute(2), 4);",
            "+  expect(true).toBe(true);",
            "+  test.skip('skipped failing test', () => {});",
          ].join("\n"),
        };
      }
      // On attempt 2 (after reviewer rejects tampering), model writes clean implementation
      return {
        diffText: [
          `--- a/src/${feature.id}.ts`,
          `+++ b/src/${feature.id}.ts`,
          "@@ -0,0 +1,3 @@",
          `+export const ${feature.id.replace("-", "_")} = true;`,
        ].join("\n"),
      };
    },
    runVerificationChecks: async (feature) => [
      {
        name: "test",
        command: "npm test",
        passed: true,
        exitCode: 0,
        output: `PASS ${feature.id}`,
        durationMs: 25,
      },
    ],
  });

  // All 10 features pass across >= 3 context resets (9 handoffs between the 10 features), and tampering was caught!
  assert.equal(summary1.featuresPassing.length, 10);
  assert.equal(summary1.featuresBlocked.length, 0);
  assert.ok(summary1.contextResets >= 3, `Expected >= 3 context resets, got ${summary1.contextResets}`);
  assert.equal(summary1.tamperingCaughtCount, 1);
  assert.equal(summary1.checkpoints.length, 11); // 1 init + 10 feature checkpoints

  // Scenario 2: Feature 4 cannot be fixed (repeats same failure signature), is marked `blocked`, and the run continues to complete the remaining features!
  const state2 = createInitialRunState({
    runId: "run_f_with_blocked",
    sessionId: "sess_f_2",
    mode: "long_task",
  });

  const summary2 = await executeLongHorizonTask(state2, {
    taskId: "task_with_blocked",
    workspaceRoot: workspaceDir,
    sandboxed: true,
    verifyMaxIterations: 6,
    verifyNoProgressLimit: 2,
    initialFeatures: makeTenFeatures(),
    buildFeatureStep: async (feature) => ({
      diffText: `+++ b/src/${feature.id}.ts\n+export const ok = true;`,
    }),
    runVerificationChecks: async (feature) => {
      if (feature.id === "feat-4") {
        return [
          {
            name: "test",
            command: "npm test",
            passed: false,
            exitCode: 1,
            output: "FAIL feat-4.test.ts\nAssertionError: expected 42 to equal 99",
            durationMs: 30,
          },
        ];
      }
      return [
        {
          name: "test",
          command: "npm test",
          passed: true,
          exitCode: 0,
          output: `PASS ${feature.id}`,
          durationMs: 20,
        },
      ];
    },
  });

  assert.equal(summary2.featuresPassing.length, 9);
  assert.equal(summary2.featuresBlocked.length, 1);
  assert.equal(summary2.featuresBlocked[0].id, "feat-4");
  assert.match(summary2.featuresBlocked[0].reason, /No progress after 2 identical failure signatures/);

  // Verify feature_list immutability guard rejects deleting features or model setting "passing"
  const immutCheck = validateModelFeatureListUpdate(state1.features, state1.features.slice(0, 5));
  assert.equal(immutCheck.valid, false);

  const directTamper = detectTestTamperingInDiff(
    "--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n-run: npm test\n+run: echo ok"
  );
  assert.equal(directTamper.tamperingDetected, true);
});
