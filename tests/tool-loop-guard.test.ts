import test from "node:test";
import assert from "node:assert/strict";
import { ToolLoopGuard } from "../packages/core/src/index.ts";
import { diagnoseError } from "../packages/server/src/worker/diagnose.ts";

test("Step 6b (H6): ToolLoopGuard warns on repeated identical calls and aborts on 4th identical call or phase ceiling breach", () => {
  const guard = new ToolLoopGuard({ maxRepeatedIdentical: 3, maxPerPhase: 5 });

  const d1 = guard.recordCall("building", "read_file", { b: 1, a: 2 }, false);
  assert.equal(d1.action, "allow");

  const d2 = guard.recordCall("building", "read_file", { a: 2, b: 1 }, false);
  assert.equal(d2.action, "allow");

  const d3 = guard.recordCall("building", "read_file", { a: 2, b: 1 }, false);
  assert.equal(d3.action, "warn", "3rd identical call must warn");

  const d4 = guard.recordCall("building", "read_file", { a: 2, b: 1 }, false);
  assert.equal(d4.action, "abort", "4th identical call must abort");

  // Phase ceiling check
  const guard2 = new ToolLoopGuard({ maxRepeatedIdentical: 3, maxPerPhase: 3 });
  assert.equal(guard2.recordCall("planning", "list", { path: "a" }).action, "allow");
  assert.equal(guard2.recordCall("planning", "list", { path: "b" }).action, "allow");
  assert.equal(guard2.recordCall("planning", "list", { path: "c" }).action, "allow");
  const overCeiling = guard2.recordCall("planning", "list", { path: "d" });
  assert.equal(overCeiling.action, "abort");
  assert.match(overCeiling.reason ?? "", /Exceeded maximum tool round-trips/);
});

test("Step 6b (H7): diagnoseError maps provider, sandbox, timeout, and loop errors to structured codes and recoverability flags", () => {
  const auth = diagnoseError(Object.assign(new Error("Missing API key OPENAI_API_KEY"), { status: 401 }));
  assert.equal(auth.code, "AUTH_ERROR");
  assert.equal(auth.recoverable, false);

  const rate = diagnoseError(Object.assign(new Error("429 Too Many Requests"), { status: 429 }));
  assert.equal(rate.code, "RATE_LIMIT");
  assert.equal(rate.recoverable, true);

  const quota = diagnoseError(new Error("You exceeded your current quota, please check your plan and billing details."));
  assert.equal(quota.code, "QUOTA_EXCEEDED");
  assert.equal(quota.recoverable, false);

  const sb = diagnoseError(new Error("Modal sandbox failed to become healthy: timed out waiting for /health"));
  assert.equal(sb.code, "SANDBOX_BOOT_FAILED");
  assert.equal(sb.recoverable, true);

  const loop = diagnoseError(Object.assign(new Error("Tool loop detected"), { code: "TOOL_LOOP" }));
  assert.equal(loop.code, "TOOL_LOOP");
  assert.equal(loop.recoverable, false);
});
