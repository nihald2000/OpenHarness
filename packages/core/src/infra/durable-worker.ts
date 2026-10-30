import type { OpenHarnessEvent, PermissionReply, RunRecord } from "@openharness/sdk";
import type { EngineDeps, RunState } from "../agent/deps.ts";
import {
  applyPermissionDecisionToState,
  createInitialRunState,
  persistStepCheckpoint,
  runStep,
} from "../agent/engine.ts";
import {
  isTerminalPhase,
  isWaitingPhase,
  mapPhaseToSessionStatus,
} from "../agent/phases.ts";
import type { JobQueue, JobRecord } from "./in-process-job-queue.ts";

export interface DurableWorkerOptions {
  workerId?: string;
  leaseMs?: number;
  conversationIdleTtlSec?: number;
}

/**
 * DurableWorker claims jobs from JobQueue, resumes from the latest StepCheckpoint if present,
 * executes steps via AgentEngine, releases worker slots while awaiting permissions or paused,
 * and manages sandbox idle TTL hibernation (§3 A.2).
 */
export class DurableWorker {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly conversationIdleTtlSec: number;
  private queue: JobQueue;
  private deps: EngineDeps;
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(queue: JobQueue, deps: EngineDeps, opts?: DurableWorkerOptions) {
    this.queue = queue;
    this.deps = deps;
    this.workerId = opts?.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
    this.leaseMs = opts?.leaseMs ?? 30_000;
    this.conversationIdleTtlSec = opts?.conversationIdleTtlSec ?? 300;
  }

  /**
   * Claims and processes one job from the queue until it completes, fails, or yields its slot (`waiting` / `paused`).
   */
  async processNextJob(): Promise<{
    job: JobRecord | null;
    state: RunState | null;
    events: OpenHarnessEvent[];
  }> {
    const job = await this.queue.claim(this.workerId, this.leaseMs);
    if (!job) {
      return { job: null, state: null, events: [] };
    }
    return this.executeClaimedJob(job);
  }

  async executeJobById(jobId: string): Promise<{
    job: JobRecord | null;
    state: RunState | null;
    events: OpenHarnessEvent[];
  }> {
    let job = await this.queue.getJob(jobId);
    if (!job) return { job: null, state: null, events: [] };
    if (job.status === "queued") {
      const claimed = await this.queue.claim(this.workerId, this.leaseMs);
      if (claimed && claimed.id === jobId) {
        job = claimed;
      }
    }
    return this.executeClaimedJob(job);
  }

