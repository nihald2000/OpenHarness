import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  ModelAgnosticProviderAdapter,
  buildProviderRequestBody,
} from "../packages/core/src/provider/adapter.ts";
import { createHttpTransport, ProviderHttpError } from "../packages/core/src/provider/http-transport.ts";
import { resolveModelProfile } from "../packages/core/src/provider/profiles.ts";

test("Step 3 (R1): createHttpTransport handles OpenAI streaming SSE tool calls, Llama quirks, 429 Retry-After, Anthropic SSE tool_use, and AbortSignal cancellation", async () => {
  let llamaAttempts = 0;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

    if (req.url === "/v1/chat/completions" && body.model === "gpt-4o") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: "Checking file...",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_openai_1",
                    function: { name: "read_", arguments: '{"path":' },
                  },
                ],
              },
            },
          ],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: "file", arguments: '"src/index.ts"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 30 },
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (req.url === "/v1/chat/completions" && body.model === "Llama-4-Maverick-17B-128E-Instruct-FP8") {
      llamaAttempts++;
      if (llamaAttempts === 1) {
        res.writeHead(429, { "retry-after": "0.05", "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Rate limit exceeded" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '[read_file(path="README.md")]',
                tool_calls: [
                  {
                    // missing id + trailing comma JSON
                    function: { name: "list", arguments: '{"path": "src",}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 80, completion_tokens: 20 },
        })
      );
      return;
    }

    if (req.url === "/v1/messages" && body.model === "claude-3-7-sonnet") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: 210, cache_read_input_tokens: 150 } },
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_01", name: "edit" },
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":"a.ts",' },
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"old_str":"x","new_str":"y"}' },
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: 45 },
        })}\n\n`
      );
      res.end();
      return;
    }

    if (req.url === "/v1/chat/completions" && body.model === "slow-model") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Never ends until client aborts
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}/v1`;

  try {
    const transport = createHttpTransport(async () => ({
      baseUrl,
      apiKey: "test-key",
    }));

    const adapter = new ModelAgnosticProviderAdapter({
      transport,
      maxRetryAttempts: 3,
      baseRetryDelayMs: 10,
    });

    const tools = [
      {
        name: "read_file",
        description: "Read file",
        readOnly: true,
        parameters: { type: "object", properties: { path: { type: "string" } } },
        execute: async () => ({ output: "" }),
      },
      {
        name: "list",
        description: "List dir",
        readOnly: true,
        parameters: { type: "object", properties: { path: { type: "string" } } },
        execute: async () => ({ output: [] }),
      },
      {
        name: "edit",
        description: "Edit file",
        readOnly: false,
        parameters: { type: "object", properties: { path: { type: "string" } } },
        execute: async () => ({ output: {} }),
      },
    ];

    // 1. OpenAI streaming tool calls
    const resOpenAi = await adapter.generateTurn({
      runId: "run_http_1",
      sessionId: "sess_http_1",
      model: "gpt-4o",
      systemPrompt: "You are helpful.",
      messages: [],
      tools,
    });
    assert.equal(resOpenAi.text, "Checking file...");
    assert.equal(resOpenAi.toolCalls.length, 1);
    assert.equal(resOpenAi.toolCalls[0]!.id, "call_openai_1");
    assert.equal(resOpenAi.toolCalls[0]!.name, "read_file");
    assert.deepEqual(resOpenAi.toolCalls[0]!.arguments, { path: "src/index.ts" });
    assert.equal(resOpenAi.usage.input, 120);
    assert.equal(resOpenAi.usage.output, 30);

    // 2. Meta Llama 429 + Retry-After + missing tool call ID + trailing comma JSON
    const resLlama = await adapter.generateTurn({
      runId: "run_http_2",
      sessionId: "sess_http_2",
      model: "Llama-4-Maverick-17B-128E-Instruct-FP8",
      systemPrompt: "You are helpful.",
      messages: [],
      tools,
    });
    assert.equal(llamaAttempts, 2);
    assert.equal(resLlama.toolCalls.length, 1);
    assert.ok(resLlama.toolCalls[0]!.id.startsWith("call_run_http_2_"));
    assert.equal(resLlama.toolCalls[0]!.name, "list");
    assert.deepEqual(resLlama.toolCalls[0]!.arguments, { path: "src" });

    // 3. Anthropic wire format & SSE tool_use
    const anthropicProfile = resolveModelProfile("claude-3-7-sonnet");
    const wire = buildProviderRequestBody(
      {
        runId: "run_http_3",
        sessionId: "sess_http_3",
        model: "claude-3-7-sonnet",
        systemPrompt: "System instructions",
        messages: [],
        tools,
      },
      anthropicProfile
    );
    assert.ok(Array.isArray(wire.system), "Anthropic wire uses top-level system array");
    assert.ok(wire.tools?.[0]?.input_schema, "Anthropic tools include input_schema");

    const resAnthropic = await adapter.generateTurn({
      runId: "run_http_3",
      sessionId: "sess_http_3",
      model: "claude-3-7-sonnet",
      systemPrompt: "System instructions",
      messages: [],
      tools,
    });
    assert.equal(resAnthropic.toolCalls.length, 1);
    assert.equal(resAnthropic.toolCalls[0]!.id, "toolu_01");
    assert.equal(resAnthropic.toolCalls[0]!.name, "edit");
    assert.deepEqual(resAnthropic.toolCalls[0]!.arguments, {
      path: "a.ts",
      old_str: "x",
      new_str: "y",
    });
    assert.equal(resAnthropic.usage.input, 210);
    assert.equal(resAnthropic.usage.output, 45);
    assert.equal(resAnthropic.usage.cacheRead, 150);

    // 4. Cancellation via AbortSignal
    const abortCtrl = new AbortController();
    setTimeout(() => abortCtrl.abort(new Error("user cancelled")), 40);
    await assert.rejects(
      () =>
        adapter.generateTurn({
          runId: "run_http_4",
          sessionId: "sess_http_4",
          model: "slow-model",
          systemPrompt: "Wait",
          messages: [],
          tools: [],
          signal: abortCtrl.signal,
        }),
      /abort|cancel/i
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
