import type {
  Message,
  OpenHarnessEvent,
  Part,
  PermissionReply,
  PermissionRequest,
  PlanData,
  RunMode,
  RunPhase,
  RunRecord,
  ToolPart,
} from "@openharness/sdk";
import type {
  BudgetState,
  EngineDeps,
  RunState,
  StepCheckpoint,
} from "./deps.ts";
import {
  isTerminalPhase,
  isWaitingPhase,
  mapPhaseToSessionStatus,
} from "./phases.ts";

export const MAX_STEPS_WRAPUP_PROMPT =
  "You have reached the execution budget limit for this run. Tools are now disabled. Summarize completed work, current file state, any remaining tasks, and recommended next steps concisely.";

export function defaultBudgetsForMode(mode: RunMode, overrides?: Partial<BudgetState>): BudgetState {
  if (mode === "long_task") {
    return {
      maxIterations: overrides?.maxIterations ?? 500,
      maxTaskIterations: overrides?.maxTaskIterations ?? 5000,
      maxRunDurationSec: overrides?.maxRunDurationSec ?? 28_800,
      maxOutputTokensPerCall: overrides?.maxOutputTokensPerCall ?? 8192,
      maxCostPerRun: overrides?.maxCostPerRun ?? 25.0,
      maxCostPerTask: overrides?.maxCostPerTask ?? 100.0,
      maxCommandSec: overrides?.maxCommandSec ?? 1800,
      warnedResources: overrides?.warnedResources ?? [],
      extensionsCount: overrides?.extensionsCount ?? 0,
    };
  }
  if (mode === "task") {
    return {
      maxIterations: overrides?.maxIterations ?? 150,
      maxRunDurationSec: overrides?.maxRunDurationSec ?? 3600,
      maxOutputTokensPerCall: overrides?.maxOutputTokensPerCall ?? 8192,
      maxCostPerRun: overrides?.maxCostPerRun,
      maxCommandSec: overrides?.maxCommandSec ?? 1800,
      warnedResources: overrides?.warnedResources ?? [],
      extensionsCount: overrides?.extensionsCount ?? 0,
    };
  }
  return {
    maxIterations: overrides?.maxIterations ?? 25,
    maxRunDurationSec: overrides?.maxRunDurationSec ?? 600,
    maxOutputTokensPerCall: overrides?.maxOutputTokensPerCall ?? 4096,
    maxCostPerRun: overrides?.maxCostPerRun,
    maxCommandSec: overrides?.maxCommandSec ?? 120,
    warnedResources: overrides?.warnedResources ?? [],
    extensionsCount: overrides?.extensionsCount ?? 0,
  };
}

export function createInitialRunState(params: {
  runId: string;
  jobId?: string;
  sessionId: string;
  tenantId?: string;
  agent?: string;
  model?: string;
  runtime?: string;
  mode?: RunMode;
  phase?: RunPhase;
  budgets?: Partial<BudgetState>;
  sandboxHandleId?: string | null;
  now?: number;
  unattended?: boolean;
  onConfirm?: "deny" | "pause";
  confirmationPolicy?: "always" | "risky" | "never";
}): RunState {
  const mode = params.mode ?? "chat";
  const now = params.now ?? Date.now();
  const initialPhase: RunPhase =
    params.phase ?? (params.agent === "plan" || mode !== "chat" ? "planning" : "building");
  return {
    runId: params.runId,
    jobId: params.jobId,
    sessionId: params.sessionId,
    tenantId: params.tenantId ?? "default",
    agent: params.agent ?? "assistant",
    model: params.model ?? "mock/demo",
    runtime: params.runtime,
    mode,
    phase: initialPhase,
    iteration: 0,
    taskIteration: 0,
    transcriptCursor: 0,
    budgets: defaultBudgetsForMode(mode, params.budgets),
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
    cost: 0,
    plan: null,
    todos: [],
    features: [],
    featureId: null,
    pendingApproval: null,
    lastCheckpoint: null,
    sandboxHandleId: params.sandboxHandleId ?? null,
    sandboxSnapshotId: null,
    inFlightToolCalls: [],
    completedToolCalls: {},
    verifyFailures: [],
    malformedCallStreak: 0,
    compactionStreak: 0,
    stuckWarningsIssued: 0,
    tainted: false,
    taintSources: [],
    preTaintAllowedDomains: [],
    startedAt: now,
    updatedAt: now,
    unattended: params.unattended ?? false,
    onConfirm: params.onConfirm ?? "deny",
    confirmationPolicy: params.confirmationPolicy,
  };
}

async function emitAndPersist(
  deps: EngineDeps,
  state: RunState,
  events: OpenHarnessEvent[],
  ev: OpenHarnessEvent
): Promise<void> {
  events.push(ev);
  const env = await deps.stateStore.appendEvent(state.tenantId, state.sessionId, ev);
  deps.eventBus.publish(env);
}

