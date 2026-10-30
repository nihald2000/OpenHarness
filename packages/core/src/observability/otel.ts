import type { TokenUsage } from "@openharness/sdk";

export type GenAiSpanName =
  | "invoke_agent"
  | "chat"
  | "execute_tool"
  | "sandbox.create"
  | "sandbox.exec"
  | "verify.run"
  | "compaction";

export interface OtelSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: GenAiSpanName;
  startTimeUnixNano: number;
  endTimeUnixNano: number;
  durationMs: number;
  status: "OK" | "ERROR";
  attributes: Record<string, string | number | boolean>;
}

export interface OtlpExporterOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  transport?: (url: string, body: unknown, headers: Record<string, string>) => Promise<void>;
}

/**
 * OpenTelemetry tracer following GenAI semantic conventions (§12 Phase J):
 * Spans: `invoke_agent`, `chat` (with `gen_ai.usage.*`), `execute_tool`,
 * `sandbox.create`, `sandbox.exec`, `verify.run`, `compaction`.
 * Exports via OTLP when configured.
 */
export class OpenHarnessTracer {
  readonly spans: OtelSpanRecord[] = [];
  private exporterOpts?: OtlpExporterOptions;

  constructor(exporterOpts?: OtlpExporterOptions) {
    this.exporterOpts = exporterOpts;
  }

  private randomHex(bytes: number): string {
    let out = "";
    for (let i = 0; i < bytes * 2; i++) {
      out += Math.floor(Math.random() * 16).toString(16);
    }
    return out;
  }

  async withSpan<T>(
    name: GenAiSpanName,
    attributes: Record<string, string | number | boolean>,
    fn: (span: { setAttribute(k: string, v: string | number | boolean): void; spanId: string; traceId: string }) => Promise<T>,
    parent?: { traceId: string; spanId: string }
  ): Promise<T> {
    const traceId = parent?.traceId ?? this.randomHex(16);
    const spanId = this.randomHex(8);
    const startMs = Date.now();
    const spanAttrs: Record<string, string | number | boolean> = { ...attributes };

    const handle = {
      traceId,
      spanId,
      setAttribute: (k: string, v: string | number | boolean) => {
        spanAttrs[k] = v;
      },
    };

    try {
      const res = await fn(handle);
      const endMs = Date.now();
      const record: OtelSpanRecord = {
        traceId,
        spanId,
        parentSpanId: parent?.spanId,
        name,
        startTimeUnixNano: startMs * 1_000_000,
        endTimeUnixNano: endMs * 1_000_000,
        durationMs: Math.max(0, endMs - startMs),
        status: "OK",
        attributes: spanAttrs,
      };
      this.spans.push(record);
      await this.exportSpanIfConfigured(record);
      return res;
    } catch (err) {
      const endMs = Date.now();
      spanAttrs["error.message"] = err instanceof Error ? err.message : String(err);
      const record: OtelSpanRecord = {
        traceId,
        spanId,
        parentSpanId: parent?.spanId,
        name,
        startTimeUnixNano: startMs * 1_000_000,
        endTimeUnixNano: endMs * 1_000_000,
        durationMs: Math.max(0, endMs - startMs),
        status: "ERROR",
        attributes: spanAttrs,
      };
      this.spans.push(record);
      await this.exportSpanIfConfigured(record);
      throw err;
    }
  }

  recordChatSpan(params: {
    model: string;
    provider: string;
    usage: TokenUsage;
    durationMs: number;
    runId: string;
    traceId?: string;
    parentSpanId?: string;
  }): OtelSpanRecord {
    const now = Date.now();
    const record: OtelSpanRecord = {
      traceId: params.traceId ?? this.randomHex(16),
      spanId: this.randomHex(8),
      parentSpanId: params.parentSpanId,
      name: "chat",
      startTimeUnixNano: (now - params.durationMs) * 1_000_000,
      endTimeUnixNano: now * 1_000_000,
      durationMs: params.durationMs,
      status: "OK",
      attributes: {
        "gen_ai.system": params.provider,
        "gen_ai.request.model": params.model,
        "gen_ai.usage.input_tokens": params.usage.input,
        "gen_ai.usage.output_tokens": params.usage.output,
        "gen_ai.usage.reasoning_tokens": params.usage.reasoning ?? 0,
        "gen_ai.usage.cache_read_tokens": params.usage.cacheRead ?? 0,
        "gen_ai.usage.estimated": Boolean(params.usage.estimated),
        "openharness.run_id": params.runId,
      },
    };
    this.spans.push(record);
    void this.exportSpanIfConfigured(record);
    return record;
  }

  private async exportSpanIfConfigured(span: OtelSpanRecord): Promise<void> {
    const endpoint =
      this.exporterOpts?.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!endpoint) return;
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "openharness" } }],
          },
          scopeSpans: [{ spans: [span] }],
        },
      ],
    };
    if (this.exporterOpts?.transport) {
      await this.exporterOpts.transport(
        endpoint,
        payload,
        this.exporterOpts.headers ?? {}
      );
    }
  }
}