  private async executeClaimedJob(job: JobRecord): Promise<{
    job: JobRecord;
    state: RunState;
    events: OpenHarnessEvent[];
  }> {
    const allEvents: OpenHarnessEvent[] = [];

    // 1. Check if a step checkpoint exists in StateStore or on the job record (§3 A.2)
    const savedCheckpoint =
      (await this.deps.stateStore.getStepCheckpoint(job.tenantId, job.runId)) ??
      job.checkpoint;

    let state: RunState;
    if (savedCheckpoint) {
      state = structuredClone(savedCheckpoint.state);
      state.jobId = job.id;
    } else {
      state = createInitialRunState({
        runId: job.runId,
        jobId: job.id,
        sessionId: job.sessionId,
        tenantId: job.tenantId,
        agent: job.agent,
        model: job.model,
        mode: job.mode,
        now: this.deps.clock.now(),
      });
      const cp = await persistStepCheckpoint(this.deps, state);
      await this.queue.saveCheckpoint(job.id, this.workerId, job.fenceToken, cp);
    }

    // Clear any idle snapshot timer if resuming
    const existingTimer = this.idleTimers.get(state.runId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.idleTimers.delete(state.runId);
    }

    try {
      while (!isTerminalPhase(state.phase) && !isWaitingPhase(state.phase)) {
        // Renew lease before each step
        await this.queue.heartbeat(job.id, this.workerId, job.fenceToken, this.leaseMs);

        // Check if job was externally cancelled
        const freshJob = await this.queue.getJob(job.id);
        if (freshJob?.status === "cancelled") {
          state.phase = "cancelled";
          break;
        }

        const { state: nextState, events } = await runStep(state, this.deps);
        state = nextState;
        allEvents.push(...events);

        const cp = await persistStepCheckpoint(this.deps, state);
        await this.queue.saveCheckpoint(job.id, this.workerId, job.fenceToken, cp);
      }

      if (state.phase === "awaiting_permission") {
        // Free the worker slot while waiting for permission approval (§3 A.2)
        await this.queue.moveToWaiting(job.id, this.workerId, job.fenceToken, "permission");
      } else if (state.phase === "paused" || state.phase === "stuck") {
        await this.queue.moveToWaiting(job.id, this.workerId, job.fenceToken, "paused");
        this.scheduleSandboxIdleHibernation(state);
      } else if (state.phase === "completed") {
        await this.queue.complete(job.id, this.workerId, job.fenceToken);
      } else if (state.phase === "cancelled") {
        await this.queue.cancel(job.id);
      } else if (state.phase === "failed") {
        await this.queue.fail(job.id, this.workerId, job.fenceToken, state.error ?? "Run failed");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.phase = "failed";
      state.error = message;
      await persistStepCheckpoint(this.deps, state);
      await this.queue.fail(job.id, this.workerId, job.fenceToken, message);
    }

    const updatedJob = (await this.queue.getJob(job.id)) ?? job;
    return { job: updatedJob, state, events: allEvents };
  }

  /**
   * Handles permission reply (`once` | `always` | `reject`), updates state, and re-queues the waiting job (§3 A.2).
   */
  async replyPermissionAndResume(
    tenantId: string,
    requestId: string,
    reply: PermissionReply
  ): Promise<{ state: RunState | null; events: OpenHarnessEvent[] }> {
    const req = await this.deps.stateStore.getPermissionRequest(tenantId, requestId);
    if (!req) return { state: null, events: [] };

    // Locate the run checkpoint for this session
    const session = await this.deps.stateStore.getSession(tenantId, req.sessionId);
    const runId = session?.runId;
    if (!runId) return { state: null, events: [] };

    const cp = await this.deps.stateStore.getStepCheckpoint(tenantId, runId);
    if (!cp) return { state: null, events: [] };

    const { state: updatedState, events } = await applyPermissionDecisionToState(
      cp.state,
      reply,
      this.deps
    );

    const job = await this.queue.getJobByRunId(runId);
    if (job) {
      await this.queue.resumeWaiting(job.id);
      const resumed = await this.executeJobById(job.id);
      return {
        state: resumed.state ?? updatedState,
        events: [...events, ...resumed.events],
      };
    }

    return { state: updatedState, events };
  }

  /**
   * Pauses an active or waiting run and keeps the sandbox alive for `conversationIdleTtlSec` before snapshotting (§3 A.2).
   */
  async pauseRun(tenantId: string, runId: string, reason = "user_paused"): Promise<RunRecord | null> {
    const cp = await this.deps.stateStore.getStepCheckpoint(tenantId, runId);
    if (!cp) return null;

    const state = cp.state;
    state.phase = "paused";
    state.pauseReason = reason;
    state.updatedAt = this.deps.clock.now();
    await persistStepCheckpoint(this.deps, state);

    const job = await this.queue.getJobByRunId(runId);
    if (job && job.status === "claimed" && job.workerId) {
      await this.queue.moveToWaiting(job.id, job.workerId, job.fenceToken, "paused");
    }

    const mappedStatus = mapPhaseToSessionStatus("paused");
    const runRecord: RunRecord = {
      id: state.runId,
      sessionId: state.sessionId,
      tenantId: state.tenantId,
      mode: state.mode,
      status: mappedStatus,
      phase: "paused",
      iteration: state.iteration,
      maxIterations: state.budgets.maxIterations,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      pauseReason: reason,
      featureId: state.featureId ?? undefined,
      lastCheckpoint: state.lastCheckpoint ?? undefined,
      sandboxHandleId: state.sandboxHandleId ?? undefined,
      usage: state.usage,
      cost: state.cost,
    };
    await this.deps.stateStore.saveRun(tenantId, runRecord);
    const env = await this.deps.stateStore.appendEvent(tenantId, state.sessionId, {
      type: "run.phase",
      sessionId: state.sessionId,
      runId: state.runId,
      phase: "paused",
    });
    this.deps.eventBus.publish(env);

    this.scheduleSandboxIdleHibernation(state);
    return runRecord;
  }

  /**
   * Resumes a paused run, optionally doubling its budget when `extend: true` is passed (§3 A.2, §9 G.1).
   */
  async resumeRun(
    tenantId: string,
    runId: string,
    opts?: { extend?: boolean }
  ): Promise<{ run: RunRecord | null; state: RunState | null; events: OpenHarnessEvent[] }> {
    const cp = await this.deps.stateStore.getStepCheckpoint(tenantId, runId);
    if (!cp) return { run: null, state: null, events: [] };

    const state = cp.state;
    const timer = this.idleTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(runId);
    }

    if (this.deps.onResumeSandbox && (state.sandboxSnapshotId || state.sandboxHandleId)) {
      const restored = await this.deps.onResumeSandbox(state);
      state.sandboxHandleId = restored.sandboxHandleId;
    }

    if (opts?.extend) {
      // OpenHands traffic-control doubling pattern (§9 G.1)
      state.budgets.maxIterations *= 2;
      state.budgets.maxRunDurationSec *= 2;
      if (state.budgets.maxCostPerRun) {
        state.budgets.maxCostPerRun *= 2;
      }
      state.budgets.extensionsCount += 1;
      state.budgets.warnedResources = [];
    }

    state.phase = "building";
    state.pauseReason = undefined;
    state.updatedAt = this.deps.clock.now();
    await persistStepCheckpoint(this.deps, state);

    const job = await this.queue.getJobByRunId(runId);
    let events: OpenHarnessEvent[] = [];
    let finalState = state;
    if (job) {
      await this.queue.resumeWaiting(job.id);
      const res = await this.executeJobById(job.id);
      if (res.state) finalState = res.state;
      events = res.events;
    }

    const run = await this.deps.stateStore.getRun(tenantId, runId);
    return { run, state: finalState, events };
  }

