import type { TokenUsage } from "@openharness/sdk";
import type {
  ProviderAdapter,
  ProviderToolCall,
  ProviderTurnRequest,
  ProviderTurnResponse,
} from "../agent/deps.ts";
import type { ModelProfile } from "./profiles.ts";
import { resolveModelProfile } from "./profiles.ts";
import { CapacityPacer, executeWithRetryAndFallback } from "./retry.ts";
import {
  parseTextToolCalls,
  renderToolsForTextModelPrompt,
  repairToolArgumentsJson,
  synthesizeToolCallId,
} from "./toolcall.ts";

export interface ProviderRequestWirePayload {
  model: string;
  stream: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  parallel_tool_calls?: boolean;
  messages?: Array<Record<string, unknown>>;
  system?: unknown;
  tools?: Array<Record<string, unknown>>;
}

/**
 * Builds the wire payload for a model turn according to its resolved ModelProfile (§4 B.1, B.2, B.4).
 */
export function buildProviderWirePayload(
  req: ProviderTurnRequest,
  profile: ModelProfile
): ProviderRequestWirePayload {
  const unmaskedTools = req.tools.filter((t) => !t.masked);
  const advertisedTools =
    profile.maxTools && unmaskedTools.length > profile.maxTools
      ? unmaskedTools.slice(0, profile.maxTools)
      : unmaskedTools;

  const hasTools = advertisedTools.length > 0 && profile.toolCalling !== "none";
  const effectiveMaxOutput = Math.min(
    profile.maxOutputTokens,
    req.maxOutputTokens ?? profile.maxOutputTokens
  );

  let systemPrompt = req.systemPrompt;
  if (hasTools && profile.toolCalling === "text") {
    systemPrompt = `${systemPrompt}\n\n${renderToolsForTextModelPrompt(advertisedTools)}`;
  }

  // When streamingToolCalls is false and tools are advertised, force non-streaming (§4 B.2)
  const useStreaming = hasTools && !profile.streamingToolCalls ? false : true;

  const payload: ProviderRequestWirePayload = {
    model: req.model,
    stream: useStreaming,
  };

  if (profile.outputParam === "max_completion_tokens") {
    payload.max_completion_tokens = effectiveMaxOutput;
  } else {
    payload.max_tokens = effectiveMaxOutput;
  }

  // Only include parallel_tool_calls when explicitly supported (§0.2 Meta Llama API, §4 B.1)
  if (hasTools && profile.toolCalling !== "text" && profile.parallelToolCalls === "supported") {
    payload.parallel_tool_calls = true;
  }

  // Format messages deterministically
  const wireMessages: Array<Record<string, unknown>> = [];
  if (profile.wire === "anthropic") {
    // Explicit cache breakpoint on system prompt (§7 E.1)
    payload.system = [
      {
        type: "text",
        text: systemPrompt,
        ...(profile.promptCaching === "explicit"
          ? { cache_control: { type: "ephemeral" } }
          : {}),
      },
    ];
  } else {
    wireMessages.push({ role: "system", content: systemPrompt });
  }

  req.messages.forEach((m, idx) => {
    const textContent = m.parts
      .filter((p) => p.type === "text" || p.type === "compaction")
      .map((p) => (p.type === "text" ? p.text : p.summary))
      .join("\n");

    const msgObj: Record<string, unknown> = {
      role: m.info.role,
      content: textContent,
    };

    if (
      profile.promptCaching === "explicit" &&
      m.info.summary &&
      idx === req.messages.findIndex((x) => x.info.summary)
    ) {
      msgObj.cache_control = { type: "ephemeral" };
    }
    wireMessages.push(msgObj);
  });

  payload.messages = wireMessages;

  if (hasTools && profile.toolCalling !== "text") {
    payload.tools = advertisedTools.map((t, idx) => {
      const fnDef: Record<string, unknown> = {
        name: t.name,
        description: t.description,
        parameters: sortJsonKeysDeterministically(t.parameters) as Record<string, unknown>,
      };
      if (profile.strictSchemas) {
        fnDef.strict = true;
      }
      const toolEntry: Record<string, unknown> = {
        type: "function",
        function: fnDef,
      };
      if (
        profile.promptCaching === "explicit" &&
        idx === advertisedTools.length - 1
      ) {
        toolEntry.cache_control = { type: "ephemeral" };
      }
      return toolEntry;
    });
  }

  return payload;
}

