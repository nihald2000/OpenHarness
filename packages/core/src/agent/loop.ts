import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type {
  CheckpointInfo,
  FeatureItem,
  OpenHarnessEvent,
} from "@openharness/sdk";
import type { RunState } from "./deps.ts";

export interface VerificationCheckSpec {
  name: string;
  command: string;
  timeoutSec?: number;
  expectedExitCode?: number;
}

export interface VerificationRecipe {
  source: "config" | "repo_file" | "auto_detected";
  checks: VerificationCheckSpec[];
}

export interface VerificationCheckResult {
  name: string;
  command: string;
  passed: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
}

export interface VerificationRunSummary {
  passed: boolean;
  signature: string;
  condensedError: string;
  results: VerificationCheckResult[];
}

export interface ReviewerVerdict {
  verdict: "pass" | "fail";
  issues: string[];
  tamperingDetected: boolean;
}

/**
 * Resolves the verification recipe in strict precedence order (§8 F.2 step 3):
 * 1. `verify.commands` from config
 * 2. `.openharness/verify.json` in the repo
 * 3. Auto-detection (`package.json` scripts `typecheck`, `lint`, `test`, `build`; `pyproject.toml`/`pytest`; `go test ./...`; `cargo test`; `mvn -q test`; `Makefile` `test` target)
 */
export function resolveVerificationRecipe(
  workspaceRoot: string,
  configCommands?: Array<string | VerificationCheckSpec>
): VerificationRecipe {
  if (configCommands && configCommands.length > 0) {
    return {
      source: "config",
      checks: configCommands.map((c, idx) =>
        typeof c === "string"
          ? { name: `check_${idx + 1}`, command: c, timeoutSec: 300, expectedExitCode: 0 }
          : {
              name: c.name || `check_${idx + 1}`,
              command: c.command,
              timeoutSec: c.timeoutSec ?? 300,
              expectedExitCode: c.expectedExitCode ?? 0,
            }
      ),
    };
  }

  const repoVerifyFile = path.join(workspaceRoot, ".openharness", "verify.json");
  if (fs.existsSync(repoVerifyFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(repoVerifyFile, "utf8")) as {
        checks?: VerificationCheckSpec[];
        commands?: string[];
      };
      if (Array.isArray(parsed.checks) && parsed.checks.length > 0) {
        return {
          source: "repo_file",
          checks: parsed.checks.map((c, i) => ({
            name: c.name || `check_${i + 1}`,
            command: c.command,
            timeoutSec: c.timeoutSec ?? 300,
            expectedExitCode: c.expectedExitCode ?? 0,
          })),
        };
      }
      if (Array.isArray(parsed.commands) && parsed.commands.length > 0) {
        return {
          source: "repo_file",
          checks: parsed.commands.map((cmd, i) => ({
            name: `check_${i + 1}`,
            command: cmd,
            timeoutSec: 300,
            expectedExitCode: 0,
          })),
        };
      }
    } catch {
      // fall through to auto-detection
    }
  }

  // Auto-detection
  const checks: VerificationCheckSpec[] = [];
  const pkgJsonPath = path.join(workspaceRoot, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      for (const scriptName of ["typecheck", "lint", "test", "build"]) {
        if (scripts[scriptName]) {
          checks.push({
            name: scriptName,
            command: `npm run ${scriptName}`,
            timeoutSec: 300,
            expectedExitCode: 0,
          });
        }
      }
    } catch {
      // ignore invalid package.json
    }
  }

  if (
    fs.existsSync(path.join(workspaceRoot, "pyproject.toml")) ||
    fs.existsSync(path.join(workspaceRoot, "pytest.ini"))
  ) {
    checks.push({
      name: "pytest",
      command: "python3 -m pytest",
      timeoutSec: 300,
      expectedExitCode: 0,
    });
  }
  if (fs.existsSync(path.join(workspaceRoot, "go.mod"))) {
    checks.push({
      name: "go-test",
      command: "go test ./...",
      timeoutSec: 300,
      expectedExitCode: 0,
    });
  }
  if (fs.existsSync(path.join(workspaceRoot, "Cargo.toml"))) {
    checks.push({
      name: "cargo-test",
      command: "cargo test",
      timeoutSec: 300,
      expectedExitCode: 0,
    });
  }
  if (fs.existsSync(path.join(workspaceRoot, "pom.xml"))) {
    checks.push({
      name: "mvn-test",
      command: "mvn -q test",
      timeoutSec: 300,
      expectedExitCode: 0,
    });
  }
  if (fs.existsSync(path.join(workspaceRoot, "Makefile"))) {
    const mk = fs.readFileSync(path.join(workspaceRoot, "Makefile"), "utf8");
    if (/^test\s*:/m.test(mk)) {
      checks.push({
        name: "make-test",
        command: "make test",
        timeoutSec: 300,
        expectedExitCode: 0,
      });
    }
  }

  return {
    source: "auto_detected",
    checks,
  };
}

