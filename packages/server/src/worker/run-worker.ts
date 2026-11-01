import type { Message, ToolPart } from "@openharness/sdk";
import {
  createInitialRunState,
  getActiveSandboxDaemon,
  applyQuestionAnswerToState,
  applyPermissionDecisionToState,
  runStep,
  ToolLoopGuard,
  type EngineDeps,
  type RunState,
  type SandboxHandle,
} from "@openharness/core";
import type { PermissionReply } from "@openharness/sdk";
import { HttpError } from "../server.ts";
import { diagnoseError } from "./diagnose.ts";
import type { RunEventEmitter } from "./emitter.ts";
import { isTerminalRunStatus, type RunStateMachine } from "./run-state.ts";
import type {
  CreateRunInput,
  DurableRunRecord,
  RunWorker,
} from "./types.ts";

export interface DurableRunWorkerOptions {
  stateMachine: RunStateMachine;
  emitter: RunEventEmitter;
  deps: EngineDeps;
  activeSandboxes: Map<string, SandboxHandle>;
  heartbeatIntervalMs?: number; // default 5_000
}

export class DurableRunWorker implements RunWorker {
  readonly stateMachine: RunStateMachine;
  readonly emitter: RunEventEmitter;
  readonly deps: EngineDeps;
  readonly activeSandboxes: Map<string, SandboxHandle>;
  private readonly heartbeatIntervalMs: number;
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly loopGuards = new Map<string, ToolLoopGuard>();
  private launchRun: (runId: string) => void = (runId) => { void this.startRun(runId); };

  setRunLauncher(launch: (runId: string) => void): void {
    this.launchRun = launch;
  }

  constructor(opts: DurableRunWorkerOptions) {
    this.stateMachine = opts.stateMachine;
    this.emitter = opts.emitter;
    this.deps = opts.deps;
    this.activeSandboxes = opts.activeSandboxes;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 5_000;
  }

  async enqueueAndStart(
    input: CreateRunInput
  ): Promise<{ run: DurableRunRecord; deduplicated: boolean }> {
    const res = await this.stateMachine.createRun(input);
    if (!res.deduplicated) {
      await this.emitter.emit(res.run.tenantId ?? "default", res.run.sessionId, {
        type: "run.created",
        sessionId: res.run.sessionId,
        runId: res.run.id,
        mode: res.run.mode,
      });
    }
    return res;
  }

  async getRun(runId: string): Promise<DurableRunRecord | null> {
    return this.stateMachine.getRun(runId);
  }

  async answerQuestion(runId: string, answer: string): Promise<DurableRunRecord> {
    let run = this.stateMachine.getRun(runId);
    if (!run) {
      throw new HttpError(404, `Run not found: ${runId}`);
    }
    const tenantId = run.tenantId ?? "default";
    const checkpoint = await this.deps.stateStore.getStepCheckpoint(tenantId, runId);
    // The engine commits the pending question before publishing question.requested.
    // Promote the durable run record here if the answer races the worker's loop exit.
    if (run.status === "running" && checkpoint?.state.pendingQuestion) {
      const waiting = await this.stateMachine.transition(runId, "running", "awaiting_input", {
        phase: "awaiting_input",
        pendingQuestion: checkpoint.state.pendingQuestion,
        questionsAsked: checkpoint.state.questionsAsked ?? run.questionsAsked,
      });
      if (waiting.ok && waiting.run) run = waiting.run;
    }
    if (run.status !== "awaiting_input" || !run.pendingQuestion) {
      throw new HttpError(409, `Run ${runId} is not awaiting user input (status: ${run.status})`);
    }

    if (!checkpoint?.state.pendingQuestion) {
      throw new HttpError(409, `Run ${runId} has no durable pending question checkpoint`);
    }

    // Persist the answer in the engine checkpoint and assistant tool part before
    // reopening the run. This works the same way after an in-process pause or restart.
    await applyQuestionAnswerToState(checkpoint.state, answer, this.deps);

    const tr = await this.stateMachine.transition(runId, "awaiting_input", "running", {
      phase: "building",
      pendingQuestion: null,
    });
    if (!tr.ok || !tr.run) {
      throw new HttpError(409, `Failed to transition run ${runId} to running`);
    }

    this.launchRun(runId);

    return tr.run;
  }

