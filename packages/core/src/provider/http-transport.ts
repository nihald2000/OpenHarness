import type { ModelProfile } from "./profiles.ts";
import type { ProviderRequestWirePayload, RawProviderResponse } from "./adapter.ts";

export class ProviderHttpError extends Error {
  status: number;
  headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.headers = headers;
  }
}

export type Endpoint = { baseUrl: string; apiKey?: string };
export type ResolvedEndpoint = (profile: ModelProfile, model: string) => Promise<Endpoint>;
export type TransportOpts = { idleTimeoutMs?: number; signal?: AbortSignal };

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const active = signals.filter((s): s is AbortSignal => Boolean(s));
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any(active);
  }
  const ctrl = new AbortController();
  for (const s of active) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      return ctrl.signal;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

export function createHttpTransport(resolve: ResolvedEndpoint) {
  return async (
    payload: ProviderRequestWirePayload,
    profile: ModelProfile,
    opts: TransportOpts = {}
  ): Promise<RawProviderResponse> => {
    const ep = await resolve(profile, payload.model);
    if (!ep.baseUrl) {
      throw new ProviderHttpError(400, `no baseUrl configured for ${payload.model}`);
    }
    if (profile.wire === "openai-chat") {
      return openaiChat(ep, payload, profile, opts);
    }
    if (profile.wire === "anthropic") {
      return anthropic(ep, payload, opts);
    }
    throw new ProviderHttpError(400, `wire "${profile.wire}" is not implemented`);
  };
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: TransportOpts
) {
  const idleAbort = new AbortController();
  const idleMs = opts.idleTimeoutMs ?? 90_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idleAbort.abort(new Error("idle timeout")), idleMs);
  };
  touch();
  const signal = combineAbortSignals([opts.signal, idleAbort.signal]);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      signal,
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    const hdrs: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      hdrs[k] = v;
    });
    throw new ProviderHttpError(res.status, `HTTP ${res.status}: ${text}`, hdrs);
  }
  return { res, touch, done: () => clearTimeout(timer) };
}

async function* sse(res: Response, touch: () => void): AsyncGenerator<any> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    touch();
    buf += value;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {
        /* ignore keep-alive noise */
      }
    }
  }
}

async function openaiChat(
  ep: Endpoint,
  payload: any,
  profile: ModelProfile,
  opts: TransportOpts
): Promise<RawProviderResponse> {
  const stream = payload.tools?.length ? profile.streamingToolCalls : true;
  const body = {
    ...payload,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
  const auth: Record<string, string> = ep.apiKey
    ? { authorization: `Bearer ${ep.apiKey}` }
    : {};
  const { res, touch, done } = await post(
    `${ep.baseUrl.replace(/\/$/, "")}/chat/completions`,
    auth,
    body,
    opts
  );
  try {
    if (!stream || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const j: any = await res.json();
      const m = j.choices?.[0]?.message ?? {};
      return {
        text: m.content ?? "",
        reasoning_content: m.reasoning_content,
        tool_calls: m.tool_calls,
        usage: j.usage,
      };
    }
    let text = "";
    let reasoning = "";
    let usage: any;
    const calls = new Map<number, { id?: string; name: string; args: string }>();
    for await (const ev of sse(res, touch)) {
      if (ev.error) {
        throw new ProviderHttpError(
          Number(ev.error.code) || 502,
          String(ev.error.message ?? "stream error")
        );
      }
      if (ev.usage) usage = ev.usage;
      const d = ev.choices?.[0]?.delta ?? {};
      if (typeof d.content === "string") text += d.content;
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === "string") reasoning += r;
      for (const tc of d.tool_calls ?? []) {
        const k = tc.index ?? calls.size;
        const c = calls.get(k) ?? { name: "", args: "" };
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
        calls.set(k, c);
      }
    }
    const tool_calls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => ({ id: c.id, function: { name: c.name, arguments: c.args } }));
    return { text, reasoning: reasoning || undefined, tool_calls, usage };
  } finally {
    done();
  }
}

async function anthropic(
  ep: Endpoint,
  payload: any,
  opts: TransportOpts
): Promise<RawProviderResponse> {
  const headers = {
    "x-api-key": ep.apiKey ?? "",
    "anthropic-version": "2023-06-01",
  };
  const { res, touch, done } = await post(
    `${ep.baseUrl.replace(/\/$/, "")}/messages`,
    headers,
    { ...payload, stream: true },
    opts
  );
  try {
    let text = "";
    let thinking = "";
    const usage = { input: 0, output: 0, cache_read_input_tokens: 0 };
    const tools = new Map<number, { id: string; name: string; json: string }>();
    for await (const ev of sse(res, touch)) {
      if (ev.type === "message_start") {
        usage.input = ev.message?.usage?.input_tokens ?? 0;
        usage.cache_read_input_tokens = ev.message?.usage?.cache_read_input_tokens ?? 0;
      } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        tools.set(ev.index, {
          id: ev.content_block.id,
          name: ev.content_block.name,
          json: "",
        });
      } else if (ev.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta") text += ev.delta.text;
        else if (ev.delta?.type === "thinking_delta") thinking += ev.delta.thinking;
        else if (ev.delta?.type === "input_json_delta" && tools.has(ev.index)) {
          tools.get(ev.index)!.json += ev.delta.partial_json;
        }
      } else if (ev.type === "message_delta") {
        usage.output = ev.usage?.output_tokens ?? usage.output;
      } else if (ev.type === "error") {
        throw new ProviderHttpError(
          ev.error?.type === "overloaded_error" ? 529 : 502,
          ev.error?.message ?? "stream error"
        );
      }
    }
    return {
      text,
      thinking: thinking || undefined,
      usage,
      tool_calls: [...tools.values()].map((t) => ({
        id: t.id,
        name: t.name,
        arguments: t.json || "{}",
      })),
    };
  } finally {
    done();
  }
}