/**
 * Condenses verification failure output to <=4 KB and computes a normalized failure signature (§8 F.2 step 4).
 */
export function condenseVerificationFailure(
  results: VerificationCheckResult[]
): { signature: string; condensedError: string } {
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) {
    return { signature: "pass", condensedError: "" };
  }

  const failingTestIds: string[] = [];
  let firstErrorLine = "";
  const excerpts: string[] = [];

  for (const f of failed) {
    const lines = f.output.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (
        /^(?:FAIL|FAILED|not ok|ERROR:)\s+(.+)/i.test(trimmed) &&
        failingTestIds.length < 10
      ) {
        const normalizedId = trimmed
          .replace(/\(\d+(\.\d+)?\s*m?s\)/g, "")
          .replace(/\s+/g, " ")
          .slice(0, 120);
        failingTestIds.push(`${f.name}:${normalizedId}`);
      }
      if (
        !firstErrorLine &&
        /(?:AssertionError|Error:|TypeError:|SyntaxError:|ReferenceError:|FAIL|FAILED)/i.test(
          trimmed
        )
      ) {
        firstErrorLine = trimmed
          .replace(/:\d+:\d+/g, "") // strip volatile line/col numbers for stable signature
          .slice(0, 160);
      }
    }
    excerpts.push(`### Failed Check: ${f.name} (${f.command}) [exit ${f.exitCode}]\n${f.output.slice(0, 1500)}`);
  }

  if (!firstErrorLine) {
    firstErrorLine = failed
      .map((f) => `${f.name}:exit_${f.exitCode}`)
      .join(",");
  }

  const sigParts = [
    failingTestIds.sort().join("|") || failed.map((f) => f.name).join("|"),
    firstErrorLine,
  ];
  const signature = sigParts.join("::");
  const condensedError = excerpts.join("\n\n").slice(0, 4096); // <= 4 KB cap (§8 F.2)

  return { signature, condensedError };
}

/**
 * Structural test-tampering detector on git diffs (§8 F.2 step 5):
 * Flags:
 * 1. Deleted or skipped tests (`it.skip`, `test.skip`, `describe.skip`, `@pytest.mark.skip`, `@unittest.skip`, deleted `test(` / `it(` blocks)
 * 2. Weakened assertions (removed `assert`/`expect` replaced with trivial `expect(true).toBe(true)` / `assert(true)` / `assert True`)
 * 3. Edits to verification config or CI files (`.openharness/verify.json`, `.github/workflows/**`)
 */