  /**
   * Cancels a run immediately: aborts in-flight LLM call, kills sandbox shell + background processes,
   * marks in-flight tool parts as `interrupted`, and transitions to `cancelled` (H3).
   */
  async cancelRun(runId: string, reason = "Cancelled by user"): Promise<DurableRunRecord | null> {
    const run = this.stateMachine.getRun(runId);
    if (!run) return null;
    if (isTerminalRunStatus(run.status)) return run;

    const ctrl = this.activeControllers.get(runId);
    if (ctrl) {
      ctrl.abort(Object.assign(new Error(reason), { code: "CANCELLED" }));
      this.activeControllers.delete(runId);
    }

    // Stop any running commands or background servers inside the session sandbox (H3)
    const tenantId = run.tenantId ?? "default";
    const session = await this.deps.stateStore.getSession(tenantId, run.sessionId);
    const sbId = run.sandboxHandleId ?? session?.sandboxHandleId;
    if (sbId) {
      const h = this.activeSandboxes.get(sbId);
      if (h?.transport) {
        await h.transport.request("POST", "/processes/stop-all", {}).catch(() => {});
        await h.transport.request("POST", "/shell/main/interrupt", {}).catch(() => {});
      } else {
        const daemon = getActiveSandboxDaemon(sbId);
        if (daemon) {
          await daemon
            .handleRequest("POST", "/processes/stop-all", { "x-session-key": daemon.config.sessionKey }, {})
            .catch(() => {});
          await daemon
            .handleRequest("POST", "/shell/main/interrupt", { "x-session-key": daemon.config.sessionKey }, {})
            .catch(() => {});
        }
      }
    }

    // Mark any in-flight tool calls on the last assistant message as interrupted
    const { messages } = await this.deps.stateStore.getMessages(tenantId, run.sessionId);
    const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant");
    if (lastAssistant) {
      let modified = false;
      for (let i = 0; i < lastAssistant.parts.length; i++) {
        const p = lastAssistant.parts[i]!;
        if (p.type === "tool" && (p.state === "running" || p.state === "pending")) {
          const updatedPart: ToolPart = {
            ...p,
            state: "interrupted",
            error: reason,
            endedAt: Date.now(),
          };
          lastAssistant.parts[i] = updatedPart;
          modified = true;
          await this.emitter.emit(tenantId, run.sessionId, {
            type: "part.updated",
            sessionId: run.sessionId,
            messageId: lastAssistant.info.id,
            part: updatedPart,
          });
        }
      }
      if (modified) {
        await this.deps.stateStore.saveMessage(tenantId, run.sessionId, lastAssistant);
      }
    }

    const tr = await this.stateMachine.transition(runId, run.status, "cancelled", {
      phase: "cancelled",
      error: reason,
      pendingQuestion: null,
    });

    if (tr.ok && tr.run) {
      await this.emitter.emit(tenantId, run.sessionId, {
        type: "run.status",
        sessionId: run.sessionId,
        runId,
        status: "cancelled",
        error: reason,
      });
      return tr.run;
    }
    return this.stateMachine.getRun(runId);
  }

  async replyPermission(tenantId: string, requestId: string, reply: PermissionReply): Promise<{ handled: boolean; phase?: string }> {
    const req = await this.deps.stateStore.getPermissionRequest(tenantId, requestId);
    if (!req) return { handled: false };
    const session = await this.deps.stateStore.getSession(tenantId, req.sessionId);
    const runId = session?.activeRunId ?? session?.runId;
    if (!runId || !this.stateMachine.getRun(runId)) return { handled: false };
    const checkpoint = await this.deps.stateStore.getStepCheckpoint(tenantId, runId);
    if (!checkpoint) return { handled: false };
    const { state: updatedState } = await applyPermissionDecisionToState(checkpoint.state, reply, this.deps);
    await this.stateMachine.transition(runId, ["awaiting_permission", "running"], "running", { phase: updatedState.phase });
    this.launchRun(runId);
    return { handled: true, phase: updatedState.phase };
  }

