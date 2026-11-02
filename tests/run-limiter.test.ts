import test from "node:test";
import assert from "node:assert/strict";
import { RunLimiter } from "../packages/server/src/run-limiter.ts";

test("RunLimiter enforces global, per-tenant, and daily guest limits and releases slots", () => {
  const limiter = new RunLimiter(2, 1, 1);
  assert.deepEqual(limiter.tryAcquire("a", "run-a", false), { ok: true });
  assert.equal(limiter.tryAcquire("a", "run-a2", false).ok, false);
  assert.deepEqual(limiter.tryAcquire("b", "run-b", false), { ok: true });
  assert.equal(limiter.tryAcquire("c", "run-c", true).ok, false);
  limiter.release("a", "run-a");
  assert.equal(limiter.tryAcquire("a", "run-a2", false).ok, false, "daily limit persists after release");
  limiter.release("b", "run-b");
  assert.deepEqual(limiter.tryAcquire("admin", "run-admin", true), { ok: true });
});