async function transitionPhase(
  deps: EngineDeps,
  state: RunState,
  nextPhase: RunPhase,
  events: OpenHarnessEvent[],
  opts?: { error?: string; pauseReason?: string }
): Promise<void> {
  const previousPhase = state.phase;
  state.phase = nextPhase;
  state.updatedAt = deps.clock.now();
  if (opts?.error !== undefined) state.error = opts.error;
  if (opts?.pauseReason !== undefined) state.pauseReason = opts.pauseReason;
  if (isTerminalPhase(nextPhase)) {
    state.completedAt = state.updatedAt;
  }

  const mappedStatus = mapPhaseToSessionStatus(nextPhase);
  if (previousPhase !== nextPhase) {
    await emitAndPersist(deps, state, events, {
      type: "run.phase",
      sessionId: state.sessionId,
      runId: state.runId,
      phase: nextPhase,
      previousPhase,
      featureId: state.featureId ?? undefined,
    });
  }

  await emitAndPersist(deps, state, events, {
    type: "run.status",
    sessionId: state.sessionId,
    status: mappedStatus,
    error: state.error,
  });

  const existingSession = await deps.stateStore.getSession(state.tenantId, state.sessionId);
  if (existingSession) {
    const updatedSession = {
      ...existingSession,
      status: mappedStatus,
      phase: nextPhase,
      runId: state.runId,
      featureId: state.featureId ?? existingSession.featureId,
      lastCheckpoint: state.lastCheckpoint ?? existingSession.lastCheckpoint,
      tainted: state.tainted,
      usage: state.usage,
      cost: state.cost,
      error: state.error,
      updatedAt: state.updatedAt,
    };
    await deps.stateStore.saveSession(state.tenantId, updatedSession);
    await emitAndPersist(deps, state, events, {
      type: "session.updated",
      session: updatedSession,
    });
  }

  const runRecord: RunRecord = {
    id: state.runId,
    sessionId: state.sessionId,
    tenantId: state.tenantId,
    mode: state.mode,
    status: mappedStatus,
    phase: nextPhase,
    iteration: state.iteration,
    maxIterations: state.budgets.maxIterations,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
    pauseReason: state.pauseReason,
    error: state.error,
    featureId: state.featureId ?? undefined,
    lastCheckpoint: state.lastCheckpoint ?? undefined,
    sandboxHandleId: state.sandboxHandleId ?? undefined,
    usage: state.usage,
    cost: state.cost,
  };
  await deps.stateStore.saveRun(state.tenantId, runRecord);
}

export async function persistStepCheckpoint(
  deps: EngineDeps,
  state: RunState
): Promise<StepCheckpoint> {
  const cp: StepCheckpoint = {
    runId: state.runId,
    sessionId: state.sessionId,
    tenantId: state.tenantId,
    stepIndex: state.iteration,
    state: structuredClone(state),
    transcriptCursor: state.transcriptCursor,
    usage: structuredClone(state.usage),
    cost: state.cost,
    pendingApproval: state.pendingApproval ? structuredClone(state.pendingApproval) : null,
    sandboxHandleId: state.sandboxHandleId,
    lastCheckpointSha: state.lastCheckpoint,
    inFlightToolCalls: structuredClone(state.inFlightToolCalls),
    completedToolCallIds: Object.keys(state.completedToolCalls),
    savedAt: deps.clock.now(),
  };
  await deps.stateStore.saveStepCheckpoint(cp);
  return cp;
}


async function addressMessage(
  deps: EngineDeps,
  state: RunState,
  events: OpenHarnessEvent[],
  text: string
): Promise<void> {
  const msg: Message = {
    info: {
      id: `msg-sys-${state.runId}-${state.iteration}-${ state.verifyFailures.length }`,
      role: "user",
      summary: true,
    },
    createdAt: deps.clock.now(),
    parts: [{ type: "text", text, synthetic: true }],
  };
  await deps.stateStore.saveMessage(state.tenantId, state.sessionId, msg);
  state.transcriptCursor += 1;
  await emitAndPersist(deps, state, events, {
    type: "message.updated",
    sessionId: state.sessionId,
    message: msg,
  });
}

async function checkBudgetsAndWarn(
  deps: EngineDeps,
  state: RunState,
  events: OpenHarnessEvent[]
): Promise<{ breached: boolean; reason?: string }> {
  const now = deps.clock.now();
  const elapsedSec = Math.max(0, (now - state.startedAt) / 1000);

  const checks: Array<{
    resource: "iterations" | "duration" | "cost";
    used: number;
    limit: number | undefined;
  }> = [
    {
      resource: "iterations",
      used: state.iteration,
      limit: state.budgets.maxIterations,
    },
    {
      resource: "duration",
      used: elapsedSec,
      limit: state.budgets.maxRunDurationSec,
    },
    {
      resource: "cost",
      used: state.cost,
      limit: state.budgets.maxCostPerRun,
    },
  ];

  for (const c of checks) {
    if (c.limit === undefined || c.limit <= 0) continue;
    const ratio = c.used / c.limit;
    if (ratio >= 0.8 && !state.budgets.warnedResources.includes(c.resource)) {
      state.budgets.warnedResources.push(c.resource);
      await emitAndPersist(deps, state, events, {
        type: "budget.warning",
        sessionId: state.sessionId,
        runId: state.runId,
        resource: c.resource,
        used: c.used,
        limit: c.limit,
        ratio,
      });
    }
    if (c.used >= c.limit) {
      return { breached: true, reason: `budget_exhausted:${c.resource}` };
    }
  }

  if (
    state.budgets.maxTaskIterations &&
    state.taskIteration >= state.budgets.maxTaskIterations
  ) {
    return { breached: true, reason: "budget_exhausted:task_iterations" };
  }

  return { breached: false };
}

