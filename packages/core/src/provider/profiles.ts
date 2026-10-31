export interface ModelProfile {
  wire: "openai-chat" | "openai-responses" | "anthropic" | "bedrock-converse" | "gemini";
  contextWindow: number; // the SERVED window, not the marketing number
  maxOutputTokens: number;
  outputParam: "max_tokens" | "max_completion_tokens";
  toolCalling: "native" | "native-unreliable" | "text" | "none";
  streamingToolCalls: boolean; // false for Bedrock Llama
  parallelToolCalls: "supported" | "unsupported" | "unknown";
  promptCaching: "automatic" | "explicit" | "none";
  reasoningField?: "reasoning_content" | "reasoning" | "thinking";
  usageInStream: boolean;
  strictSchemas: boolean; // whether `strict: true` / json_schema is honoured
  maxTools?: number; // cap on advertised tools for weaker models
  baseUrl?: string;
  apiKeyEnv?: string;
}

export const CONSERVATIVE_DEFAULT_PROFILE: ModelProfile = {
  wire: "openai-chat",
  contextWindow: 32_000,
  maxOutputTokens: 4096,
  outputParam: "max_tokens",
  toolCalling: "native-unreliable",
  streamingToolCalls: true,
  parallelToolCalls: "unknown",
  promptCaching: "none",
  usageInStream: false,
  strictSchemas: false,
  maxTools: 32,
};