export function sortJsonKeysDeterministically(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonKeysDeterministically);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = sortJsonKeysDeterministically((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

export interface RawProviderResponse {
  text?: string;
  reasoning?: string;
  reasoning_content?: string;
  thinking?: string;
  tool_calls?: Array<{
    id?: string;
    name?: string;
    arguments?: string | Record<string, unknown>;
    function?: {
      name: string;
      arguments: string | Record<string, unknown>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input?: number;
    output?: number;
    reasoning_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface ModelAgnosticProviderOptions {
  transport: (
    payload: ProviderRequestWirePayload,
    profile: ModelProfile,
    opts: { idleTimeoutMs: number }
  ) => Promise<RawProviderResponse>;
  profileOverrides?: Record<string, Partial<ModelProfile>>;
  fallbackModels?: string[];
  idleTimeoutMs?: number; // default 90_000 ms (§4 B.3)
  maxRetryAttempts?: number;
  baseRetryDelayMs?: number;
  pacer?: CapacityPacer;
  clock?: { now(): number; sleep(ms: number): Promise<void> };
  pricingPerMillion?: Record<string, { input: number; output: number }>;
  onRetryEvent?: (ev: {
    sessionId: string;
    runId: string;
    attempt: number;
    delayMs: number;
    reason: string;
  }) => Promise<void> | void;
  onModelSwitch?: (fromModel: string, toModel: string, reason: string) => Promise<void> | void;
}

export class ModelAgnosticProviderAdapter implements ProviderAdapter {
  private opts: ModelAgnosticProviderOptions;

  constructor(opts: ModelAgnosticProviderOptions) {
    this.opts = opts;
  }

  async generateTurn(req: ProviderTurnRequest): Promise<ProviderTurnResponse> {
    const clock = this.opts.clock ?? {
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    };
    const idleTimeoutMs = this.opts.idleTimeoutMs ?? 90_000;

    // Estimate tokens for TPM/RPM wait-for-capacity pacer (§4 B.3)
    const estimatedInputTokens = Math.max(
      1,
      Math.ceil(
        (req.systemPrompt.length +
          JSON.stringify(req.messages).length +
          JSON.stringify(req.tools).length) /
          4
      )
    );

    if (this.opts.pacer) {
      await this.opts.pacer.waitForCapacity(estimatedInputTokens, clock);
    }

    const { result: raw, modelUsed } = await executeWithRetryAndFallback(
      req.model,
      async (activeModel) => {
        const profile = resolveModelProfile(activeModel, this.opts.profileOverrides);
        const wirePayload = buildProviderWirePayload(
          { ...req, model: activeModel },
          profile
        );
        return this.opts.transport(wirePayload, profile, { idleTimeoutMs });
      },
      {
        maxAttempts: this.opts.maxRetryAttempts ?? 8,
        baseDelayMs: this.opts.baseRetryDelayMs ?? 50,
        fallbackModels: this.opts.fallbackModels,
        sleep: (ms) => clock.sleep(ms),
        onRetry: async ({ attempt, delayMs, reason }) => {
          await this.opts.onRetryEvent?.({
            sessionId: req.sessionId,
            runId: req.runId,
            attempt,
            delayMs,
            reason,
          });
        },
        onModelSwitch: this.opts.onModelSwitch,
      }
    );

    const profile = resolveModelProfile(modelUsed, this.opts.profileOverrides);
    const advertisedNames = req.tools.filter((t) => !t.masked).map((t) => t.name);

    // Decode structured tool calls with ID synthesis and JSON repair (§4 B.2)
    const decodedCalls: ProviderToolCall[] = [];
    const rawToolCalls = raw.tool_calls ?? [];

    for (let i = 0; i < rawToolCalls.length; i++) {
      const tc = rawToolCalls[i]!;
      const name = tc.function?.name ?? tc.name ?? "";
      const rawArgs = tc.function?.arguments ?? tc.arguments ?? {};
      const repaired = repairToolArgumentsJson(rawArgs);
      decodedCalls.push({
        id: synthesizeToolCallId(req.runId, i + 1, tc.id),
        name,
        arguments: repaired.parsed,
      });
    }

    // Fallback text tool-call parser if no structured calls arrived and toolCalling is text or native-unreliable (§4 B.2)
    let rawTextToolCall = false;
    if (
      decodedCalls.length === 0 &&
      raw.text &&
      (profile.toolCalling === "text" || profile.toolCalling === "native-unreliable")
    ) {
      const fallbackCalls = parseTextToolCalls(raw.text, advertisedNames, req.runId, 1);
      if (fallbackCalls.length > 0) {
        rawTextToolCall = true;
        for (const fc of fallbackCalls) {
          decodedCalls.push({
            id: fc.id,
            name: fc.name,
            arguments: fc.arguments,
          });
        }
      }
    }

    // Extract reasoning field across provider conventions
    const reasoning =
      raw.reasoning ?? raw.reasoning_content ?? raw.thinking ?? undefined;

    // Usage reporting or estimation (§4 B.4)
    let usage: TokenUsage;
    if (
      raw.usage &&
      (typeof raw.usage.prompt_tokens === "number" || typeof raw.usage.input === "number")
    ) {
      usage = {
        input: raw.usage.prompt_tokens ?? raw.usage.input ?? 0,
        output: raw.usage.completion_tokens ?? raw.usage.output ?? 0,
        reasoning: raw.usage.reasoning_tokens,
        cacheRead: raw.usage.cache_read_input_tokens,
        estimated: false,
      };
    } else {
      const outText = (raw.text ?? "") + JSON.stringify(decodedCalls);
      usage = {
        input: estimatedInputTokens,
        output: Math.max(1, Math.ceil(outText.length / 4)),
        estimated: true,
      };
    }

    const price = this.opts.pricingPerMillion?.[modelUsed];
    const cost = price
      ? (usage.input * price.input + usage.output * price.output) / 1_000_000
      : undefined;

    return {
      text: raw.text ?? "",
      reasoning,
      toolCalls: decodedCalls,
      usage,
      cost,
      modelUsed,
      rawTextToolCall,
    };
  }
}