/**
 * Executes a single step of the AgentEngine state machine (§3 A.1, A.2).
 */
export async function runStep(
  inputState: RunState,
  deps: EngineDeps
): Promise<{ state: RunState; events: OpenHarnessEvent[] }> {
  const state = structuredClone(inputState);
  const events: OpenHarnessEvent[] = [];

  if (isTerminalPhase(state.phase) || state.phase === "paused" || state.phase === "stuck") {
    return { state, events };
  }

  // Ensure sandbox is provisioned when mode !== "chat" or runtime !== "local" (Step 8 R4, R5)
  if (
    !state.sandboxHandleId &&
    deps.ensureSandbox &&
    (state.mode !== "chat" || (state.runtime && state.runtime !== "local"))
  ) {
    const h = await deps.ensureSandbox(state);
    state.sandboxHandleId = h.id;
  }

  // 1. Handle pending approval state
  if (state.phase === "awaiting_permission") {
    if (state.pendingApproval) {
      return { state, events };
    }
    await transitionPhase(deps, state, "building", events);
  }

  // 2. Recover any in-flight tool calls from an interrupted worker (§3 A.2)
  if (state.inFlightToolCalls.length > 0) {
    const { messages } = await deps.stateStore.getMessages(state.tenantId, state.sessionId);
    const lastAssistantMsg = [...messages].reverse().find((m) => m.info.role === "assistant");

    for (const inflight of state.inFlightToolCalls) {
      if (state.completedToolCalls[inflight.callId]) {
        continue;
      }
      const toolDef = deps.toolRouter.getTool(inflight.tool);
      if (inflight.idempotent && toolDef) {
        const res = await deps.toolRouter.executeTool(
          inflight.callId,
          inflight.tool,
          (inflight.input as Record<string, unknown>) ?? {},
          {
            runId: state.runId,
            sessionId: state.sessionId,
            tenantId: state.tenantId,
            workspaceRoot: deps.workspaceRoot,
            sandboxHandleId: state.sandboxHandleId,
            state,
          }
        );
        state.completedToolCalls[inflight.callId] = {
          output: res.output,
          error: res.error,
          state: res.error ? "error" : "completed",
        };
        if (lastAssistantMsg) {
          const part: ToolPart = {
            type: "tool",
            tool: inflight.tool,
            callId: inflight.callId,
            state: res.error ? "error" : "completed",
            input: inflight.input,
            output: res.output,
            error: res.error,
            startedAt: inflight.startedAt,
            endedAt: deps.clock.now(),
          };
          updateMessageToolPart(lastAssistantMsg, part);
          await deps.stateStore.saveMessage(state.tenantId, state.sessionId, lastAssistantMsg);
          await emitAndPersist(deps, state, events, {
            type: "part.updated",
            sessionId: state.sessionId,
            messageId: lastAssistantMsg.info.id,
            part,
          });
        }
      } else {
        // Non-idempotent tool call was running when worker died: report as interrupted, NEVER re-execute (§3 A.2)
        const interruptedMsg =
          inflight.partialOutput
            ? `Interrupted during worker restart. Partial output: ${inflight.partialOutput}`
            : "Interrupted during worker restart; non-idempotent tool call was not re-executed.";
        state.completedToolCalls[inflight.callId] = {
          output: inflight.partialOutput ?? null,
          error: interruptedMsg,
          state: "interrupted",
        };
        if (lastAssistantMsg) {
          const part: ToolPart = {
            type: "tool",
            tool: inflight.tool,
            callId: inflight.callId,
            state: "interrupted",
            input: inflight.input,
            output: inflight.partialOutput ?? undefined,
            error: interruptedMsg,
            startedAt: inflight.startedAt,
            endedAt: deps.clock.now(),
          };
          updateMessageToolPart(lastAssistantMsg, part);
          await deps.stateStore.saveMessage(state.tenantId, state.sessionId, lastAssistantMsg);
          await emitAndPersist(deps, state, events, {
            type: "part.updated",
            sessionId: state.sessionId,
            messageId: lastAssistantMsg.info.id,
            part,
          });
        }
      }
    }
    state.inFlightToolCalls = [];
    await persistStepCheckpoint(deps, state);
  }

  // 3. Budget check before starting next step (Phase G.1)
  const budgetStatus = await checkBudgetsAndWarn(deps, state, events);
  if (budgetStatus.breached) {
    // Graceful wrap-up prompt with tools disabled
    const { messages } = await deps.stateStore.getMessages(state.tenantId, state.sessionId);
    const wrapUpUserMsg: Message = {
      info: { id: `msg-wrapup-${state.runId}-${state.iteration}`, role: "user", summary: true },
      createdAt: deps.clock.now(),
      parts: [{ type: "text", text: MAX_STEPS_WRAPUP_PROMPT, synthetic: true }],
    };
    const wrapTurn = await deps.provider.generateTurn({
      runId: state.runId,
      sessionId: state.sessionId,
      model: state.model,
      systemPrompt: "Provide a concise wrap-up summary of progress and remaining work.",
      messages: [...messages, wrapUpUserMsg],
      tools: [],
      maxOutputTokens: state.budgets.maxOutputTokensPerCall,
    });
    const wrapAssistantMsg: Message = {
      info: {
        id: `msg-a-wrapup-${state.runId}-${state.iteration}`,
        role: "assistant",
        agent: state.agent,
        model: state.model,
      },
      createdAt: deps.clock.now(),
      completedAt: deps.clock.now(),
      parts: [{ type: "text", text: wrapTurn.text || "Budget exhausted; pausing run." }],
    };
    await deps.stateStore.saveMessage(state.tenantId, state.sessionId, wrapAssistantMsg);
    await emitAndPersist(deps, state, events, {
      type: "message.updated",
      sessionId: state.sessionId,
      message: wrapAssistantMsg,
    });

    if (deps.onCreateCheckpoint) {
      const cp = await deps.onCreateCheckpoint(state, "Checkpoint on budget exhaustion", true);
      if (cp) {
        state.lastCheckpoint = cp.sha;
        await deps.stateStore.saveCheckpointInfo(state.tenantId, state.sessionId, cp);
        await emitAndPersist(deps, state, events, {
          type: "checkpoint.created",
          sessionId: state.sessionId,
          runId: state.runId,
          checkpoint: cp,
        });
      }
    }

    await transitionPhase(deps, state, "paused", events, {
      pauseReason: "budget_exhausted",
    });
    await persistStepCheckpoint(deps, state);
    return { state, events };
  }

  // 4. Testing phase execution (Phase F.2)
  if (state.phase === "testing" && deps.onRunVerification) {
    const vResult = await deps.onRunVerification(state);
    for (const item of vResult.results) {
      await emitAndPersist(deps, state, events, {
        type: "verification.completed",
        sessionId: state.sessionId,
        result: {
          command: item.command,
          passed: item.passed,
          exitCode: item.exitCode,
          stdout: item.output,
        },
        iteration: state.verifyFailures.length + 1,
        maxIterations: 6,
      });
    }
    if (vResult.passed) {
      state.verificationPassed = true;
      state.toolsDisabled = false;
      if (deps.onRunReviewer) {
        await transitionPhase(deps, state, "reviewing", events);
      } else {
        if (deps.onCreateCheckpoint) {
          const cp = await deps.onCreateCheckpoint(state, "Verification passed", true);
          if (cp) {
            state.lastCheckpoint = cp.sha;
            await deps.stateStore.saveCheckpointInfo(state.tenantId, state.sessionId, cp);
            await emitAndPersist(deps, state, events, {
              type: "checkpoint.created",
              sessionId: state.sessionId,
              runId: state.runId,
              checkpoint: cp,
            });
          }
        }
        await transitionPhase(deps, state, "completed", events);
      }
    } else {
      const prev = state.verifyFailures[state.verifyFailures.length - 1];
      state.verifyFailures.push({
        iteration: state.verifyFailures.length + 1,
        signature: vResult.signature,
        condensedError: vResult.condensedError,
        failedCommands: vResult.results.filter((r) => !r.passed).map((r) => r.command),
      });
      const maxFix = Number(process.env.OH_MAX_FIX_ATTEMPTS ?? 5);
      const noProgress = Boolean(prev && prev.signature && prev.signature === vResult.signature);
      const exhausted = state.verifyFailures.length >= maxFix || noProgress;
      if (exhausted) {
        state.toolsDisabled = true;
        await addressMessage(
          deps,
          state,
          events,
          `Verification failed (${noProgress ? "identical error signature repeated" : `attempt ${state.verifyFailures.length}/${maxFix}`}):\n\n${vResult.condensedError}\n\nStop calling tools and clearly explain what is still failing and why.`
        );
      } else {
        await addressMessage(
          deps,
          state,
          events,
          `Verification failed (attempt ${state.verifyFailures.length}/${maxFix}):\n\n${vResult.condensedError}\n\nFix the root cause and finish your turn so verification runs again.`
        );
      }
      await transitionPhase(deps, state, "fixing", events);
    }
    await persistStepCheckpoint(deps, state);
    return { state, events };
  }

  // 5. Reviewing phase execution (Phase F.2)
  if (state.phase === "reviewing" && deps.onRunReviewer) {
    const review = await deps.onRunReviewer(state);
    if (review.verdict === "pass" && !review.tamperingDetected) {
      if (deps.onCreateCheckpoint) {
        const cp = await deps.onCreateCheckpoint(state, "Review passed", true);
        if (cp) {
          state.lastCheckpoint = cp.sha;
          await deps.stateStore.saveCheckpointInfo(state.tenantId, state.sessionId, cp);
          await emitAndPersist(deps, state, events, {
            type: "checkpoint.created",
            sessionId: state.sessionId,
            runId: state.runId,
            checkpoint: cp,
          });
        }
      }
      await transitionPhase(deps, state, "completed", events);
    } else {
      const issueSummary = review.issues.join("; ") || "Reviewer flagged issues";
      state.verifyFailures.push({
        iteration: state.verifyFailures.length + 1,
        signature: `review:${issueSummary.slice(0, 80)}`,
        condensedError: issueSummary,
        failedCommands: ["reviewer"],
      });
      await addressMessage(
        deps,
        state,
        events,
        `Code review found issues:\n${issueSummary}\n\nFix them and finish your turn.`
      );
      await transitionPhase(deps, state, "fixing", events);
    }
    await persistStepCheckpoint(deps, state);
    return { state, events };
  }

  // 6. Standard model turn (planning / building / fixing)
  const { messages } = await deps.stateStore.getMessages(state.tenantId, state.sessionId);
  const ctxPrepared = await deps.contextManager.prepareTurnContext(state, messages);
  for (const ev of ctxPrepared.events) {
    await emitAndPersist(deps, state, events, ev);
  }

  const availableTools = state.toolsDisabled ? [] : deps.toolRouter.listTools(state);
  const turnResponse = await deps.provider.generateTurn({
    runId: state.runId,
    sessionId: state.sessionId,
    model: state.model,
    systemPrompt: ctxPrepared.systemPrompt,
    messages: ctxPrepared.messages,
    tools: availableTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: t.parameters,
      masked: t.masked,
    })),
    maxOutputTokens: state.budgets.maxOutputTokensPerCall,
  });

  state.iteration += 1;
  state.taskIteration += 1;

  if (turnResponse.usage) {
    state.usage.input += turnResponse.usage.input || 0;
    state.usage.output += turnResponse.usage.output || 0;
    state.usage.reasoning = (state.usage.reasoning || 0) + (turnResponse.usage.reasoning || 0);
    state.usage.cacheRead = (state.usage.cacheRead || 0) + (turnResponse.usage.cacheRead || 0);
    if (turnResponse.usage.estimated) {
      state.usage.estimated = true;
    }
  }
  if (typeof turnResponse.cost === "number") {
    state.cost += turnResponse.cost;
  }

  const assistantMsgId = `msg-a-${state.runId}-${state.iteration}`;
  state.assistantMessageId = assistantMsgId;
  const parts: Part[] = [];
  if (turnResponse.reasoning) {
    parts.push({ type: "reasoning", text: turnResponse.reasoning });
  }
  if (turnResponse.text) {
    parts.push({ type: "text", text: turnResponse.text });
  }

  const assistantMsg: Message = {
    info: {
      id: assistantMsgId,
      role: "assistant",
      agent: state.agent,
      model: turnResponse.modelUsed ?? state.model,
      usage: turnResponse.usage,
      cost: turnResponse.cost,
    },
    createdAt: deps.clock.now(),
    parts,
  };

  await deps.stateStore.saveMessage(state.tenantId, state.sessionId, assistantMsg);
  state.transcriptCursor += 1;
  await emitAndPersist(deps, state, events, {
    type: "message.updated",
    sessionId: state.sessionId,
    message: assistantMsg,
  });

  // Checkpoint immediately after model response (§3 A.2)
  await persistStepCheckpoint(deps, state);

  // 7. Handle tool calls if any
  if (turnResponse.toolCalls.length > 0) {
    let checkpointedBeforeMutating = false;

    for (let idx = 0; idx < turnResponse.toolCalls.length; idx++) {
      const rawCall = turnResponse.toolCalls[idx]!;
      const callId = rawCall.id || `call_${state.runId}_${state.iteration}_${idx + 1}`;

      // Never replay already-completed tool calls (§3 A.2)
      if (state.completedToolCalls[callId]) {
        continue;
      }

      const toolDef = deps.toolRouter.getTool(rawCall.name);
      const parsedInput =
        typeof rawCall.arguments === "string"
          ? safeParseJsonObject(rawCall.arguments)
          : (rawCall.arguments ?? {});

      if (!toolDef || toolDef.masked) {
        state.malformedCallStreak += 1;
        const errText = !toolDef
          ? `Unknown tool "${rawCall.name}". Only call tools from the advertised list.`
          : `Tool "${rawCall.name}" is currently masked by policy in phase "${state.phase}".`;
        const errPart: ToolPart = {
          type: "tool",
          tool: rawCall.name,
          callId,
          state: "error",
          input: parsedInput,
          error: errText,
          startedAt: deps.clock.now(),
          endedAt: deps.clock.now(),
        };
        updateMessageToolPart(assistantMsg, errPart);
        state.completedToolCalls[callId] = { output: null, error: errText, state: "error" };
        await deps.stateStore.saveMessage(state.tenantId, state.sessionId, assistantMsg);
        await emitAndPersist(deps, state, events, {
          type: "part.updated",
          sessionId: state.sessionId,
          messageId: assistantMsg.info.id,
          part: errPart,
        });
        await persistStepCheckpoint(deps, state);
        continue;
      }

      // Automatic shadow-git checkpoint before the first mutating call of each step (§11 Phase I)
      if (!toolDef.readOnly && !checkpointedBeforeMutating && deps.onCreateCheckpoint) {
        checkpointedBeforeMutating = true;
        const cp = await deps.onCreateCheckpoint(
          state,
          `Auto-checkpoint before ${toolDef.name} at step ${state.iteration}`,
          true
        );
        if (cp) {
          state.lastCheckpoint = cp.sha;
          await deps.stateStore.saveCheckpointInfo(state.tenantId, state.sessionId, cp);
          await emitAndPersist(deps, state, events, {
            type: "checkpoint.created",
            sessionId: state.sessionId,
            runId: state.runId,
            checkpoint: cp,
          });
        }
      }

      // Policy gate evaluation
      const decision = await deps.policyGate.evaluateToolCall(toolDef, parsedInput, state);
      if (decision.action === "deny") {
        const denyReason = decision.reason || `Tool "${toolDef.name}" denied by policy.`;
        const deniedPart: ToolPart = {
          type: "tool",
          tool: toolDef.name,
          callId,
          state: "denied",
          input: parsedInput,
          error: denyReason,
          risk: decision.risk,
          startedAt: deps.clock.now(),
          endedAt: deps.clock.now(),
        };
        updateMessageToolPart(assistantMsg, deniedPart);
        state.completedToolCalls[callId] = { output: null, error: denyReason, state: "error" };
        await deps.stateStore.saveMessage(state.tenantId, state.sessionId, assistantMsg);
        await emitAndPersist(deps, state, events, {
          type: "part.updated",
          sessionId: state.sessionId,
          messageId: assistantMsg.info.id,
          part: deniedPart,
        });
        await persistStepCheckpoint(deps, state);
        continue;
      }

      if (decision.action === "ask") {
        // Handle unattended confirmation rules (§9 G.3)
        if (state.unattended) {
          if (state.onConfirm === "pause") {
            await transitionPhase(deps, state, "paused", events, {
              pauseReason: `Unattended run paused for confirmation on ${toolDef.name} (risk: ${decision.risk})`,
            });
            await persistStepCheckpoint(deps, state);
            return { state, events };
          } else {
            const denyMsg = `Unattended policy denied confirmation-required call "${toolDef.name}" (risk: ${decision.risk}). Reason: ${decision.reason ?? "requires human approval"}. Try a safer alternative.`;
            const deniedPart: ToolPart = {
              type: "tool",
              tool: toolDef.name,
              callId,
              state: "denied",
              input: parsedInput,
              error: denyMsg,
              risk: decision.risk,
              startedAt: deps.clock.now(),
              endedAt: deps.clock.now(),
            };
            updateMessageToolPart(assistantMsg, deniedPart);
            state.completedToolCalls[callId] = { output: null, error: denyMsg, state: "error" };
            await deps.stateStore.saveMessage(state.tenantId, state.sessionId, assistantMsg);
            await emitAndPersist(deps, state, events, {
              type: "part.updated",
              sessionId: state.sessionId,
              messageId: assistantMsg.info.id,
              part: deniedPart,
            });
            await persistStepCheckpoint(deps, state);
            continue;
          }
        }

        // Human-in-the-loop permission request (§3 A.2)
        const permReq: PermissionRequest = {
          id: `perm_${state.runId}_${callId}`,
          sessionId: state.sessionId,
          callId,
          permission: toolDef.name,
          title: `Approve ${toolDef.name}`,
          pattern: decision.pattern ?? toolDef.name,
          risk: decision.risk,
          metadata: {
            input: parsedInput,
            risk: decision.risk,
            tainted: state.tainted,
          },
          createdAt: deps.clock.now(),
        };
        const pendingPart: ToolPart = {
          type: "tool",
          tool: toolDef.name,
          callId,
          state: "pending",
          input: parsedInput,
          risk: decision.risk,
          startedAt: deps.clock.now(),
        };
        updateMessageToolPart(assistantMsg, pendingPart);
        await deps.stateStore.saveMessage(state.tenantId, state.sessionId, assistantMsg);
        await deps.stateStore.savePermissionRequest(state.tenantId, permReq);
        state.pendingApproval = permReq;

        await emitAndPersist(deps, state, events, {
          type: "part.updated",
          sessionId: state.sessionId,
          messageId: assistantMsg.info.id,
          part: pendingPart,
        });
        await emitAndPersist(deps, state, events, {
          type: "permission.asked",
          request: permReq,
        });
        await transitionPhase(deps, state, "awaiting_permission", events);
        await persistStepCheckpoint(deps, state);
        return { state, events };
      }

      // Record in-flight tool call and checkpoint before execution so a mid-call crash knows it was running (§3 A.2)
      const startedAt = deps.clock.now();
      state.inFlightToolCalls = [
        {
          callId,
          tool: toolDef.name,
          input: parsedInput,
          idempotent: Boolean(toolDef.idempotent ?? toolDef.readOnly),
          startedAt,
        },
      ];
      const runningPart: ToolPart = {
        type: "tool",
        tool: toolDef.name,
        callId,
        state: "running",
        input: parsedInput,
        risk: decision.risk,
        startedAt,
      };
      updateMessageToolPart(assistantMsg, runningPart);
      await deps.stateStore.saveMessage(state.tenantId, state.sessionId, assistantMsg);
      await emitAndPersist(deps, state, events, {
        type: "part.updated",
        sessionId: state.sessionId,
        messageId: assistantMsg.info.id,
        part: runningPart,
      });
      await persistStepCheckpoint(deps, state);

      // Execute tool
      const execResult = await deps.toolRouter.executeTool(callId, toolDef.name, parsedInput, {
        runId: state.runId,
        sessionId: state.sessionId,
        tenantId: state.tenantId,
        workspaceRoot: deps.workspaceRoot,
        sandboxHandleId: state.sandboxHandleId,
        state,
      });

      state.inFlightToolCalls = [];
      state.malformedCallStreak = 0;

      if (execResult.untrusted) {
        state.tainted = true;
        const src = execResult.provenance || toolDef.name;
        if (!state.taintSources.includes(src)) {
          state.taintSources.push(src);
        }
      }

      if (execResult.metadata?.plan) {
        state.plan = execResult.metadata.plan as PlanData;
      }

      const completedPart: ToolPart = {
        type: "tool",
        tool: toolDef.name,
        callId,
        state: execResult.error ? "error" : "completed",
        input: parsedInput,
        output: execResult.output,
        error: execResult.error,
        risk: decision.risk,
        metadata: execResult.metadata,
        startedAt,
        endedAt: deps.clock.now(),
      };
      updateMessageToolPart(assistantMsg, completedPart);
      state.completedToolCalls[callId] = {
        output: execResult.output,
        error: execResult.error,
        state: execResult.error ? "error" : "completed",
      };

      await deps.stateStore.saveMessage(state.tenantId, state.sessionId, assistantMsg);
      await emitAndPersist(deps, state, events, {
        type: "part.updated",
        sessionId: state.sessionId,
        messageId: assistantMsg.info.id,
        part: completedPart,
      });

      // Persist step checkpoint after every completed tool call (§3 A.2)
      await persistStepCheckpoint(deps, state);
    }

    // If in planning phase and a plan was published, transition to building (or pause if approval required)
    if (state.phase === "planning" && state.plan) {
      if (state.agent === "plan") {
        assistantMsg.completedAt = deps.clock.now();
        await deps.stateStore.saveMessage(state.tenantId, state.sessionId, assistantMsg);
        await transitionPhase(deps, state, "completed", events);
      } else {
        await transitionPhase(deps, state, "building", events);
      }
      await persistStepCheckpoint(deps, state);
    }

    return { state, events };
  }

  // 8. No tool calls in this turn: finalize assistant message and transition phase
  assistantMsg.completedAt = deps.clock.now();
  assistantMsg.parts.push({
    type: "step",
    usage: turnResponse.usage,
    cost: turnResponse.cost,
  });
  await deps.stateStore.saveMessage(state.tenantId, state.sessionId, assistantMsg);
  await emitAndPersist(deps, state, events, {
    type: "message.updated",
    sessionId: state.sessionId,
    message: assistantMsg,
  });

  if (
    (state.phase === "building" || state.phase === "fixing") &&
    deps.onRunVerification &&
    state.mode !== "chat" &&
    state.mode !== "ask" &&
    !state.toolsDisabled
  ) {
    await transitionPhase(deps, state, "testing", events);
  } else {
    await transitionPhase(deps, state, "completed", events);
  }

  await persistStepCheckpoint(deps, state);
  return { state, events };
}

