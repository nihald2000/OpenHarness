export interface MetricsBucket {
  steps: number;
  toolCallsByTool: Record<string, number>;
  totalToolCalls: number;
  toolErrors: number;
  toolErrorRate: number;
  malformedCalls: number;
  malformedCallRate: number;
  retries: number;
  compactions: number;
  contextResets: number;
  tokensInMeasured: number;
  tokensOutMeasured: number;
  tokensInEstimated: number;
  tokensOutEstimated: number;
  costUsd: number;
  wallTimeMs: number;
  verificationRuns: number;
  verificationPasses: number;
  verificationPassRate: number;
  stuckEvents: number;
}

export interface RunMetricsReport {
  runId: string;
  sessionId: string;
  overall: MetricsBucket;
  byFeature: Record<string, MetricsBucket>;
}

function createEmptyBucket(): MetricsBucket {
  return {
    steps: 0,
    toolCallsByTool: {},
    totalToolCalls: 0,
    toolErrors: 0,
    toolErrorRate: 0,
    malformedCalls: 0,
    malformedCallRate: 0,
    retries: 0,
    compactions: 0,
    contextResets: 0,
    tokensInMeasured: 0,
    tokensOutMeasured: 0,
    tokensInEstimated: 0,
    tokensOutEstimated: 0,
    costUsd: 0,
    wallTimeMs: 0,
    verificationRuns: 0,
    verificationPasses: 0,
    verificationPassRate: 0,
    stuckEvents: 0,
  };
}

function recomputeRates(b: MetricsBucket): void {
  const denom = Math.max(1, b.totalToolCalls + b.malformedCalls);
  b.toolErrorRate = b.totalToolCalls > 0 ? b.toolErrors / b.totalToolCalls : 0;
  b.malformedCallRate = b.malformedCalls / denom;
  b.verificationPassRate =
    b.verificationRuns > 0 ? b.verificationPasses / b.verificationRuns : 0;
}

/**
 * Tracks per-run and per-feature telemetry metrics (§12 Phase J):
 * steps, tool calls by tool, tool error rate, malformed-call rate, retries,
 * compactions, context resets, tokens in/out (measured vs. estimated), cost,
 * wall time, verification pass rate, and stuck events.
 */
export class RunMetricsCollector {
  readonly runId: string;
  readonly sessionId: string;
  private startedAtMs: number;
  private overall: MetricsBucket = createEmptyBucket();
  private byFeature = new Map<string, MetricsBucket>();

  constructor(runId: string, sessionId: string, startedAtMs = Date.now()) {
    this.runId = runId;
    this.sessionId = sessionId;
    this.startedAtMs = startedAtMs;
  }

  private getFeatureBucket(featureId?: string | null): MetricsBucket | null {
    if (!featureId) return null;
    let b = this.byFeature.get(featureId);
    if (!b) {
      b = createEmptyBucket();
      this.byFeature.set(featureId, b);
    }
    return b;
  }

  recordStep(params: {
    featureId?: string | null;
    tokensIn: number;
    tokensOut: number;
    estimated?: boolean;
    costUsd?: number;
  }): void {
    const targets = [this.overall, this.getFeatureBucket(params.featureId)].filter(
      Boolean
    ) as MetricsBucket[];
    for (const b of targets) {
      b.steps += 1;
      if (params.estimated) {
        b.tokensInEstimated += params.tokensIn;
        b.tokensOutEstimated += params.tokensOut;
      } else {
        b.tokensInMeasured += params.tokensIn;
        b.tokensOutMeasured += params.tokensOut;
      }
      b.costUsd += params.costUsd ?? 0;
    }
  }

  recordToolCall(params: {
    tool: string;
    isError: boolean;
    featureId?: string | null;
  }): void {
    const targets = [this.overall, this.getFeatureBucket(params.featureId)].filter(
      Boolean
    ) as MetricsBucket[];
    for (const b of targets) {
      b.totalToolCalls += 1;
      b.toolCallsByTool[params.tool] = (b.toolCallsByTool[params.tool] ?? 0) + 1;
      if (params.isError) b.toolErrors += 1;
      recomputeRates(b);
    }
  }

  recordMalformedCall(featureId?: string | null): void {
    const targets = [this.overall, this.getFeatureBucket(featureId)].filter(
      Boolean
    ) as MetricsBucket[];
    for (const b of targets) {
      b.malformedCalls += 1;
      recomputeRates(b);
    }
  }

  recordRetry(featureId?: string | null): void {
    const targets = [this.overall, this.getFeatureBucket(featureId)].filter(
      Boolean
    ) as MetricsBucket[];
    for (const b of targets) b.retries += 1;
  }

  recordCompaction(featureId?: string | null): void {
    const targets = [this.overall, this.getFeatureBucket(featureId)].filter(
      Boolean
    ) as MetricsBucket[];
    for (const b of targets) b.compactions += 1;
  }

  recordContextReset(featureId?: string | null): void {
    const targets = [this.overall, this.getFeatureBucket(featureId)].filter(
      Boolean
    ) as MetricsBucket[];
    for (const b of targets) b.contextResets += 1;
  }

  recordVerification(passed: boolean, featureId?: string | null): void {
    const targets = [this.overall, this.getFeatureBucket(featureId)].filter(
      Boolean
    ) as MetricsBucket[];
    for (const b of targets) {
      b.verificationRuns += 1;
      if (passed) b.verificationPasses += 1;
      recomputeRates(b);
    }
  }

  recordStuckEvent(featureId?: string | null): void {
    const targets = [this.overall, this.getFeatureBucket(featureId)].filter(
      Boolean
    ) as MetricsBucket[];
    for (const b of targets) b.stuckEvents += 1;
  }

  snapshot(nowMs = Date.now()): RunMetricsReport {
    this.overall.wallTimeMs = Math.max(0, nowMs - this.startedAtMs);
    recomputeRates(this.overall);
    const featureMap: Record<string, MetricsBucket> = {};
    for (const [fid, bucket] of this.byFeature.entries()) {
      recomputeRates(bucket);
      featureMap[fid] = structuredClone(bucket);
    }
    return {
      runId: this.runId,
      sessionId: this.sessionId,
      overall: structuredClone(this.overall),
      byFeature: featureMap,
    };
  }
}
