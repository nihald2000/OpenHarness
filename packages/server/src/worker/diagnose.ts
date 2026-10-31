import type { ErrorDiagnostic } from "./types.ts";

export function diagnoseError(err: unknown): ErrorDiagnostic {
  const rawMessage = err instanceof Error ? err.message : String(err ?? "Unknown error");
  const status = (err as any)?.status ?? (err as any)?.statusCode;
  const codeProp = (err as any)?.code;
  const lower = rawMessage.toLowerCase();

  if (codeProp === "CANCELLED" || lower.includes("cancelled") || lower.includes("aborted")) {
    return {
      code: "CANCELLED",
      message: "Run was cancelled.",
      recoverable: true,
      detail: rawMessage,
    };
  }

  if (
    status === 401 ||
    status === 403 ||
    lower.includes("missing api key") ||
    lower.includes("invalid api key") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication")
  ) {
    return {
      code: "AUTH_ERROR",
      message: `Model authentication failed: ${rawMessage}. Check your API key in Settings -> Secrets.`,
      recoverable: false,
      detail: rawMessage,
    };
  }

  if (
    lower.includes("insufficient_quota") ||
    lower.includes("quota exceeded") ||
    lower.includes("credit balance is too low") ||
    lower.includes("billing")
  ) {
    return {
      code: "QUOTA_EXCEEDED",
      message: `Provider quota or credit balance exceeded: ${rawMessage}`,
      recoverable: false,
      detail: rawMessage,
    };
  }

  if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return {
      code: "RATE_LIMIT",
      message: `Model rate limit reached: ${rawMessage}. Retry in a moment.`,
      recoverable: true,
      detail: rawMessage,
    };
  }

  if (
    lower.includes("context_length_exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long")
  ) {
    return {
      code: "CONTEXT_OVERFLOW",
      message: "Conversation exceeded the model's context window.",
      recoverable: true,
      detail: rawMessage,
    };
  }

  if (
    lower.includes("modal sandbox failed to become healthy") ||
    lower.includes("sandbox boot") ||
    lower.includes("timed out waiting for /health")
  ) {
    return {
      code: "SANDBOX_BOOT_FAILED",
      message: `Cloud sandbox failed to start: ${rawMessage}`,
      recoverable: true,
      detail: rawMessage,
    };
  }

  if (lower.includes("sandbox unavailable") || lower.includes("sandbox runtime")) {
    return {
      code: "SANDBOX_UNAVAILABLE",
      message: `Sandbox unavailable: ${rawMessage}`,
      recoverable: true,
      detail: rawMessage,
    };
  }

  if (codeProp === "FIRST_ACTIVITY_TIMEOUT" || lower.includes("first activity timeout")) {
    return {
      code: "FIRST_ACTIVITY_TIMEOUT",
      message: "Run timed out waiting for first model or sandbox response.",
      recoverable: true,
      detail: rawMessage,
    };
  }

  if (codeProp === "TOOL_TIMEOUT" || lower.includes("tool execution timed out")) {
    return {
      code: "TOOL_TIMEOUT",
      message: `A tool call timed out: ${rawMessage}`,
      recoverable: true,
      detail: rawMessage,
    };
  }

  if (codeProp === "RUN_STALLED" || lower.includes("stalled")) {
    return {
      code: "RUN_STALLED",
      message: `Run stalled without heartbeat: ${rawMessage}`,
      recoverable: true,
      detail: rawMessage,
    };
  }

  if (codeProp === "TOOL_LOOP" || lower.includes("tool loop detected")) {
    return {
      code: "TOOL_LOOP",
      message: rawMessage,
      recoverable: false,
      detail: rawMessage,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: rawMessage || "An unexpected error occurred during the run.",
    recoverable: true,
    detail: rawMessage,
  };
}