/**
 * Resumes a run waiting on a PermissionRequest after the user or admin replies (§3 A.2).
 */
export async function applyPermissionDecisionToState(
  state: RunState,
  reply: PermissionReply,
  deps: EngineDeps
): Promise<{ state: RunState; events: OpenHarnessEvent[] }> {
  const next = structuredClone(state);
  const events: OpenHarnessEvent[] = [];
  const req = next.pendingApproval;
  if (!req) return { state: next, events };

  await deps.policyGate.recordPermissionReply(req, reply);
  await deps.stateStore.resolvePermissionRequest(next.tenantId, req.id, reply);
  next.pendingApproval = null;

  await emitAndPersist(deps, next, events, {
    type: "permission.replied",
    requestId: req.id,
    reply,
  });

  const { messages } = await deps.stateStore.getMessages(next.tenantId, next.sessionId);
  const lastAssistantMsg = [...messages].reverse().find((m) => m.info.role === "assistant");

  if (reply === "reject") {
    const denyMsg = `Permission rejected by user for tool "${req.permission}".`;
    next.completedToolCalls[req.callId] = {
      output: null,
      error: denyMsg,
      state: "error",
    };
    if (lastAssistantMsg) {
      const part: ToolPart = {
        type: "tool",
        tool: req.permission,
        callId: req.callId,
        state: "denied",
        input: req.metadata?.input ?? {},
        error: denyMsg,
        startedAt: typeof req.createdAt === "number" ? req.createdAt : deps.clock.now(),
        endedAt: deps.clock.now(),
      };
      updateMessageToolPart(lastAssistantMsg, part);
      await deps.stateStore.saveMessage(next.tenantId, next.sessionId, lastAssistantMsg);
      await emitAndPersist(deps, next, events, {
        type: "part.updated",
        sessionId: next.sessionId,
        messageId: lastAssistantMsg.info.id,
        part,
      });
    }
    await transitionPhase(deps, next, "building", events);
    await persistStepCheckpoint(deps, next);
    return { state: next, events };
  }

  // Approved (`once` or `always`): execute the approved tool call now
  const toolDef = deps.toolRouter.getTool(req.permission);
  if (toolDef) {
    const startedAt = deps.clock.now();
    const inputObj = (req.metadata?.input as Record<string, unknown>) ?? {};
    next.inFlightToolCalls = [
      {
        callId: req.callId,
        tool: toolDef.name,
        input: inputObj,
        idempotent: Boolean(toolDef.idempotent ?? toolDef.readOnly),
        startedAt,
      },
    ];
    await persistStepCheckpoint(deps, next);

    const execResult = await deps.toolRouter.executeTool(req.callId, toolDef.name, inputObj, {
      runId: next.runId,
      sessionId: next.sessionId,
      tenantId: next.tenantId,
      workspaceRoot: deps.workspaceRoot,
      sandboxHandleId: next.sandboxHandleId,
      state: next,
    });
    next.inFlightToolCalls = [];
    next.completedToolCalls[req.callId] = {
      output: execResult.output,
      error: execResult.error,
      state: execResult.error ? "error" : "completed",
    };
    if (lastAssistantMsg) {
      const part: ToolPart = {
        type: "tool",
        tool: toolDef.name,
        callId: req.callId,
        state: execResult.error ? "error" : "completed",
        input: inputObj,
        output: execResult.output,
        error: execResult.error,
        startedAt,
        endedAt: deps.clock.now(),
      };
      updateMessageToolPart(lastAssistantMsg, part);
      await deps.stateStore.saveMessage(next.tenantId, next.sessionId, lastAssistantMsg);
      await emitAndPersist(deps, next, events, {
        type: "part.updated",
        sessionId: next.sessionId,
        messageId: lastAssistantMsg.info.id,
        part: part,
      });
    }
  }

  await transitionPhase(deps, next, "building", events);
  await persistStepCheckpoint(deps, next);
  return { state: next, events };
}

