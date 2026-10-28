import { describe, expect, test } from "bun:test";
import { applyEvent, type Message, type OpenHarnessEvent } from "../src/index.ts";

describe("SDK event handling", () => {
  test("message and part events preserve reasoning, step usage, and compaction metadata", () => {
    const message: Message = {
      info: { id: "m1", role: "assistant" },
      createdAt: 1,
      parts: [{ type: "reasoning", text: "Checking the constraints." }],
    };
    const initial: OpenHarnessEvent = { type: "message.updated", sessionId: "s1", message };
    const withMessage = applyEvent([], initial);
    const step: OpenHarnessEvent = {
      type: "part.updated", sessionId: "s1", messageId: "m1",
      part: { type: "step", usage: { input: 24, output: 8, reasoning: 4 }, cost: 0.0001 },
    };
    const withStep = applyEvent(withMessage, step);
    const compaction: OpenHarnessEvent = {
      type: "part.updated", sessionId: "s1", messageId: "m1",
      part: { type: "compaction", summary: "Carry forward the question.", reason: "tokens", compactedMessages: 3, requirements: ["keep it bounded"], decisions: ["use a limit"], openQuestions: ["What is the cap?"] },
    };
    const result = applyEvent(withStep, compaction);
    expect(result[0]?.parts.map((part) => part.type)).toEqual(["reasoning", "step", "compaction"]);
    expect(result[0]?.parts[2]).toMatchObject({ type: "compaction", openQuestions: ["What is the cap?"] });
  });

  test("verification, reload, and permission reply events are represented by the SDK contract", () => {
    const events: OpenHarnessEvent[] = [
      { type: "verification.started", sessionId: "s1", command: "typecheck", iteration: 1, maxIterations: 3 },
      { type: "verification.completed", sessionId: "s1", result: { command: "typecheck", passed: true, exitCode: 0, timedOut: false, stdout: "ok", truncated: false }, iteration: 1, maxIterations: 3 },
      { type: "runtime.reloaded", at: 1 },
      { type: "permission.replied", requestId: "p1", reply: "once" },
    ];
    expect(events.map((event) => event.type)).toEqual(["verification.started", "verification.completed", "runtime.reloaded", "permission.replied"]);
  });
});
