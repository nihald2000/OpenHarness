import type { Message } from "@openharness/sdk";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProviderWirePayload,
  resolveModelProfile,
  synthesizeToolCallId,
  toWireMessages,
} from "../packages/core/src/index.ts";

test("Step 2 (M1, M2): toWireMessages and buildProviderWirePayload serialize tool calls and tool results for OpenAI, Anthropic, and text-mode profiles", () => {
  const history: Message[] = [
    {
      info: { id: "m_user_1", role: "user" },
      createdAt: 1,
      parts: [{ type: "text", text: "Read package.json and run tests" }],
    },
    {
      info: { id: "m_asst_1", role: "assistant" },
      createdAt: 2,
      parts: [
        { type: "text", text: "Checking files and running tests." },
        {
          type: "tool",
          tool: "read_file",
          callId: "call_read_1",
          state: "completed",
          input: { path: "package.json" },
          output: '{"name":"demo"}',
        },
        {
          type: "tool",
          tool: "bash",
          callId: "call_bash_2",
          state: "error",
          input: { command: "npm test" },
          error: "exit code 1",
        },
      ],
    },
    {
      info: { id: "m_asst_2", role: "assistant" },
      createdAt: 3,
      parts: [
        {
          type: "tool",
          tool: "edit",
          callId: "call_edit_3",
          state: "interrupted",
          input: { path: "src/index.ts" },
        },
      ],
    },
  ];

  // 1. OpenAI wire format: assistant tool_calls followed by one role: "tool" message per call
  const openaiProfile = resolveModelProfile("gpt-4o");
  const openaiMsgs = toWireMessages(history, openaiProfile);
  assert.equal(openaiMsgs.length, 6);
  assert.equal(openaiMsgs[0]!.role, "user");
  assert.equal(openaiMsgs[1]!.role, "assistant");
  assert.equal((openaiMsgs[1]!.tool_calls as unknown[]).length, 2);
  assert.equal(openaiMsgs[2]!.role, "tool");
  assert.equal(openaiMsgs[2]!.tool_call_id, "call_read_1");
  assert.equal(openaiMsgs[2]!.content, '{"name":"demo"}');
  assert.equal(openaiMsgs[3]!.role, "tool");
  assert.equal(openaiMsgs[3]!.tool_call_id, "call_bash_2");
  assert.equal(openaiMsgs[3]!.content, "ERROR: exit code 1");
  assert.equal(openaiMsgs[4]!.role, "assistant");
  assert.equal(openaiMsgs[5]!.role, "tool");
  assert.match(String(openaiMsgs[5]!.content), /^INTERRUPTED:/);

  // 2. Anthropic wire format: assistant tool_use blocks followed by user tool_result blocks, merged when consecutive same-role
  const anthropicProfile = resolveModelProfile("claude-sonnet-4-20250514");
  const anthropicPayload = buildProviderWirePayload(
    {
      runId: "run_1",
      sessionId: "sess_1",
      model: "claude-sonnet-4-20250514",
      systemPrompt: "You are a coding agent.",
      messages: history,
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    },
    anthropicProfile
  );
  const anthTools = anthropicPayload.tools!;
  assert.equal(anthTools.length, 1);
  assert.equal(anthTools[0]!.name, "read_file");
  assert.ok(anthTools[0]!.input_schema);
  assert.equal("type" in anthTools[0]!, false, "Anthropic tool must not include type field (M2)");
  assert.equal("function" in anthTools[0]!, false, "Anthropic tool must not include function field (M2)");

  const anthMsgs = anthropicPayload.messages!;
  assert.equal(anthMsgs[0]!.role, "user");
  assert.equal(anthMsgs[1]!.role, "assistant");
  const asstBlocks = anthMsgs[1]!.content as Array<Record<string, unknown>>;
  assert.equal(asstBlocks[0]!.type, "text");
  assert.equal(asstBlocks[1]!.type, "tool_use");
  assert.equal(asstBlocks[2]!.type, "tool_use");
  assert.equal(anthMsgs[2]!.role, "user");
  const userBlocks = anthMsgs[2]!.content as Array<Record<string, unknown>>;
  assert.equal(userBlocks[0]!.type, "tool_result");
  assert.equal(userBlocks[1]!.type, "tool_result");
  assert.equal(userBlocks[1]!.is_error, true);

  // 3. Text-mode tool calling
  const textProfile = { ...openaiProfile, toolCalling: "text" as const };
  const textMsgs = toWireMessages(history, textProfile);
  assert.ok(String(textMsgs[1]!.content).includes("<tool_call>"));
  assert.ok(String(textMsgs[2]!.content).includes('<tool_result name="read_file">'));

  // 4. Sanitize tool call IDs to ^[a-zA-Z0-9_-]{1,64}$
  const sanitized = synthesizeToolCallId("run:with/bad.chars", 1, "bad id!@#$%^&*()");
  assert.match(sanitized, /^[a-zA-Z0-9_-]{1,64}$/);
});