  async pauseRun(runId: string): Promise<DurableRunRecord | null> {
    const run = this.stateMachine.getRun(runId);
    if (!run) return null;
    if (isTerminalRunStatus(run.status)) return run;
    const tr = await this.stateMachine.transition(runId, ["running", "awaiting_input", "awaiting_permission", "queued"], "awaiting_input", { phase: "paused" });
    this.activeControllers.get(runId)?.abort(Object.assign(new Error("Run paused"), { code: "RUN_PAUSED" }));
    if (tr.ok && tr.run) {
      await this.emitter.emit(tr.run.tenantId ?? "default", tr.run.sessionId, {
        type: "run.status", sessionId: tr.run.sessionId, runId, status: "awaiting_input",
      });
    }
    return tr.run;
  }

  async resumeRun(runId: string, _opts?: { extend?: boolean }): Promise<DurableRunRecord | null> {
    const run = this.stateMachine.getRun(runId);
    if (!run) return null;
    if (run.status !== "awaiting_input" || run.phase !== "paused") return run;
    const checkpoint = await this.deps.stateStore.getStepCheckpoint(run.tenantId ?? "default", runId);
    const resumePhase = checkpoint?.state.phase && checkpoint.state.phase !== "paused"
      ? checkpoint.state.phase
      : "building";
    const tr = await this.stateMachine.transition(runId, "awaiting_input", "running", { phase: resumePhase });
    if (tr.ok) {
      await this.emitter.emit(tr.run?.tenantId ?? run.tenantId ?? "default", run.sessionId, {
        type: "run.status", sessionId: run.sessionId, runId, status: "running",
      });
      this.launchRun(runId);
    }
    return tr.run;
  }

  async retryRun(runId: string): Promise<DurableRunRecord> {
    const prev = this.stateMachine.getRun(runId);
    if (!prev) {
      throw new HttpError(404, `Run not found: ${runId}`);
    }
    if (prev.status !== "failed" && prev.status !== "cancelled") {
      throw new HttpError(409, `Only failed or cancelled runs can be retried (status: ${prev.status})`);
    }
    const { run } = await this.enqueueAndStart({
      sessionId: prev.sessionId,
      tenantId: prev.tenantId,
      prompt: prev.prompt,
      agent: prev.agent,
      model: prev.snapshot.model,
      runtime: prev.runtime,
      mode: prev.mode,
      clientTurnId: prev.clientTurnId,
      attachmentIds: prev.attachmentIds,
      tools: prev.snapshot.tools,
      limits: prev.snapshot.limits,
    });
    this.launchRun(run.id);
    return run;
  }