  async cancelRun(tenantId: string, runId: string): Promise<RunRecord | null> {
    const cp = await this.deps.stateStore.getStepCheckpoint(tenantId, runId);
    const job = await this.queue.getJobByRunId(runId);
    if (job) {
      await this.queue.cancel(job.id);
    }
    if (!cp) return null;

    const state = cp.state;
    state.phase = "cancelled";
    state.updatedAt = this.deps.clock.now();
    state.completedAt = state.updatedAt;
    await persistStepCheckpoint(this.deps, state);

    const runRecord: RunRecord = {
      id: state.runId,
      sessionId: state.sessionId,
      tenantId: state.tenantId,
      mode: state.mode,
      status: "cancelled",
      phase: "cancelled",
      iteration: state.iteration,
      maxIterations: state.budgets.maxIterations,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      completedAt: state.completedAt,
      featureId: state.featureId ?? undefined,
      lastCheckpoint: state.lastCheckpoint ?? undefined,
      usage: state.usage,
      cost: state.cost,
    };
    await this.deps.stateStore.saveRun(tenantId, runRecord);
    const env = await this.deps.stateStore.appendEvent(tenantId, state.sessionId, {
      type: "run.phase",
      sessionId: state.sessionId,
      runId: state.runId,
      phase: "cancelled",
    });
    this.deps.eventBus.publish(env);
    return runRecord;
  }

  private scheduleSandboxIdleHibernation(state: RunState): void {
    if (!this.deps.onPauseSandbox || this.conversationIdleTtlSec <= 0) return;
    const existing = this.idleTimers.get(state.runId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.idleTimers.delete(state.runId);
      try {
        const res = await this.deps.onPauseSandbox?.(state);
        if (res?.snapshotId) {
          state.sandboxSnapshotId = res.snapshotId;
          await persistStepCheckpoint(this.deps, state);
        }
      } catch {
        // ignore background snapshot failure
      }
    }, this.conversationIdleTtlSec * 1000);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.idleTimers.set(state.runId, timer);
  }
}
