import type { Message, ToolPart } from "@openharness/sdk";
import {
  createInitialRunState,
  getActiveSandboxDaemon,
  runStep,
  ToolLoopGuard,
  type EngineDeps,
  type RunState,
  type SandboxHandle,
} from "@openharness/core";
import { HttpError } from "../server.ts";
import { diagnoseError } from "./diagnose.ts";
import type { RunEventEmitter } from "./emitter.ts";
import { isTerminalRunStatus, type RunStateMachine } from "./run-state.ts";
import type {
  CreateRunInput,
  DurableRunRecord,
  QuestionRequest,
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
  private readonly questionWaiters = new Map<
    string,
    { resolve: (answer: string) => void; reject: (err: Error) => void }
  >();
  private readonly loopGuards = new Map<string, ToolLoopGuard>();

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

  /**
   * Called by the `ask_user` tool during a run (H5).
   * Pauses the run in `awaiting_input` and waits until `answerQuestion` or `cancelRun` is called.
   */
  async requestUserAnswer(
    runId: string,
    question: string,
    options?: string[],
    callId?: string
  ): Promise<string> {
    const run = this.stateMachine.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    const maxQuestions = run.snapshot.limits.maxQuestions ?? 3;
    if (run.questionsAsked >= maxQuestions) {
      return `Maximum clarifying questions (${maxQuestions}) reached for this run. Proceed with your best judgment.`;
    }

    const qReq: QuestionRequest = {
      questionId: `q_${runId}_${run.questionsAsked + 1}`,
      question,
      options,
      callId,
      askedAt: Date.now(),
    };

    const tr = await this.stateMachine.transition(runId, "running", "awaiting_input", {
      phase: "awaiting_input",
      pendingQuestion: qReq,
      questionsAsked: run.questionsAsked + 1,
    });
    if (!tr.ok) {
      throw new Error(`Cannot request user input when run is in status ${run.status}`);
    }

    const tenantId = run.tenantId ?? "default";
    await this.emitter.emit(tenantId, run.sessionId, {
      type: "question.requested",
      sessionId: run.sessionId,
      runId,
      questionId: qReq.questionId,
      question: qReq.question,
      options: qReq.options,
    });
    await this.emitter.emit(tenantId, run.sessionId, {
      type: "run.status",
      sessionId: run.sessionId,
      runId,
      status: "awaiting_input",
    });

    return new Promise<string>((resolve, reject) => {
      this.questionWaiters.set(runId, { resolve, reject });
    });
  }

  async answerQuestion(runId: string, answer: string): Promise<DurableRunRecord> {
    const run = this.stateMachine.getRun(runId);
    if (!run) {
      throw new HttpError(404, `Run not found: ${runId}`);
    }
    if (run.status !== "awaiting_input" || !run.pendingQuestion) {
      throw new HttpError(409, `Run ${runId} is not awaiting user input (status: ${run.status})`);
    }

    const qReq = {
      ...run.pendingQuestion,
      answeredAt: Date.now(),
      answer,
    };

    const tr = await this.stateMachine.transition(runId, "awaiting_input", "running", {
      phase: "building",
      pendingQuestion: null,
    });
    if (!tr.ok || !tr.run) {
      throw new HttpError(409, `Failed to transition run ${runId} to running`);
    }

    const tenantId = run.tenantId ?? "default";
    await this.emitter.emit(tenantId, run.sessionId, {
      type: "question.answered",
      sessionId: run.sessionId,
      runId,
      questionId: qReq.questionId,
      answer,
    });
    await this.emitter.emit(tenantId, run.sessionId, {
      type: "run.status",
      sessionId: run.sessionId,
      runId,
      status: "running",
    });

    const waiter = this.questionWaiters.get(runId);
    if (waiter) {
      this.questionWaiters.delete(runId);
      waiter.resolve(answer);
    } else {
      // Container restarted while awaiting_input: append user answer to transcript and resume run loop
      const { messages } = await this.deps.stateStore.getMessages(tenantId, run.sessionId);
      const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant");
      if (lastAssistant && qReq.callId) {
        const partIdx = lastAssistant.parts.findIndex(
          (p) => p.type === "tool" && p.callId === qReq.callId
        );
        if (partIdx !== -1) {
          const oldPart = lastAssistant.parts[partIdx] as ToolPart;
          lastAssistant.parts[partIdx] = {
            ...oldPart,
            state: "completed",
            output: { answer },
            endedAt: Date.now(),
          };
          await this.deps.stateStore.saveMessage(tenantId, run.sessionId, lastAssistant);
        }
      }
      void this.startRun(runId);
    }

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

    const waiter = this.questionWaiters.get(runId);
    if (waiter) {
      this.questionWaiters.delete(runId);
      waiter.reject(Object.assign(new Error(reason), { code: "CANCELLED" }));
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
      tools: prev.snapshot.tools,
      limits: prev.snapshot.limits,
    });
    void this.startRun(run.id);
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

    const firstActivityLimit = run.snapshot.limits.firstActivityTimeoutMs ?? 45_000;
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
          });

      const loopGuard =
        this.loopGuards.get(runId) ??
        new ToolLoopGuard({ maxRepeatedIdentical: 3, maxPerPhase: 25 });
      this.loopGuards.set(runId, loopGuard);

      const toolTimeoutMs = run.snapshot.limits.toolTimeoutMs ?? 120_000;

      // Wrap provider & toolRouter with signal, first-activity tracking, tool timeout, and ToolLoopGuard
      const scopedDeps: EngineDeps = {
        ...this.deps,
        provider: {
          generateTurn: async (req) => {
            if (ctrl.signal.aborted) {
              throw ctrl.signal.reason ?? Object.assign(new Error("Cancelled"), { code: "CANCELLED" });
            }
            const res = await this.deps.provider.generateTurn({
              ...req,
              signal: ctrl.signal,
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

            if (name === "ask_user") {
              const qText = String(input.question ?? "");
              const opts = Array.isArray(input.options) ? input.options.map(String) : undefined;
              const answer = await this.requestUserAnswer(runId, qText, opts, callId);
              return { output: { question: qText, answer } };
            }

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
          state.phase === "awaiting_permission"
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
          await this.emitter.emit(tenantId, run.sessionId, {
            type: "run.completed",
            sessionId: run.sessionId,
            runId,
            changedFiles: state.changedFiles ?? [],
            previewUrl: state.previewUrl,
          });
          await this.emitter.emit(tenantId, run.sessionId, {
            type: "run.status",
            sessionId: run.sessionId,
            runId,
            status: "completed",
          });
        }
      }
    } catch (err) {
      const latest = this.stateMachine.getRun(runId);
      if (latest && !isTerminalRunStatus(latest.status)) {
        const diag = diagnoseError(err);
        if (diag.code === "CANCELLED") {
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
      this.activeControllers.delete(runId);
    }
  }
}
