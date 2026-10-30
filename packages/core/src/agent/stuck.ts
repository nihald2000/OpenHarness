import type { RunState } from "./deps.ts";

export interface StuckEventItem {
  kind: "action_observation" | "assistant_monologue" | "compaction" | "verify_failure" | "malformed_call";
  action?: string;
  observation?: string;
  isError?: boolean;
  verifySignature?: string;
}

export interface StuckDetectorThresholds {
  repeatActionObservation?: number; // default 4
  repeatActionError?: number; // default 3
  monologueMessages?: number; // default 3
  alternatingWindow?: number; // default 6 (A-B-A-B-A-B)
  consecutiveCompactions?: number; // default 10
  verifyNoProgressLimit?: number; // default 2
  consecutiveMalformedCalls?: number; // default 5
}

export interface StuckDetectionResult {
  stuck: boolean;
  detector?:
    | "repeat_action_observation"
    | "repeat_action_error"
    | "monologue"
    | "alternating_ab"
    | "compaction_loop"
    | "verify_no_progress"
    | "malformed_tool_calls";
  count?: number;
  message?: string;
}

/**
 * StuckDetector implementing OpenHands' 5 heuristics + OpenHarness's 2 additions (§9 G.2).
 * Scans the last 20 events and treats parallel calls from one model response as one combined attempt.
 */
export class StuckDetector {
  readonly thresholds: Required<StuckDetectorThresholds>;
  private featureDetectionCount = new Map<string, number>();

  constructor(thresholds?: StuckDetectorThresholds) {
    this.thresholds = {
      repeatActionObservation: thresholds?.repeatActionObservation ?? 4,
      repeatActionError: thresholds?.repeatActionError ?? 3,
      monologueMessages: thresholds?.monologueMessages ?? 3,
      alternatingWindow: thresholds?.alternatingWindow ?? 6,
      consecutiveCompactions: thresholds?.consecutiveCompactions ?? 10,
      verifyNoProgressLimit: thresholds?.verifyNoProgressLimit ?? 2,
      consecutiveMalformedCalls: thresholds?.consecutiveMalformedCalls ?? 5,
    };
  }

