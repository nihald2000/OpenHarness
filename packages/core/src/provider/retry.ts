export type ErrorCategory = "retryable" | "terminal" | "context_overflow";

export interface ClassifiedProviderError {
  category: ErrorCategory;
  status?: number;
  retryAfterMs?: number;
  reason: string;
  overloaded?: boolean;
}

/**
 * Classifies provider HTTP and network errors (§4 B.3):
 * - retryable: 429, 408, 409, 5xx, network reset, timeout, provider overloaded
 * - context_overflow: prompt too long / maximum context length exceeded
 * - terminal: 400 schema errors, 401/403 auth errors, content filter
 */
export function classifyProviderError(err: unknown): ClassifiedProviderError {
  const msg = err instanceof Error ? err.message : String(err);
  const status =
    typeof (err as { status?: number })?.status === "number"
      ? (err as { status: number }).status
      : extractStatusFromMessage(msg);
  const headers = (err as { headers?: Record<string, string> | Headers })?.headers;
  const retryAfterMs = parseRetryAfterMs(headers);

  // Check context overflow patterns first
  if (
    /context_length_exceeded|maximum context length|prompt is too long|too many tokens|context window/i.test(
      msg
    )
  ) {
    return {
      category: "context_overflow",
      status,
      reason: msg,
    };
  }

  if (status === 429 || status === 408 || status === 409 || (status && status >= 500 && status < 600)) {
    return {
      category: "retryable",
      status,
      retryAfterMs,
      reason: `HTTP ${status}: ${msg}`,
      overloaded: status === 429 || status === 503 || status === 529,
    };
  }

  if (
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|idle timeout|overloaded|rate limit/i.test(
      msg
    )
  ) {
    return {
      category: "retryable",
      status,
      retryAfterMs,
      reason: msg,
      overloaded: /overloaded|rate limit/i.test(msg),
    };
  }

  return {
    category: "terminal",
    status,
    reason: msg,
  };
}

function extractStatusFromMessage(msg: string): number | undefined {
  const m = msg.match(/\bHTTP\s+(\d{3})\b/i) ?? msg.match(/\bstatus\s+(\d{3})\b/i);
  return m ? Number.parseInt(m[1]!, 10) : undefined;
}

export function parseRetryAfterMs(
  headers?: Record<string, string> | Headers
): number | undefined {
  if (!headers) return undefined;
  const getHeader = (name: string): string | null => {
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(name);
    }
    const rec = headers as Record<string, string>;
    for (const [k, v] of Object.entries(rec)) {
      if (k.toLowerCase() === name.toLowerCase()) return v;
    }
    return null;
  };

  const retryAfterMsRaw = getHeader("retry-after-ms");
  if (retryAfterMsRaw) {
    const ms = Number.parseFloat(retryAfterMsRaw);
    if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);
  }

  const retryAfter = getHeader("retry-after");
  if (retryAfter) {
    const secs = Number.parseFloat(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.ceil(secs * 1000);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }
  }
  return undefined;
}

export interface RetryOptions {
  maxAttempts?: number; // default 8
  maxTotalRetryMs?: number; // default 10 minutes (600,000 ms)
  baseDelayMs?: number; // default 500 ms
  maxDelayMs?: number; // default 60,000 ms
  random?: () => number; // injectable for deterministic tests
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => Promise<void> | void;
}

/**
 * Computes exponential backoff with full jitter, honoring Retry-After when present (§4 B.3).
 */
export function computeBackoffDelayMs(
  attempt: number,
  opts?: {
    retryAfterMs?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    random?: () => number;
  }
): number {
  const base = opts?.baseDelayMs ?? 500;
  const max = opts?.maxDelayMs ?? 60_000;
  const rng = opts?.random ?? Math.random;
  const expCap = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jittered = Math.floor(rng() * expCap);
  if (opts?.retryAfterMs !== undefined && opts.retryAfterMs > 0) {
    return Math.max(opts.retryAfterMs, jittered);
  }
  return Math.max(50, jittered);
}

/**
 * Executes an async provider call with exponential backoff, Retry-After support,
 * `run.retry` event emission, and optional fallbackModels switching (§4 B.3).
 */