/**
 * Runs a state machine until it reaches a waiting phase (`awaiting_permission`, `paused`, `stuck`)
 * or a terminal phase (`completed`, `failed`, `cancelled`).
 */
export async function runToStopOrWait(
  initialState: RunState,
  deps: EngineDeps
): Promise<{ state: RunState; events: OpenHarnessEvent[] }> {
  let current = structuredClone(initialState);
  const allEvents: OpenHarnessEvent[] = [];

  // Emit initial phase if iteration === 0 and no checkpoints exist yet
  if (current.iteration === 0 && Object.keys(current.completedToolCalls).length === 0) {
    await transitionPhase(deps, current, current.phase, allEvents);
    await persistStepCheckpoint(deps, current);
  }

  while (!isTerminalPhase(current.phase) && !isWaitingPhase(current.phase)) {
    const stepResult = await runStep(current, deps);
    current = stepResult.state;
    allEvents.push(...stepResult.events);
  }

  return { state: current, events: allEvents };
}

function updateMessageToolPart(msg: Message, part: ToolPart): void {
  const idx = msg.parts.findIndex((p) => p.type === "tool" && p.callId === part.callId);
  if (idx === -1) {
    msg.parts.push(part);
  } else {
    msg.parts[idx] = part;
  }
}

function safeParseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}
