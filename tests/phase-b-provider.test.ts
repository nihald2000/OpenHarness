import test from "node:test";
import assert from "node:assert/strict";
import {
  ModelAgnosticProviderAdapter,
  resolveModelProfile,
  validateToolArgumentsAgainstSchema,
} from "../packages/core/src/provider/index.ts";

test("Phase B Acceptance: Llama profile sends max_completion_tokens, omits parallel_tool_calls, and handles (a) missing id, (b) trailing-comma JSON, (c) pythonic text tool call, and (d) 429 with Retry-After", async () => {
  const llamaModel = "Llama-4-Maverick-17B-128E-Instruct-FP8";
  const profile = resolveModelProfile(llamaModel);
  assert.equal(profile.outputParam, "max_completion_tokens");
  assert.equal(profile.toolCalling, "native-unreliable");
  assert.equal(profile.parallelToolCalls, "unsupported");
  assert.equal(profile.promptCaching, "none");

  const capturedWirePayloads = [];
  const retryEvents = [];
  let callCounter = 0;

  // Recorded HTTP fixtures for turns 1..3 (with a 429 + Retry-After on turn 1 attempt 1)
  const adapter = new ModelAgnosticProviderAdapter({
    baseRetryDelayMs: 10,
    clock: {
      now: () => Date.now(),
      sleep: async () => {},
    },
    onRetryEvent: (ev) => {
      retryEvents.push(ev);
    },
    transport: async (payload) => {
      capturedWirePayloads.push(payload);
      callCounter += 1;

      // (d) First attempt returns HTTP 429 with Retry-After header
      if (callCounter === 1) {
        const err = new Error("Rate limit exceeded");
        err.status = 429;
        err.headers = { "retry-after": "1" };
        throw err;
      }

      // Second attempt (Turn 1 retry) returns (a) a tool call without an id AND (b) trailing-comma + single-quote + Python True JSON arguments
      if (callCounter === 2) {
        return {
          text: "Reading file with repaired JSON",
          tool_calls: [
            {
              // no id!
              function: {
                name: "read_file",
                arguments: "```json\n{'path': 'src/App.tsx', 'recursive': True, }\n```",
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 35 },
        };
      }

      // Turn 2 returns (c) a Llama pythonic text tool call with no structured tool_calls
      return {
        text: 'Let me search the repo:\n[search(pattern="useSession", maxResults=10, caseSensitive=False)]',
        tool_calls: [],
      };
    },
  });

  // Turn 1 execution
  const turn1 = await adapter.generateTurn({
    runId: "run_llama_1",
    sessionId: "sess_llama_1",
    model: llamaModel,
    systemPrompt: "You are a helpful coding agent.",
    messages: [],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" },
            recursive: { type: "boolean" },
          },
        },
      },
      {
        name: "search",
        description: "Search files",
        parameters: {
          type: "object",
          required: ["pattern"],
          properties: {
            pattern: { type: "string" },
            maxResults: { type: "number" },
            caseSensitive: { type: "boolean" },
          },
        },
      },
    ],
    maxOutputTokens: 2048,
  });

  // Verify wire payload uses max_completion_tokens and does NOT send max_tokens or parallel_tool_calls
  assert.equal(capturedWirePayloads[0].max_completion_tokens, 2048);
  assert.equal(capturedWirePayloads[0].max_tokens, undefined);
  assert.equal(capturedWirePayloads[0].parallel_tool_calls, undefined);

  // Verify (d) 429 with Retry-After emitted run.retry with >= 1000ms delay and succeeded on retry
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0].attempt, 1);
  assert.ok(retryEvents[0].delayMs >= 1000);

  // Verify (a) stable ID synthesized and (b) trailing-comma + Python literal JSON repaired
  assert.equal(turn1.toolCalls.length, 1);
  assert.equal(turn1.toolCalls[0].id, "call_run_llama_1_1");
  assert.equal(turn1.toolCalls[0].name, "read_file");
  assert.deepEqual(turn1.toolCalls[0].arguments, {
    path: "src/App.tsx",
    recursive: true,
  });
  assert.equal(turn1.usage?.estimated, false);

  // Turn 2 execution: (c) pythonic text tool call fallback + usage estimation
  const turn2 = await adapter.generateTurn({
    runId: "run_llama_1",
    sessionId: "sess_llama_1",
    model: llamaModel,
    systemPrompt: "You are a helpful coding agent.",
    messages: [],
    tools: [
      {
        name: "search",
        description: "Search files",
        parameters: {
          type: "object",
          required: ["pattern"],
          properties: {
            pattern: { type: "string" },
            maxResults: { type: "number" },
            caseSensitive: { type: "boolean" },
          },
        },
      },
    ],
  });

  assert.equal(turn2.rawTextToolCall, true);
  assert.equal(turn2.toolCalls.length, 1);
  assert.equal(turn2.toolCalls[0].id, "call_run_llama_1_1");
  assert.equal(turn2.toolCalls[0].name, "search");
  assert.deepEqual(turn2.toolCalls[0].arguments, {
    pattern: "useSession",
    maxResults: 10,
    caseSensitive: false,
  });
  assert.equal(turn2.usage?.estimated, true);

  // Verify schema validation returns helpful error + expected schema instead of crashing
  const badValidation = validateToolArgumentsAgainstSchema(
    { maxResults: "not-a-number" },
    {
      type: "object",
      required: ["pattern"],
      properties: { pattern: { type: "string" }, maxResults: { type: "number" } },
    }
  );
  assert.equal(badValidation.valid, false);
  assert.match(badValidation.error ?? "", /Missing required parameter "pattern"/);
});
