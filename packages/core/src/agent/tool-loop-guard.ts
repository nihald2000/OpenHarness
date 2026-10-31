export interface ToolLoopGuardOptions {
  maxRepeatedIdentical?: number; // default 3
  maxPerPhase?: number; // default 25
}

export interface ToolLoopDecision {
  action: "allow" | "warn" | "abort";
  reason?: string;
  signature: string;
  repeatCount: number;
  phaseCount: number;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export class ToolLoopGuard {
  private readonly maxRepeatedIdentical: number;
  private readonly maxPerPhase: number;
  private readonly signatureCounts = new Map<string, { count: number; failures: number }>();
  private readonly phaseCounts = new Map<string, number>();
  private lastSignature = "";
  private consecutiveIdentical = 0;

  constructor(opts?: ToolLoopGuardOptions) {
    this.maxRepeatedIdentical = opts?.maxRepeatedIdentical ?? 3;
    this.maxPerPhase = opts?.maxPerPhase ?? 25;
  }

  recordCall(
    phase: string,
    toolName: string,
    args: unknown,
    failed = false
  ): ToolLoopDecision {
    const sig = `${toolName}:${canonicalize(args ?? {})}`;
    if (sig === this.lastSignature) {
      this.consecutiveIdentical += 1;
    } else {
      this.lastSignature = sig;
      this.consecutiveIdentical = 1;
    }

    const prev = this.signatureCounts.get(sig) ?? { count: 0, failures: 0 };
    const nextCount = prev.count + 1;
    const nextFailures = prev.failures + (failed ? 1 : 0);
    this.signatureCounts.set(sig, { count: nextCount, failures: nextFailures });

    const phaseTotal = (this.phaseCounts.get(phase) ?? 0) + 1;
    this.phaseCounts.set(phase, phaseTotal);

    if (phaseTotal > this.maxPerPhase) {
      return {
        action: "abort",
        reason: `Exceeded maximum tool round-trips (${this.maxPerPhase}) in phase "${phase}".`,
        signature: sig,
        repeatCount: nextCount,
        phaseCount: phaseTotal,
      };
    }

    if (this.consecutiveIdentical > this.maxRepeatedIdentical || nextFailures >= this.maxRepeatedIdentical) {
      return {
        action: "abort",
        reason: `Tool loop detected: "${toolName}" called ${nextCount} times with identical arguments.`,
        signature: sig,
        repeatCount: nextCount,
        phaseCount: phaseTotal,
      };
    }

    if (this.consecutiveIdentical === this.maxRepeatedIdentical || (failed && nextFailures === 2)) {
      return {
        action: "warn",
        reason: `Warning: "${toolName}" has been called ${nextCount} times with identical arguments. Do not repeat the same call; try a different approach.`,
        signature: sig,
        repeatCount: nextCount,
        phaseCount: phaseTotal,
      };
    }

    return {
      action: "allow",
      signature: sig,
      repeatCount: nextCount,
      phaseCount: phaseTotal,
    };
  }
}