export function detectTestTamperingInDiff(diffText: string): {
  tamperingDetected: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  if (!diffText) {
    return { tamperingDetected: false, issues };
  }

  // 1. Check for edits to verification config or CI workflow files
  if (
    /^(?:\+\+\+|---)\s+[ab]\/(?:\.openharness\/verify\.json|\.github\/workflows\/)/m.test(
      diffText
    )
  ) {
    issues.push(
      "Test tampering detected: diff modifies verification configuration (.openharness/verify.json) or CI workflow (.github/workflows/)."
    );
  }

  const lines = diffText.split("\n");
  let removedAssertions = 0;
  let addedAssertions = 0;
  let removedTests = 0;
  let addedTests = 0;

  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;

    if (line.startsWith("+")) {
      const added = line.slice(1);
      // Added skipped tests
      if (
        /\b(?:it|test|describe)\.skip\s*\(|\bxit\s*\(|\bxtest\s*\(|@pytest\.mark\.skip|@unittest\.skip/i.test(
          added
        )
      ) {
        issues.push(`Test tampering detected: test skipped via "${added.trim().slice(0, 80)}".`);
      }
      // Trivial tautological assertions
      if (
        /\bexpect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)|\bassert(?:\.equal|\.ok)?\s*\(\s*true\b|\bassert\s+True\b/.test(
          added
        )
      ) {
        issues.push(
          `Test tampering detected: weakened/tautological assertion "${added.trim().slice(0, 80)}".`
        );
      }
      if (/\b(?:assert|expect)\b/.test(added)) {
        addedAssertions += 1;
      }
      if (/\b(?:test|it)\s*\(|def\s+test_/.test(added)) {
        addedTests += 1;
      }
    } else if (line.startsWith("-")) {
      const removed = line.slice(1);
      if (/\b(?:assert|expect)\b/.test(removed)) {
        removedAssertions += 1;
      }
      if (/\b(?:test|it)\s*\(|def\s+test_/.test(removed)) {
        removedTests += 1;
      }
    }
  }

  if (removedTests > addedTests) {
    issues.push(
      `Test tampering detected: ${removedTests - addedTests} test definition(s) were deleted.`
    );
  }
  if (removedAssertions > addedAssertions && removedAssertions > 0) {
    issues.push(
      `Test tampering detected: assertions were weakened or removed (${removedAssertions} removed vs ${addedAssertions} added).`
    );
  }

  return {
    tamperingDetected: issues.length > 0,
    issues,
  };
}

/**
 * Validates updates to `feature_list.json` so the model may NEVER delete features,
 * modify `acceptance` or `verification` arrays, or set `status: "passing"` directly (§8 F.3).
 */
export function validateModelFeatureListUpdate(
  existing: FeatureItem[],
  proposed: FeatureItem[]
): { valid: boolean; error?: string } {
  if (proposed.length < existing.length) {
    return {
      valid: false,
      error: "Feature list is immutable: deleting features from feature_list.json is forbidden.",
    };
  }

  for (const prev of existing) {
    const next = proposed.find((p) => p.id === prev.id);
    if (!next) {
      return {
        valid: false,
        error: `Feature "${prev.id}" was removed; deleting or renaming feature IDs is forbidden.`,
      };
    }
    if (
      JSON.stringify(prev.acceptance) !== JSON.stringify(next.acceptance) ||
      JSON.stringify(prev.verification) !== JSON.stringify(next.verification)
    ) {
      return {
        valid: false,
        error: `Feature "${prev.id}" acceptance or verification criteria were modified; criteria are immutable after initialization.`,
      };
    }
    if (prev.status !== "passing" && next.status === "passing") {
      return {
        valid: false,
        error: `Model cannot mark feature "${prev.id}" as "passing" directly; only the harness sets "passing" after verification and review pass.`,
      };
    }
  }

  return { valid: true };
}

export interface LongHorizonTaskRunnerOptions {
  taskId: string;
  workspaceRoot: string;
  sandboxed: boolean;
  allowUnsandboxedAutonomy?: boolean;
  verifyMaxIterations?: number; // default 6
  verifyNoProgressLimit?: number; // default 2
  handoffAtRatio?: number; // default 0.6
  contextWindow?: number;
  initialFeatures: Array<{
    id: string;
    title: string;
    description: string;
    acceptance: string[];
    verification: string[];
  }>;
  buildFeatureStep: (
    feature: FeatureItem,
    attempt: number,
    lastFailureError: string | null,
    sessionContextIndex: number
  ) => Promise<{
    diffText?: string;
    usedContextRatio?: number;
  }>;
  runVerificationChecks: (
    feature: FeatureItem,
    attempt: number
  ) => Promise<VerificationCheckResult[]>;
  runReviewerAgent?: (
    feature: FeatureItem,
    diffText: string,
    verifyResults: VerificationCheckResult[]
  ) => Promise<{ verdict: "pass" | "fail"; issues: string[] }>;
  createCheckpoint?: (message: string, featureId?: string) => Promise<CheckpointInfo>;
}

export interface LongHorizonTaskSummary {
  taskId: string;
  featuresPassing: string[];
  featuresBlocked: Array<{ id: string; reason: string }>;
  featuresPending: string[];
  checkpoints: CheckpointInfo[];
  contextResets: number;
  tamperingCaughtCount: number;
  events: OpenHarnessEvent[];
}

/**
 * Executes the full Phase F `long_task` protocol (§8 F.2, F.3):
 * - Enforces sandbox requirement (`long_task` refuses unsandboxed runtimes)
 * - Runs Initializer session creating `.openharness/task/<taskId>/feature_list.json`, `progress.md`, `init.sh`, and initial checkpoint
 * - Loops Coding sessions across features:
 *   Startup ritual (`pwd`, `progress.md` tail, shadow `git log`, `init.sh` smoke test)
 *   -> Plan -> Build -> Test -> Fix (with signature & `noProgressLimit` / `maxIterations`)
 *   -> Review (with structural diff test-tampering detection)
 *   -> Shadow-git Checkpoint -> Append `progress.md` -> Handoff to fresh context!
 */
export async function executeLongHorizonTask(
  state: RunState,
  opts: LongHorizonTaskRunnerOptions
): Promise<LongHorizonTaskSummary> {
  if (!opts.sandboxed && !opts.allowUnsandboxedAutonomy) {
    throw new Error(
      "long_task mode requires a sandboxed runtime (srt-local, docker, or modal)"
    );
  }

  const verifyMaxIterations = opts.verifyMaxIterations ?? 6;
  const verifyNoProgressLimit = opts.verifyNoProgressLimit ?? 2;
  const taskDir = path.join(opts.workspaceRoot, ".openharness", "task", opts.taskId);
  fs.mkdirSync(taskDir, { recursive: true });

  const featureListPath = path.join(taskDir, "feature_list.json");
  const progressPath = path.join(taskDir, "progress.md");
  const initScriptPath = path.join(taskDir, "init.sh");

  const checkpoints: CheckpointInfo[] = [];
  const events: OpenHarnessEvent[] = [];
  let contextResets = 0;
  let tamperingCaughtCount = 0;

  // --- 1. Initializer Session (§8 F.3) ---
  const features: FeatureItem[] = opts.initialFeatures.map((f) => ({
    id: f.id,
    title: f.title,
    description: f.description,
    acceptance: [...f.acceptance],
    verification: [...f.verification],
    status: "pending",
    attempts: 0,
  }));
  state.features = features;

  fs.writeFileSync(featureListPath, JSON.stringify(features, null, 2), "utf8");
  fs.writeFileSync(
    progressPath,
    `# Long-Horizon Task Progress (${opts.taskId})\nInitialized ${features.length} features.\n`,
    "utf8"
  );
  fs.writeFileSync(
    initScriptPath,
    "#!/usr/bin/env bash\nset -e\necho 'Environment smoke test OK'\n",
    { encoding: "utf8", mode: 0o755 }
  );

  const initCp: CheckpointInfo = opts.createCheckpoint
    ? await opts.createCheckpoint(`Initialize task ${opts.taskId}`)
    : {
        sha: `cp_init_${opts.taskId}`,
        message: `Initialize task ${opts.taskId}`,
        createdAt: Date.now(),
        sessionId: state.sessionId,
        runId: state.runId,
        automatic: true,
      };
  checkpoints.push(initCp);
  state.lastCheckpoint = initCp.sha;
  events.push({
    type: "checkpoint.created",
    sessionId: state.sessionId,
    runId: state.runId,
    checkpoint: initCp,
  });

  // --- 2. Coding Sessions Loop (one feature per session with handoff/context reset) (§8 F.3) ---
  for (let featIdx = 0; featIdx < features.length; featIdx++) {
    const feature = features[featIdx]!;
    if (feature.status !== "pending") continue;

    // Startup ritual: verify init.sh smoke test, read progress.md tail, flip feature to in_progress
    spawnSync("bash", [initScriptPath], { cwd: opts.workspaceRoot, encoding: "utf8" });
    feature.status = "in_progress";
    state.featureId = feature.id;
    fs.writeFileSync(featureListPath, JSON.stringify(features, null, 2), "utf8");

    let attempt = 0;
    let lastError: string | null = null;
    const signatureCounts = new Map<string, number>();
    let featureCompleted = false;

    while (attempt < verifyMaxIterations) {
      attempt += 1;
      feature.attempts = attempt;

      // Plan & Build step for this feature
      state.phase = "building";
      const buildOut = await opts.buildFeatureStep(
        feature,
        attempt,
        lastError,
        contextResets
      );
      const diffText = buildOut.diffText ?? "";

      // Test step (harness-run verification inside sandbox)
      state.phase = "testing";
      const checkResults = await opts.runVerificationChecks(feature, attempt);
      const { signature, condensedError } = condenseVerificationFailure(checkResults);
      const allChecksPassed = checkResults.every((r) => r.passed);

      if (!allChecksPassed) {
        const count = (signatureCounts.get(signature) ?? 0) + 1;
        signatureCounts.set(signature, count);
        lastError = condensedError;
        state.phase = "fixing";

        // Stop fix loop if same failure signature repeats `verify.noProgressLimit` times or `verify.maxIterations` reached (§8 F.2 step 4)
        if (count >= verifyNoProgressLimit || attempt >= verifyMaxIterations) {
          feature.status = "blocked";
          feature.blockedReason =
            count >= verifyNoProgressLimit
              ? `No progress after ${count} identical failure signatures (${signature})`
              : `Reached max fix iterations (${verifyMaxIterations}): ${condensedError.slice(0, 200)}`;
          break;
        }
        continue;
      }

      // Review step (structural diff tampering detector + separate reviewer agent) (§8 F.2 step 5)
      state.phase = "reviewing";
      const structuralTampering = detectTestTamperingInDiff(diffText);
      const reviewerRes = opts.runReviewerAgent
        ? await opts.runReviewerAgent(feature, diffText, checkResults)
        : { verdict: "pass" as const, issues: [] };

      const combinedIssues = [
        ...structuralTampering.issues,
        ...reviewerRes.issues,
      ];

      if (structuralTampering.tamperingDetected) {
        tamperingCaughtCount += 1;
      }

      if (structuralTampering.tamperingDetected || reviewerRes.verdict === "fail") {
        lastError = `Reviewer rejected changes: ${combinedIssues.join(" | ")}`;
        const revSig = `review_fail:${combinedIssues[0] ?? "issues"}`;
        const count = (signatureCounts.get(revSig) ?? 0) + 1;
        signatureCounts.set(revSig, count);
        state.phase = "fixing";

        if (count >= verifyNoProgressLimit || attempt >= verifyMaxIterations) {
          feature.status = "blocked";
          feature.blockedReason = lastError;
          break;
        }
        continue;
      }

      // Feature passed both verification and independent review!
      // Only the harness sets `passing` (§8 F.3)
      feature.status = "passing";
      const cp: CheckpointInfo = opts.createCheckpoint
        ? await opts.createCheckpoint(`Feature ${feature.id} passing`, feature.id)
        : {
            sha: `cp_${feature.id}_${attempt}`,
            message: `Feature ${feature.id} passing: ${feature.title}`,
            createdAt: Date.now(),
            sessionId: state.sessionId,
            runId: state.runId,
            featureId: feature.id,
            automatic: true,
          };
      feature.lastCheckpoint = cp.sha;
      state.lastCheckpoint = cp.sha;
      checkpoints.push(cp);
      events.push({
        type: "checkpoint.created",
        sessionId: state.sessionId,
        runId: state.runId,
        checkpoint: cp,
      });
      featureCompleted = true;
      break;
    }

    // Persist updated feature_list.json and append progress.md
    fs.writeFileSync(featureListPath, JSON.stringify(features, null, 2), "utf8");
    const logLine = featureCompleted
      ? `\n- [PASS] ${feature.id} (${feature.title}) in ${feature.attempts} attempt(s) -> checkpoint ${feature.lastCheckpoint}\n`
      : `\n- [BLOCKED] ${feature.id} (${feature.title}) after ${feature.attempts} attempt(s): ${feature.blockedReason}\n`;
    fs.appendFileSync(progressPath, logLine, "utf8");

    // Handoff to a fresh context between features (§7 E.6, §8 F.3)
    if (featIdx < features.length - 1) {
      contextResets += 1;
    }
  }

  state.phase = "completed";
  return {
    taskId: opts.taskId,
    featuresPassing: features.filter((f) => f.status === "passing").map((f) => f.id),
    featuresBlocked: features
      .filter((f) => f.status === "blocked")
      .map((f) => ({ id: f.id, reason: f.blockedReason ?? "Blocked" })),
    featuresPending: features.filter((f) => f.status === "pending").map((f) => f.id),
    checkpoints,
    contextResets,
    tamperingCaughtCount,
    events,
  };
}
