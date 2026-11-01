import type { OpenHarnessEvent, PermissionReply, RunRecord } from "@openharness/sdk";
import type { EngineDeps, RunState } from "../agent/deps.ts";
import {
  applyPermissionDecisionToState,
  applyQuestionAnswerToState,
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
  private abortControllers = new Map<string, AbortController>();

  constructor(queue: JobQueue, deps: EngineDeps, opts?: DurableWorkerOptions) {
    this.queue = queue;
    this.deps = deps;
    this.workerId = opts?.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
    this.leaseMs = opts?.leaseMs ?? 30_000;
    this.conversationIdleTtlSec = opts?.conversationIdleTtlSec ?? 300;
  }

  /** Returns the cancellation signal owned by this worker for an active run. */
  signalFor(runId: string): AbortSignal | undefined {
    return this.abortControllers.get(runId)?.signal;
  }

  /** Aborts an active run immediately. Persisting its cancelled status is handled by cancelRun. */
  abortRun(runId: string): boolean {
    const controller = this.abortControllers.get(runId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(Object.assign(new Error("Cancelled by user"), { code: "CANCELLED" }));
    return true;
  }

  private async getTenantJob(tenantId: string, runId: string): Promise<JobRecord | null> {
    const jobs = await this.queue.listJobs({ tenantId });
    return jobs.filter((job) => job.runId === runId).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
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
      const claimed = this.queue.claimById
        ? await this.queue.claimById(jobId, this.workerId, this.leaseMs)
        : await this.queue.claim(this.workerId, this.leaseMs);
      if (claimed?.id === jobId) job = claimed;
      else if (!this.queue.claimById && claimed) {
        // Legacy queues can only claim the next job. Process that lease and
        // retry the requested job afterwards rather than executing an unclaimed row.
        await this.executeClaimedJob(claimed);
        return this.executeJobById(jobId);
      } else if (this.queue.claimById && !claimed) {
        const current = await this.queue.getJob(jobId);
        return { job: current, state: null, events: [] };
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
    const controller = this.abortControllers.get(job.runId) ?? new AbortController();
    this.abortControllers.set(job.runId, controller);

    // 1. Check if a step checkpoint exists in StateStore or on the job record (§3 A.2)
    const savedCheckpoint =
      (await this.deps.stateStore.getStepCheckpoint(job.tenantId, job.runId)) ??
      job.checkpoint;

    let state: RunState;
    if (savedCheckpoint) {
      state = structuredClone(savedCheckpoint.state);
      state.jobId = job.id;
    } else {
      const session = await this.deps.stateStore.getSession(job.tenantId, job.sessionId);
      state = createInitialRunState({
        runId: job.runId,
        jobId: job.id,
        sessionId: job.sessionId,
        tenantId: job.tenantId,
        agent: job.agent,
        model: job.model,
        runtime: session?.runtime ?? "local",
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

        const executionDeps: EngineDeps = {
          ...this.deps,
          signalFor: (runId) =>
            runId === job.runId ? controller.signal : this.deps.signalFor?.(runId),
        };
        const { state: nextState, events } = await runStep(state, executionDeps);
        state = nextState;
        allEvents.push(...events);

        const cp = await persistStepCheckpoint(this.deps, state);
        await this.queue.saveCheckpoint(job.id, this.workerId, job.fenceToken, cp);
      }

      if (state.phase === "awaiting_permission") {
        // Free the worker slot while waiting for permission approval (§3 A.2)
        await this.queue.moveToWaiting(job.id, this.workerId, job.fenceToken, "permission");
      } else if (state.phase === "awaiting_input") {
        // Free the worker slot while waiting for a clarifying-question answer.
        await this.queue.moveToWaiting(job.id, this.workerId, job.fenceToken, "input");
        // An answer can arrive after the checkpoint is saved but before the job
        // transitions to waiting. Recheck after releasing the claim to avoid
        // leaving an already answered run stranded in the input wait state.
        const latest = await this.deps.stateStore.getStepCheckpoint(state.tenantId, state.runId);
        if (latest && latest.state.phase !== "awaiting_input" && !isTerminalPhase(latest.state.phase)) {
          if (await this.queue.resumeWaiting(job.id)) {
            void this.executeJobById(job.id).catch(() => undefined);
          }
        }
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
      const aborted = controller.signal.aborted || this.deps.signalFor?.(state.runId)?.aborted === true;
      state.phase = aborted ? "cancelled" : "failed";
      if (!aborted) state.error = message;
      if (aborted) state.pauseReason = "cancelled";
      state.updatedAt = this.deps.clock.now();
      state.completedAt = state.updatedAt;
      await persistStepCheckpoint(this.deps, state);
      if (aborted) {
        await this.queue.cancel(job.id);
      } else {
        await this.queue.fail(job.id, this.workerId, job.fenceToken, message);
      }

      const failedRunRecord: RunRecord = {
        id: state.runId,
        sessionId: state.sessionId,
        tenantId: state.tenantId,
        mode: state.mode,
        status: aborted ? "cancelled" : "failed",
        phase: aborted ? "cancelled" : "failed",
        iteration: state.iteration,
        maxIterations: state.budgets.maxIterations,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        completedAt: state.completedAt,
        pauseReason: state.pauseReason,
        error: aborted ? undefined : message,
        sandboxHandleId: state.sandboxHandleId ?? undefined,
        usage: state.usage,
        cost: state.cost,
      };
      await this.deps.stateStore.saveRun(state.tenantId, failedRunRecord);
      const sess = await this.deps.stateStore.getSession(state.tenantId, state.sessionId);
      if (sess) {
        sess.status = aborted ? "cancelled" : "failed";
        sess.phase = aborted ? "cancelled" : "failed";
        sess.error = aborted ? undefined : message;
        sess.activeRunId = null;
        sess.updatedAt = state.updatedAt;
        await this.deps.stateStore.saveSession(state.tenantId, sess);
      }
      const env = await this.deps.stateStore.appendEvent(state.tenantId, state.sessionId, {
        type: "run.status",
        sessionId: state.sessionId,
        status: aborted ? "cancelled" : "failed",
        error: aborted ? undefined : message,
      });
      this.deps.eventBus.publish(env);
    }

    const updatedJob = (await this.queue.getJob(job.id)) ?? job;
    if (this.abortControllers.get(job.runId) === controller) this.abortControllers.delete(job.runId);
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

    const job = await this.getTenantJob(tenantId, runId);
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
   * Records the user's answer to a durable `ask_user` question and resumes the same waiting job.
   */
  async answerQuestion(
    tenantId: string,
    runId: string,
    answer: string
  ): Promise<{ ok: boolean; error?: string }> {
    const cp = await this.deps.stateStore.getStepCheckpoint(tenantId, runId);
    if (!cp || !cp.state.pendingQuestion) {
      return { ok: false, error: "No pending question for this run" };
    }
    let job = await this.getTenantJob(tenantId, runId);
    // A v2/legacy run may also persist a core checkpoint, but it has no v1 job
    // identity. Leave those runs to DurableRunWorker instead of claiming them.
    if (!job && !cp.state.jobId) {
      return { ok: false, error: "Run is not owned by the v1 job queue" };
    }
    // Do not race the worker's final awaiting_input checkpoint write. The
    // engine persists the question first; the queue lease is released shortly
    // afterwards. Wait for that release before applying the answer.
    for (let attempt = 0; job?.status === "claimed" && attempt < 200; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = await this.getTenantJob(tenantId, runId);
    }
    if (job?.status === "claimed") {
      return { ok: false, error: "Run is still saving its question pause; retry the answer shortly" };
    }

    const { state: updatedState } = await applyQuestionAnswerToState(
      cp.state,
      answer,
      this.deps
    );

    if (job && (job.status === "completed" || job.status === "failed" || job.status === "cancelled")) {
      job = null;
    }
    if (!job) {
      job = await this.queue.enqueue({
        id: `job_${runId}_resume_${Date.now()}`,
        runId,
        sessionId: updatedState.sessionId,
        tenantId,
        prompt: "",
        agent: updatedState.agent,
        model: updatedState.model,
        mode: updatedState.mode,
      });
      updatedState.jobId = job.id;
      await persistStepCheckpoint(this.deps, updatedState);
    }
    if (job.status === "waiting" || job.status === "paused") {
      await this.queue.resumeWaiting(job.id);
      void this.executeJobById(job.id).catch(() => undefined);
    } else if (job.status === "queued") {
      void this.executeJobById(job.id).catch(() => undefined);
    }
    // If another worker still owns the claim, it will observe the cleared
    // pendingQuestion after moving the job to waiting and resume it above.
    return { ok: true };
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

    const job = await this.getTenantJob(tenantId, runId);
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

    const job = await this.getTenantJob(tenantId, runId);
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
    this.abortRun(runId);
    const cp = await this.deps.stateStore.getStepCheckpoint(tenantId, runId);
    const job = await this.getTenantJob(tenantId, runId);
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