  async startRun(runId: string): Promise<void> {
    const current = this.stateMachine.getRun(runId);
    if (!current || isTerminalRunStatus(current.status)) return;

    if (current.status === "queued") {
      const tr = await this.stateMachine.transition(runId, "queued", "running");
      if (!tr.ok) return;
    }

    const run = this.stateMachine.getRun(runId)!;
    const tenantId = run.tenantId ?? "default";
    const ctrl = new AbortController();
    this.activeControllers.set(runId, ctrl);

    const hbTimer = setInterval(() => {
      void this.stateMachine.heartbeat(runId);
    }, this.heartbeatIntervalMs);

    const firstActivityLimit = run.snapshot.limits.firstActivityTimeoutMs ?? 180_000;
    const firstActivityTimer = setTimeout(() => {
      const latest = this.stateMachine.getRun(runId);
      if (latest && latest.status === "running" && !latest.firstActivityAt) {
        ctrl.abort(
          Object.assign(new Error("First activity timeout exceeded"), {
            code: "FIRST_ACTIVITY_TIMEOUT",
          })
        );
      }
    }, firstActivityLimit);
    const markActivity = () => {
      void this.stateMachine.heartbeat(runId, true);
      clearTimeout(firstActivityTimer);
    };

    try {
      const existingCp = await this.deps.stateStore.getStepCheckpoint(tenantId, runId);
      const session = await this.deps.stateStore.getSession(tenantId, run.sessionId);
      let state: RunState = existingCp
        ? existingCp.state
        : createInitialRunState({
            runId: run.id,
            sessionId: run.sessionId,
            tenantId,
            agent: run.agent,
            model: run.snapshot.model,
            runtime: run.runtime ?? session?.runtime ?? undefined,
            mode: run.mode,
            phase: run.mode === "chat" || run.mode === "ask" ? "building" : "planning",
            sandboxHandleId: run.sandboxHandleId ?? session?.sandboxHandleId ?? null,
            attachmentIds: run.attachmentIds,
          });

      const loopGuard =
        this.loopGuards.get(runId) ??
        new ToolLoopGuard({ maxRepeatedIdentical: 3, maxPerPhase: 25 });
      this.loopGuards.set(runId, loopGuard);

      const toolTimeoutMs = run.snapshot.limits.toolTimeoutMs ?? 180_000;

      // Wrap provider & toolRouter with signal, first-activity tracking, tool timeout, and ToolLoopGuard
      const scopedDeps: EngineDeps = {
        ...this.deps,
        ensureSandbox: this.deps.ensureSandbox
          ? async (s) => {
              void this.stateMachine.heartbeat(runId);
              const handle = await this.deps.ensureSandbox!(s);
              markActivity();
              return handle;
            }
          : undefined,
        onTextDelta: (...args) => {
          markActivity();
          this.deps.onTextDelta?.(...args);
        },
        onReasoningDelta: (...args) => {
          markActivity();
          this.deps.onReasoningDelta?.(...args);
        },
        provider: {
          generateTurn: async (req) => {
            if (ctrl.signal.aborted) {
              throw ctrl.signal.reason ?? Object.assign(new Error("Cancelled"), { code: "CANCELLED" });
            }
            const res = await this.deps.provider.generateTurn({
              ...req,
              signal: ctrl.signal,
              onDelta: (delta) => {
                markActivity();
                req.onDelta?.(delta);
              },
            });
            await this.stateMachine.heartbeat(runId, true);
            clearTimeout(firstActivityTimer);
            return res;
          },
        },
        toolRouter: {
          listTools: (s) => this.deps.toolRouter.listTools(s),
          getTool: (name) => this.deps.toolRouter.getTool(name),
          executeTool: async (callId, name, input, ctx) => {
            if (ctrl.signal.aborted) {
              throw ctrl.signal.reason ?? Object.assign(new Error("Cancelled"), { code: "CANCELLED" });
            }
            await this.stateMachine.heartbeat(runId, true);
            clearTimeout(firstActivityTimer);

            let timer: NodeJS.Timeout | undefined;
            const timeoutPromise = new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(
                  Object.assign(
                    new Error(`Tool execution timed out after ${toolTimeoutMs}ms: ${name}`),
                    { code: "TOOL_TIMEOUT" }
                  )
                );
              }, toolTimeoutMs);
            });

            const execRes = await Promise.race([
              this.deps.toolRouter.executeTool(callId, name, input, {
                ...ctx,
                signal: ctrl.signal,
              }),
              timeoutPromise,
            ]).finally(() => {
              if (timer) clearTimeout(timer);
            });

            if (
              !execRes.error &&
              (name === "write_file" || name === "edit" || name === "apply_patch") &&
              typeof input.path === "string"
            ) {
              state.changedFiles = Array.from(new Set([...(state.changedFiles ?? []), input.path]));
            }

            const guardDec = loopGuard.recordCall(
              state.phase,
              name,
              input,
              Boolean(execRes.error)
            );
            if (guardDec.action === "abort") {
              throw Object.assign(new Error(guardDec.reason ?? "Tool loop detected"), {
                code: "TOOL_LOOP",
              });
            }
            if (guardDec.action === "warn") {
              return {
                ...execRes,
                output:
                  typeof execRes.output === "string"
                    ? `${execRes.output}\n\n[HARNESS WARNING] ${guardDec.reason}`
                    : { result: execRes.output, warning: guardDec.reason },
              };
            }
            return execRes;
          },
        },
      };

      while (true) {
        const latestRun = this.stateMachine.getRun(runId);
        if (!latestRun || isTerminalRunStatus(latestRun.status)) break;
        if (ctrl.signal.aborted) {
          throw ctrl.signal.reason ?? Object.assign(new Error("Cancelled"), { code: "CANCELLED" });
        }

        const stepRes = await runStep(state, scopedDeps);
        state = stepRes.state;
        await this.stateMachine.updateRun(runId, {
          phase: state.phase,
          iteration: state.iteration,
          sandboxHandleId: state.sandboxHandleId ?? undefined,
          usage: state.usage,
          cost: state.cost,
          changedFiles: state.changedFiles ?? [],
          previewUrl: state.previewUrl,
        });

        if (state.phase === "awaiting_input") {
          const waiting = this.stateMachine.getRun(runId);
          const currentCheckpoint = await this.deps.stateStore.getStepCheckpoint(tenantId, runId);
          if (waiting?.status === "running" && currentCheckpoint?.state.pendingQuestion) {
            await this.stateMachine.transition(runId, "running", "awaiting_input", {
              phase: "awaiting_input",
              pendingQuestion: state.pendingQuestion ?? null,
              questionsAsked: state.questionsAsked ?? waiting.questionsAsked,
            });
          }
        }

        if (state.phase === "awaiting_permission") {
          const waiting = this.stateMachine.getRun(runId);
          if (waiting?.status === "running") {
            await this.stateMachine.transition(runId, "running", "awaiting_permission", { phase: "awaiting_permission" });
          }
        }

        if (state.plan) {
          await this.emitter.emit(tenantId, run.sessionId, {
            type: "plan.updated",
            sessionId: run.sessionId,
            runId,
            plan: state.plan,
          });
        }

        if (
          state.phase === "completed" ||
          state.phase === "failed" ||
          state.phase === "cancelled" ||
          state.phase === "paused" ||
          state.phase === "awaiting_permission" ||
          state.phase === "awaiting_input"
        ) {
          break;
        }
      }

      const postLoopRun = this.stateMachine.getRun(runId);
      if (postLoopRun && !isTerminalRunStatus(postLoopRun.status)) {
        if (state.phase === "completed" || state.phase === "paused") {
          await this.stateMachine.transition(runId, postLoopRun.status, "completed", {
            phase: "completed",
            changedFiles: state.changedFiles ?? [],
            previewUrl: state.previewUrl,
          });
        }
      }
    } catch (err) {
      const latest = this.stateMachine.getRun(runId);
      if (latest && !isTerminalRunStatus(latest.status)) {
        const diag = diagnoseError(err);
        if ((err as { code?: string })?.code === "RUN_PAUSED") {
          // The last committed step checkpoint is resumed by resumeRun.
        } else if (diag.code === "CANCELLED") {
          await this.cancelRun(runId, diag.detail ?? diag.message);
        } else {
          await this.stateMachine.transition(runId, latest.status, "failed", {
            phase: "failed",
            error: diag.message,
            diagnostic: diag,
          });
          await this.emitter.emit(tenantId, run.sessionId, {
            type: "run.error",
            sessionId: run.sessionId,
            runId,
            code: diag.code,
            message: diag.message,
            recoverable: diag.recoverable,
            error: diag,
          });
          await this.emitter.emit(tenantId, run.sessionId, {
            type: "run.status",
            sessionId: run.sessionId,
            runId,
            status: "failed",
            error: diag.message,
          });
        }
      }
    } finally {
      clearTimeout(firstActivityTimer);
      clearInterval(hbTimer);
      if (this.activeControllers.get(runId) === ctrl) {
        this.activeControllers.delete(runId);
      }
    }
  }
}