  /**
   * Evaluates recent event sequence (last 20 items) for any of the 7 stuck patterns (§9 G.2).
   */
  evaluate(events: StuckEventItem[]): StuckDetectionResult {
    const window = events.slice(-20);
    if (window.length === 0) return { stuck: false };

    // 7. 5 consecutive malformed tool calls
    const malformedThreshold = this.thresholds.consecutiveMalformedCalls;
    if (window.length >= malformedThreshold) {
      const tail = window.slice(-malformedThreshold);
      if (tail.every((e) => e.kind === "malformed_call")) {
        return {
          stuck: true,
          detector: "malformed_tool_calls",
          count: malformedThreshold,
          message: `Detected ${malformedThreshold} consecutive malformed tool calls. Check tool schema requirements and provide valid JSON arguments.`,
        };
      }
    }

    // 6. Verification failure signature repeating `verify.noProgressLimit` times
    const verifyEvents = window.filter((e) => e.kind === "verify_failure" && e.verifySignature);
    const verifyThreshold = this.thresholds.verifyNoProgressLimit;
    if (verifyEvents.length >= verifyThreshold) {
      const tailVerify = verifyEvents.slice(-verifyThreshold);
      const sig = tailVerify[0]!.verifySignature!;
      if (tailVerify.every((v) => v.verifySignature === sig)) {
        return {
          stuck: true,
          detector: "verify_no_progress",
          count: verifyThreshold,
          message: `Verification failure signature "${sig}" repeated ${verifyThreshold} times with no progress.`,
        };
      }
    }

    // 5. 10 consecutive compactions/condensations with no other progress
    const compThreshold = this.thresholds.consecutiveCompactions;
    if (window.length >= compThreshold) {
      const tailComp = window.slice(-compThreshold);
      if (tailComp.every((e) => e.kind === "compaction")) {
        return {
          stuck: true,
          detector: "compaction_loop",
          count: compThreshold,
          message: `Detected ${compThreshold} consecutive context compactions with no task progress.`,
        };
      }
    }

    // 3. 3 consecutive assistant messages with no tool call or user input (monologue)
    const monoThreshold = this.thresholds.monologueMessages;
    if (window.length >= monoThreshold) {
      const tailMono = window.slice(-monoThreshold);
      if (tailMono.every((e) => e.kind === "assistant_monologue")) {
        return {
          stuck: true,
          detector: "monologue",
          count: monoThreshold,
          message: `Detected ${monoThreshold} consecutive assistant monologue turns without invoking any tool.`,
        };
      }
    }

    const actionObs = window.filter((e) => e.kind === "action_observation");

    // 1. Same action and same observation repeated 4 times
    const repeatAOThreshold = this.thresholds.repeatActionObservation;
    if (actionObs.length >= repeatAOThreshold) {
      const tailAO = actionObs.slice(-repeatAOThreshold);
      const first = tailAO[0]!;
      if (
        tailAO.every(
          (item) =>
            item.action === first.action && item.observation === first.observation
        )
      ) {
        return {
          stuck: true,
          detector: "repeat_action_observation",
          count: repeatAOThreshold,
          message: `Detected identical action "${first.action}" and observation repeated ${repeatAOThreshold} times in a row. Try a different strategy.`,
        };
      }
    }

    // 2. Same action producing an error 3 times in a row
    const repeatErrThreshold = this.thresholds.repeatActionError;
    if (actionObs.length >= repeatErrThreshold) {
      const tailErr = actionObs.slice(-repeatErrThreshold);
      const first = tailErr[0]!;
      if (
        tailErr.every(
          (item) => item.isError && item.action === first.action
        )
      ) {
        return {
          stuck: true,
          detector: "repeat_action_error",
          count: repeatErrThreshold,
          message: `Action "${first.action}" produced an error ${repeatErrThreshold} times in a row. Inspect the root cause before retrying.`,
        };
      }
    }

    // 4. An A-B-A-B-A-B alternating pattern over the last 6 action/observation pairs
    const altWindow = this.thresholds.alternatingWindow;
    if (actionObs.length >= altWindow && altWindow >= 6) {
      const tailAlt = actionObs.slice(-altWindow);
      const pairKey = (x: StuckEventItem) => `${x.action}::${x.observation ?? ""}`;
      const aKey = pairKey(tailAlt[0]!);
      const bKey = pairKey(tailAlt[1]!);
      if (aKey !== bKey) {
        let isAlternating = true;
        for (let i = 0; i < tailAlt.length; i++) {
          const expected = i % 2 === 0 ? aKey : bKey;
          if (pairKey(tailAlt[i]!) !== expected) {
            isAlternating = false;
            break;
          }
        }
        if (isAlternating) {
          return {
            stuck: true,
            detector: "alternating_ab",
            count: altWindow,
            message: `Detected alternating A-B-A-B-A-B loop between "${tailAlt[0].action}" and "${tailAlt[1].action}". Break out of the cycle.`,
          };
        }
      }
    }

    return { stuck: false };
  }

  /**
   * Handles stuck resolution per feature (§9 G.2):
   * - On first detection: injects a harness warning message describing the loop and asking for a different approach.
   * - On second detection in the same feature: marks feature `blocked` (`long_task`) or pauses with `run.stuck` (`task`/`chat`).
   */
  handleDetection(
    state: RunState,
    detection: StuckDetectionResult
  ): {
    action: "warn" | "blocked" | "paused";
    harnessMessage: string;
  } {
    const key = state.featureId ?? state.runId;
    const prevCount = this.featureDetectionCount.get(key) ?? 0;
    const nextCount = prevCount + 1;
    this.featureDetectionCount.set(key, nextCount);
    state.stuckWarningsIssued = nextCount;

    if (nextCount === 1) {
      return {
        action: "warn",
        harnessMessage: `[Harness Stuck Detector Warning (${detection.detector})]: ${detection.message} Do not repeat the same commands; choose a different approach.`,
      };
    }

    if (state.mode === "long_task") {
      return {
        action: "blocked",
        harnessMessage: `Feature "${key}" marked blocked after repeated stuck detection (${detection.detector}): ${detection.message}`,
      };
    }

    return {
      action: "paused",
      harnessMessage: `Run paused due to repeated stuck loop (${detection.detector}): ${detection.message}`,
    };
  }
}
