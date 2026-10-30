import type { RunPhase, RunStatus } from "@openharness/sdk";

export const ALL_RUN_PHASES: readonly RunPhase[] = [
  "planning",
  "building",
  "testing",
  "fixing",
  "reviewing",
  "awaiting_permission",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "stuck",
] as const;

export const TERMINAL_RUN_PHASES: readonly RunPhase[] = [
  "completed",
  "failed",
  "cancelled",
] as const;

export const WAITING_RUN_PHASES: readonly RunPhase[] = [
  "awaiting_permission",
  "paused",
  "stuck",
] as const;

/**
 * Maps a fine-grained RunPhase onto the legacy Session RunStatus for API compatibility (§3 A.1).
 */
export function mapPhaseToSessionStatus(phase: RunPhase): RunStatus {
  switch (phase) {
    case "planning":
    case "building":
    case "fixing":
    case "reviewing":
      return "running";
    case "testing":
      return "verifying";
    case "awaiting_permission":
      return "awaiting_permission";
    case "paused":
    case "stuck":
      return "idle";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

export function isTerminalPhase(phase: RunPhase): boolean {
  return (
    phase === "completed" ||
    phase === "failed" ||
    phase === "cancelled"
  );
}

export function isWaitingPhase(phase: RunPhase): boolean {
  return (
    phase === "awaiting_permission" ||
    phase === "paused" ||
    phase === "stuck"
  );
}