export async function executeWithRetryAndFallback<T>(
  primaryModel: string,
  fn: (modelId: string, attempt: number) => Promise<T>,
  opts?: RetryOptions & {
    fallbackModels?: string[];
    switchAfterOverloadedAttempts?: number;
    onModelSwitch?: (fromModel: string, toModel: string, reason: string) => Promise<void> | void;
  }
): Promise<{ result: T; modelUsed: string; attempts: number }> {
  const maxAttempts = opts?.maxAttempts ?? 8;
  const maxTotalRetryMs = opts?.maxTotalRetryMs ?? 600_000;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const fallbacks = opts?.fallbackModels ?? [];
  const switchThreshold = opts?.switchAfterOverloadedAttempts ?? 3;

  let currentModel = primaryModel;
  let fallbackIdx = 0;
  let overloadedStreak = 0;
  let totalWaitedMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn(currentModel, attempt);
      return { result, modelUsed: currentModel, attempts: attempt };
    } catch (err) {
      const classified = classifyProviderError(err);
      if (classified.category !== "retryable" || attempt === maxAttempts) {
        throw err;
      }

      if (classified.overloaded) {
        overloadedStreak += 1;
        if (overloadedStreak >= switchThreshold && fallbackIdx < fallbacks.length) {
          const nextModel = fallbacks[fallbackIdx++]!;
          const prevModel = currentModel;
          currentModel = nextModel;
          overloadedStreak = 0;
          await opts?.onModelSwitch?.(prevModel, nextModel, classified.reason);
        }
      }

      const delayMs = computeBackoffDelayMs(attempt, {
        retryAfterMs: classified.retryAfterMs,
        baseDelayMs: opts?.baseDelayMs,
        maxDelayMs: opts?.maxDelayMs,
        random: opts?.random,
      });

      if (totalWaitedMs + delayMs > maxTotalRetryMs) {
        throw err;
      }

      totalWaitedMs += delayMs;
      await opts?.onRetry?.({
        attempt,
        delayMs,
        reason: classified.reason,
      });
      await sleep(delayMs);
    }
  }

  throw new Error("Exhausted retry attempts");
}

/**
 * Wait-for-capacity rate pacer for TPM and RPM limits (§4 B.3).
 * Waits instead of throwing when capacity is temporarily exceeded.
 */
export class CapacityPacer {
  private rpmLimit?: number;
  private tpmLimit?: number;
  private windowStartMs = 0;
  private requestsInWindow = 0;
  private tokensInWindow = 0;

  constructor(opts?: { rpmLimit?: number; tpmLimit?: number }) {
    this.rpmLimit = opts?.rpmLimit;
    this.tpmLimit = opts?.tpmLimit;
  }

  async waitForCapacity(
    estimatedTokens: number,
    clock: { now(): number; sleep(ms: number): Promise<void> },
    maxWaitMs = 300_000
  ): Promise<number> {
    let waited = 0;
    while (true) {
      const now = clock.now();
      if (now - this.windowStartMs >= 60_000) {
        this.windowStartMs = now;
        this.requestsInWindow = 0;
        this.tokensInWindow = 0;
      }

      const rpmExceeded =
        this.rpmLimit !== undefined && this.rpmLimit > 0 && this.requestsInWindow >= this.rpmLimit;
      const tpmExceeded =
        this.tpmLimit !== undefined &&
        this.tpmLimit > 0 &&
        this.tokensInWindow + estimatedTokens > this.tpmLimit &&
        this.tokensInWindow > 0;

      if (!rpmExceeded && !tpmExceeded) {
        this.requestsInWindow += 1;
        this.tokensInWindow += estimatedTokens;
        return waited;
      }

      const remainingWindowMs = Math.max(50, 60_000 - (now - this.windowStartMs));
      if (waited + remainingWindowMs > maxWaitMs) {
        throw new Error("Timed out waiting for TPM/RPM rate-limit capacity");
      }
      await clock.sleep(remainingWindowMs);
      waited += remainingWindowMs;
    }
  }
}