export const BUILT_IN_MODEL_PROFILES: Record<string, ModelProfile> = {
  // OpenAI GPT-4.x / GPT-5.x
  "gpt-4o": {
    wire: "openai-chat",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    outputParam: "max_completion_tokens",
    toolCalling: "native",
    streamingToolCalls: true,
    parallelToolCalls: "supported",
    promptCaching: "automatic",
    usageInStream: true,
    strictSchemas: true,
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  "gpt-4o-mini": {
    wire: "openai-chat",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    outputParam: "max_completion_tokens",
    toolCalling: "native",
    streamingToolCalls: true,
    parallelToolCalls: "supported",
    promptCaching: "automatic",
    usageInStream: true,
    strictSchemas: true,
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  "gpt-4.1": {
    wire: "openai-chat",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    outputParam: "max_completion_tokens",
    toolCalling: "native",
    streamingToolCalls: true,
    parallelToolCalls: "supported",
    promptCaching: "automatic",
    usageInStream: true,
    strictSchemas: true,
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  "gpt-5": {
    wire: "openai-responses",
    contextWindow: 400_000,
    maxOutputTokens: 64_000,
    outputParam: "max_completion_tokens",
    toolCalling: "native",
    streamingToolCalls: true,
    parallelToolCalls: "supported",
    promptCaching: "automatic",
    reasoningField: "reasoning",
    usageInStream: true,
    strictSchemas: true,
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },

  // Anthropic Claude (native wire with explicit cache breakpoints)
  "claude-3-7-sonnet": {
    wire: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    outputParam: "max_tokens",
    toolCalling: "native",
    streamingToolCalls: true,
    parallelToolCalls: "supported",
    promptCaching: "explicit",
    reasoningField: "thinking",
    usageInStream: true,
    strictSchemas: false,
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  "claude-sonnet-4": {
    wire: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    outputParam: "max_tokens",
    toolCalling: "native",
    streamingToolCalls: true,
    parallelToolCalls: "supported",
    promptCaching: "explicit",
    reasoningField: "thinking",
    usageInStream: true,
    strictSchemas: false,
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  "claude-opus-4": {
    wire: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    outputParam: "max_tokens",
    toolCalling: "native",
    streamingToolCalls: true,
    parallelToolCalls: "supported",
    promptCaching: "explicit",
    reasoningField: "thinking",
    usageInStream: true,
    strictSchemas: false,
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },

  // Meta Llama API (https://api.llama.com/compat/v1, LLAMA_API_KEY)
  "Llama-4-Maverick-17B-128E-Instruct-FP8": {
    wire: "openai-chat",
    contextWindow: 256_000,
    maxOutputTokens: 8192,
    outputParam: "max_completion_tokens",
    toolCalling: "native-unreliable",
    streamingToolCalls: true,
    parallelToolCalls: "unsupported",
    promptCaching: "none",
    usageInStream: true,
    strictSchemas: false,
    maxTools: 28,
    baseUrl: "https://api.llama.com/compat/v1",
    apiKeyEnv: "LLAMA_API_KEY",
  },
  "Llama-4-Scout-17B-16E-Instruct-FP8": {
    wire: "openai-chat",
    contextWindow: 256_000,
    maxOutputTokens: 8192,
    outputParam: "max_completion_tokens",
    toolCalling: "native-unreliable",
    streamingToolCalls: true,
    parallelToolCalls: "unsupported",
    promptCaching: "none",
    usageInStream: true,
    strictSchemas: false,
    maxTools: 28,
    baseUrl: "https://api.llama.com/compat/v1",
    apiKeyEnv: "LLAMA_API_KEY",
  },
  "Llama-3.3-70B-Instruct": {
    wire: "openai-chat",
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    outputParam: "max_completion_tokens",
    toolCalling: "native-unreliable",
    streamingToolCalls: true,
    parallelToolCalls: "unsupported",
    promptCaching: "none",
    usageInStream: true,
    strictSchemas: false,
    maxTools: 24,
    baseUrl: "https://api.llama.com/compat/v1",
    apiKeyEnv: "LLAMA_API_KEY",
  },

  // Groq (Llama 4 served at 128K)
  "groq/llama-4-maverick": {
    wire: "openai-chat",
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    outputParam: "max_completion_tokens",
    toolCalling: "native-unreliable",
    streamingToolCalls: true,
    parallelToolCalls: "unsupported",
    promptCaching: "none",
    usageInStream: true,
    strictSchemas: false,
    maxTools: 24,
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
  },

  // Together AI
  "together/Llama-3.3-70B-Instruct-Turbo": {
    wire: "openai-chat",
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    outputParam: "max_tokens",
    toolCalling: "native-unreliable",
    streamingToolCalls: true,
    parallelToolCalls: "unsupported",
    promptCaching: "none",
    reasoningField: "reasoning_content",
    usageInStream: true,
    strictSchemas: false,
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
  },

  // Fireworks AI (usageInStream: true, silently truncates output -> safe maxOutputTokens)
  "fireworks/llama-v3p3-70b-instruct": {
    wire: "openai-chat",
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    outputParam: "max_tokens",
    toolCalling: "native-unreliable",
    streamingToolCalls: true,
    parallelToolCalls: "unsupported",
    promptCaching: "none",
    usageInStream: true,
    strictSchemas: false,
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: "FIREWORKS_API_KEY",
  },

  // Ollama local models
  "local-llama": {
    wire: "openai-chat",
    contextWindow: 65_536,
    maxOutputTokens: 4096,
    outputParam: "max_tokens",
    toolCalling: "native-unreliable",
    streamingToolCalls: true,
    parallelToolCalls: "unsupported",
    promptCaching: "none",
    usageInStream: false,
    strictSchemas: false,
    maxTools: 20,
    baseUrl: "http://127.0.0.1:11434/v1",
  },

  // vLLM / LiteLLM generic
  "vllm/generic": {
    wire: "openai-chat",
    contextWindow: 64_000,
    maxOutputTokens: 8192,
    outputParam: "max_tokens",
    toolCalling: "native-unreliable",
    streamingToolCalls: true,
    parallelToolCalls: "unknown",
    promptCaching: "none",
    reasoningField: "reasoning_content",
    usageInStream: true,
    strictSchemas: false,
  },
  "litellm/generic": {
    wire: "openai-chat",
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    outputParam: "max_tokens",
    toolCalling: "native-unreliable",
    streamingToolCalls: true,
    parallelToolCalls: "unknown",
    promptCaching: "none",
    usageInStream: true,
    strictSchemas: false,
  },

  // AWS Bedrock Converse (Llama: streamingToolCalls: false, 8K output cap)
  "bedrock/llama-3-3-70b": {
    wire: "bedrock-converse",
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    outputParam: "max_tokens",
    toolCalling: "native-unreliable",
    streamingToolCalls: false,
    parallelToolCalls: "unsupported",
    promptCaching: "none",
    usageInStream: false,
    strictSchemas: false,
    maxTools: 20,
  },

  // Gemini OpenAI-compat
  "gemini-2.5-pro": {
    wire: "gemini",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    outputParam: "max_tokens",
    toolCalling: "native",
    streamingToolCalls: true,
    parallelToolCalls: "supported",
    promptCaching: "automatic",
    reasoningField: "reasoning",
    usageInStream: true,
    strictSchemas: true,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
  },
  "gemini-2.5-flash": {
    wire: "gemini",
    contextWindow: 1_000_000,
    maxOutputTokens: 16_384,
    outputParam: "max_tokens",
    toolCalling: "native",
    streamingToolCalls: true,
    parallelToolCalls: "supported",
    promptCaching: "automatic",
    usageInStream: true,
    strictSchemas: true,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
  },

  // Offline mock provider
  "mock/demo": {
    wire: "openai-chat",
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    outputParam: "max_tokens",
    toolCalling: "native",
    streamingToolCalls: true,
    parallelToolCalls: "supported",
    promptCaching: "none",
    usageInStream: true,
    strictSchemas: true,
  },
};

const measuredProfiles = new Map<string, ModelProfile>();

export function registerMeasuredProfile(modelId: string, profile: ModelProfile): void {
  measuredProfiles.set(modelId, profile);
}

export function resolveModelProfile(
  modelId: string,
  overrides?: Record<string, Partial<ModelProfile>>
): ModelProfile {
  if (measuredProfiles.has(modelId)) {
    return {
      ...measuredProfiles.get(modelId)!,
      ...(overrides?.[modelId] ?? {}),
    };
  }
  if (BUILT_IN_MODEL_PROFILES[modelId]) {
    return {
      ...BUILT_IN_MODEL_PROFILES[modelId]!,
      ...(overrides?.[modelId] ?? {}),
    };
  }

  // Prefix-based resolution for provider namespaces
  if (modelId.startsWith("Llama-") || modelId.startsWith("meta-llama/")) {
    return {
      ...BUILT_IN_MODEL_PROFILES["Llama-4-Maverick-17B-128E-Instruct-FP8"]!,
      ...(overrides?.[modelId] ?? {}),
    };
  }
  if (modelId.startsWith("groq/")) {
    return {
      ...BUILT_IN_MODEL_PROFILES["groq/llama-4-maverick"]!,
      ...(overrides?.[modelId] ?? {}),
    };
  }
  if (modelId.startsWith("together/")) {
    return {
      ...BUILT_IN_MODEL_PROFILES["together/Llama-3.3-70B-Instruct-Turbo"]!,
      ...(overrides?.[modelId] ?? {}),
    };
  }
  if (modelId.startsWith("fireworks/")) {
    return {
      ...BUILT_IN_MODEL_PROFILES["fireworks/llama-v3p3-70b-instruct"]!,
      ...(overrides?.[modelId] ?? {}),
    };
  }
  if (modelId.startsWith("ollama/")) {
    return {
      ...BUILT_IN_MODEL_PROFILES["local-llama"]!,
      ...(overrides?.[modelId] ?? {}),
    };
  }
  if (modelId.startsWith("bedrock/")) {
    return {
      ...BUILT_IN_MODEL_PROFILES["bedrock/llama-3-3-70b"]!,
      ...(overrides?.[modelId] ?? {}),
    };
  }
  if (modelId.startsWith("claude-")) {
    return {
      ...BUILT_IN_MODEL_PROFILES["claude-3-7-sonnet"]!,
      ...(overrides?.[modelId] ?? {}),
    };
  }
  if (modelId.startsWith("gpt-")) {
    return {
      ...BUILT_IN_MODEL_PROFILES["gpt-4o"]!,
      ...(overrides?.[modelId] ?? {}),
    };
  }
  if (modelId.startsWith("gemini-")) {
    return {
      ...BUILT_IN_MODEL_PROFILES["gemini-2.5-pro"]!,
      ...(overrides?.[modelId] ?? {}),
    };
  }

  // Fail closed to conservative default (§0 rule 10, §4 B.1)
  return {
    ...CONSERVATIVE_DEFAULT_PROFILE,
    ...(overrides?.[modelId] ?? {}),
  };
}

export interface ProbeTransportResult {
  toolCallSucceeded: boolean;
  streamingToolCallSucceeded: boolean;
  usageReported: boolean;
  acceptedMaxCompletionTokens: boolean;
  measuredContextWindow?: number;
}

/**
 * Empirically probes a model (`oh model probe <id>`) and stores the measured profile (§4 B.1).
 */
export async function probeModelCapabilities(
  modelId: string,
  probeFn?: (modelId: string) => Promise<ProbeTransportResult>
): Promise<ModelProfile> {
  const base = resolveModelProfile(modelId);
  if (!probeFn) {
    registerMeasuredProfile(modelId, base);
    return base;
  }
  const result = await probeFn(modelId);
  const measured: ModelProfile = {
    ...base,
    outputParam: result.acceptedMaxCompletionTokens ? "max_completion_tokens" : "max_tokens",
    toolCalling: result.toolCallSucceeded ? "native" : "text",
    streamingToolCalls: result.streamingToolCallSucceeded,
    usageInStream: result.usageReported,
    contextWindow: result.measuredContextWindow ?? base.contextWindow,
  };
  registerMeasuredProfile(modelId, measured);
  return measured;
}
