export type ProviderToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type ProviderTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};
export type ProviderChunk = { type: "text"; text: string } | { type: "tool_calls"; calls: ProviderToolCall[] } | { type: "usage"; input: number; output: number };
export type ChatRequest = { model: string; messages: ChatMessage[]; tools?: ProviderTool[]; signal?: AbortSignal; apiKey?: string; baseUrl?: string; maxTokens?: number };
export type ChatProvider = { id: string; stream(request: ChatRequest): AsyncGenerator<ProviderChunk> };

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("The run was cancelled.", "AbortError");
}

const mockProvider: ChatProvider = {
  id: "mock",
  async *stream(request) {
    const latest = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const answer = `OpenHarness received your request: ${latest.trim()}`;
    const chunks = answer.match(/.{1,18}(?:\s|$)/g) ?? [answer];
    for (const chunk of chunks) {
      abortIfNeeded(request.signal);
      await new Promise((resolve) => setTimeout(resolve, 25));
      yield { type: "text", text: chunk };
    }
  },
};

const openAiProvider: ChatProvider = {
  id: "openai-compatible",
  async *stream(request) {
    const apiKey = request.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required when OPENHARNESS_PROVIDER=openai.");
    const baseUrl = (request.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })), tool_choice: "auto" } : {}),
      }),
      signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Provider request failed with HTTP ${response.status}.`);
    }
    if (!response.body) throw new Error("Provider returned an empty response stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    try {
      while (true) {
        abortIfNeeded(request.signal);
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let event: { choices?: Array<{ delta?: { content?: unknown; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
          try { event = JSON.parse(payload) as typeof event; } catch { continue; }
          if (event.usage && Number.isFinite(event.usage.prompt_tokens) && Number.isFinite(event.usage.completion_tokens)) {
            yield { type: "usage", input: Math.max(0, Math.floor(event.usage.prompt_tokens!)), output: Math.max(0, Math.floor(event.usage.completion_tokens!)) };
          }
          const content = event.choices?.[0]?.delta?.content;
          if (typeof content === "string" && content) yield { type: "text", text: content };
          for (const call of event.choices?.[0]?.delta?.tool_calls ?? []) {
            const index = Number.isInteger(call.index) ? call.index! : 0;
            const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
            if (typeof call.id === "string") current.id += call.id;
            if (typeof call.function?.name === "string") current.name += call.function.name;
            if (typeof call.function?.arguments === "string") current.arguments += call.function.arguments;
            toolCalls.set(index, current);
          }
        }
        if (done) break;
      }
      if (toolCalls.size) {
        const calls: ProviderToolCall[] = [];
        for (const [, call] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
          if (!call.id || !/^[a-zA-Z0-9_.-]{1,128}$/.test(call.name)) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(call.arguments); } catch { throw new Error(`Provider returned invalid arguments for tool ${call.name}.`); }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Provider returned non-object arguments for tool ${call.name}.`);
          calls.push({ id: call.id, name: call.name, arguments: parsed as Record<string, unknown> });
        }
        if (calls.length) yield { type: "tool_calls", calls };
      }
    } finally {
      reader.releaseLock();
    }
  },
};

export function getProvider(id = process.env.OPENHARNESS_PROVIDER ?? "mock"): ChatProvider {
  if (id === "mock") return mockProvider;
  if (id === "openai" || id === "openai-compatible") return openAiProvider;
  throw new Error(`Unknown provider "${id}". Supported providers: mock, openai.`);
}

export function defaultModel(provider = process.env.OPENHARNESS_PROVIDER ?? "mock") {
  return process.env.OPENHARNESS_MODEL ?? (provider === "mock" ? "mock/demo" : "gpt-4o-mini");
}
