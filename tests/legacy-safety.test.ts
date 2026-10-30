import test from "node:test";
import assert from "node:assert/strict";
import { classifyToolCallRisk } from "../packages/core/src/security/risk.ts";

test("legacy safety: high-risk destructive commands are classified high", () => {
  assert.equal(classifyToolCallRisk("bash", { command: "rm -rf /" }).risk, "high");
  assert.equal(classifyToolCallRisk("read_file", { path: "README.md" }).risk, "low");
});
