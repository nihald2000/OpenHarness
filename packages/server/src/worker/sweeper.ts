import { diagnoseError } from "./diagnose.ts";
import type { RunEventEmitter } from "./emitter.ts";
import type { RunStateMachine } from "./run-state.ts";
import type { DurableRunRecord } from "./types.ts";

export interface SweepOptions {
  queuedTimeoutMs?: number; // default 60_000
  firstActivityTimeoutMs?: number; // default 45_000
  stallTimeoutMs?: number; // default 180_000
  awaitingInputTimeoutMs?: number; // default 86_400_000 (24h)
}

export async function sweepStalledRuns(
  stateMachine: RunStateMachine,
  emitter: RunEventEmitter,
  now = Date.now(),
  opts: SweepOptions = {}
): Promise<DurableRunRecord[]> {
  const queuedTimeoutMs = opts.queuedTimeoutMs ?? 60_000;
  const awaitingInputTimeoutMs = opts.awaitingInputTimeoutMs ?? 86_400_000;
  const swept: DurableRunRecord[] = [];

  for (const run of stateMachine.listActiveRuns()) {
    const tenantId = run.tenantId ?? "default";
    const firstActivityLimit =
      opts.firstActivityTimeoutMs ?? run.snapshot.limits.firstActivityTimeoutMs ?? 45_000;
    const stallLimit =
      opts.stallTimeoutMs ?? run.snapshot.limits.stallTimeoutMs ?? 180_000;

    let failCode: "FIRST_ACTIVITY_TIMEOUT" | "RUN_STALLED" | null = null;
    let failReason = "";

    if (run.status === "queued" && now - run.startedAt > queuedTimeoutMs) {
      failCode = "FIRST_ACTIVITY_TIMEOUT";
      failReason = `Run queued for ${Math.round((now - run.startedAt) / 1000)}s without starting`;
    } else if (
      run.status === "running" &&
      !run.firstActivityAt &&
      now - run.startedAt > firstActivityLimit
    ) {
      failCode = "FIRST_ACTIVITY_TIMEOUT";
      failReason = `First activity timeout after ${Math.round((now - run.startedAt) / 1000)}s`;
    } else if (
      (run.status === "running" || run.status === "verifying") &&
      now - run.lastHeartbeatAt > stallLimit
    ) {
      failCode = "RUN_STALLED";
      failReason = `Run stalled without heartbeat for ${Math.round((now - run.lastHeartbeatAt) / 1000)}s`;
    } else if (
      run.status === "awaiting_input" &&
      now - run.lastHeartbeatAt > awaitingInputTimeoutMs
    ) {
      failCode = "RUN_STALLED";
      failReason = "Timed out waiting for user answer";
    }

    if (failCode) {
      const errObj = Object.assign(new Error(failReason), { code: failCode });
      const diagnostic = diagnoseError(errObj);
      const res = await stateMachine.transition(run.id, run.status, "failed", {
        phase: "failed",
        error: diagnostic.message,
        diagnostic,
      });
      if (res.ok && res.run) {
        swept.push(res.run);
        await emitter.emit(tenantId, run.sessionId, {
          type: "run.error",
          sessionId: run.sessionId,
          runId: run.id,
          code: diagnostic.code,
          message: diagnostic.message,
          recoverable: diagnostic.recoverable,
          error: diagnostic,
        });
        await emitter.emit(tenantId, run.sessionId, {
          type: "run.status",
          sessionId: run.sessionId,
          runId: run.id,
          status: "failed",
          error: diagnostic.message,
        });
      }
    }
  }

  return swept;
}
