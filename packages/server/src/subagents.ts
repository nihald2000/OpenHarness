import type { DelegatedTaskPart, Message, OpenHarnessEvent, ToolPart } from "@openharness/sdk";
import {
  capSubagentReportTokens,
  RiskPolicyGate,
  type PolicyGate,
  type ProviderAdapter,
  type RegisteredTool,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRouter,
} from "@openharness/core";

export type SubagentRole = "explore" | "tester" | "reviewer" | "general" | "document";

const ROLE_PROMPTS: Record<string, string> = {
  explore:
    "You are an Explore subagent. Use read-only tools (`list`, `glob`, `search`, `read_file`) to investigate the codebase and return a concise, factual summary of findings with exact file paths.",
  tester:
    "You are a Tester subagent. Run tests or inspect the running app with `process_start`, `process_logs`, `process_stop`, and `browser_navigate` plus the other browser tools. Report what passed or failed.",
  reviewer:
    "You are a Reviewer subagent. Inspect changed files and tests for bugs, regressions, or test tampering, and return a concise review report.",
  general:
    "You are a General subagent. Complete the requested coding task in the shared workspace using read and build tools. Do not delegate or ask the user questions.",
  document:
    "You are a Document & Visual Studio subagent. Follow a three-phase craft workflow: (1) Load the matching studio skill and plan a cohesive palette, typography hierarchy, and section, sheet, or slide structure; (2) create bespoke visual assets or diagrams and build the requested editable document; (3) run render_document_preview and inspect the pages, resolving clipped text, table collisions, and spreadsheet formula errors before returning.",
};

const EXPLORE_TOOLS = new Set(["read_file", "list", "glob", "search", "word_count"]);
const TESTER_TOOLS = new Set([
  ...EXPLORE_TOOLS,
  "bash",
  "process_start",
  "process_logs",
  "process_stop",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_screenshot",
  "browser_console",
  "preview_url",
  "verify",
]);
const REVIEWER_TOOLS = new Set([...EXPLORE_TOOLS, "bash"]);
const GENERAL_TOOLS = new Set([...EXPLORE_TOOLS, "write_file", "edit", "apply_patch", "bash", "verify", "todo_write", "update_plan"]);
const DOCUMENT_TOOLS = new Set([...GENERAL_TOOLS, "generate_image", "render_document_preview", "skill", "list_skills", "mcp__document_studio__extract_markdown", "mcp__document_studio__convert_document", "mcp__document_studio__render_mermaid"]);
const VALID_ROLES = "explore, tester, reviewer, general, document";

export function normalizeSubagentRole(role: string): SubagentRole {
  const aliases: Record<string, SubagentRole> = {
    explorer: "explore", verifier: "tester", coder: "general", worker: "general",
    doc: "document", publisher: "document", designer: "document",
  };
  const normalized = aliases[role] ?? role;
  if (!["explore", "tester", "reviewer", "general", "document"].includes(normalized)) {
    throw new Error(`Unknown subagent role "${role}". Valid roles: ${VALID_ROLES}.`);
  }
  return normalized as SubagentRole;
}

export function getAllowedToolsForSubagent(
  role: string,
  allTools: RegisteredTool[],
  requestedTools?: string[]
): RegisteredTool[] {
  const norm = normalizeSubagentRole(role);
  const allowSet = norm === "document" ? DOCUMENT_TOOLS : norm === "tester" ? TESTER_TOOLS : norm === "reviewer" ? REVIEWER_TOOLS : norm === "general" ? GENERAL_TOOLS : EXPLORE_TOOLS;
  const reqSet =
    requestedTools && requestedTools.length > 0 ? new Set(requestedTools) : null;

  return allTools.filter((t) => {
    if (t.name === "delegate" || t.name === "ask_user" || t.name === "handoff") return false;
    if (t.masked) return false;
    if (!allowSet.has(t.name)) return false;
    if (reqSet && !reqSet.has(t.name)) return false;
    return true;
  });
}

export interface RunSubagentOptions {
  input: Record<string, unknown>;
  ctx: ToolExecutionContext;
  provider: ProviderAdapter;
  toolRouter: ToolRouter;
  policyGate?: PolicyGate;
  emit?: (tenantId: string, sessionId: string, ev: OpenHarnessEvent) => Promise<void>;
  maxSteps?: number;
  modelRouting?: { glimmerAvailable: boolean; metaApiAvailable: boolean };
}

const writeQueues = new Map<string, Promise<void>>();

export async function runSubagent(opts: RunSubagentOptions): Promise<ToolExecutionResult> {
  const requestedRole = normalizeSubagentRole(String(opts.input.agent ?? opts.input.role ?? "explore"));
  const parentIsReadOnly =
    opts.ctx.state.phase === "planning" ||
    opts.ctx.state.agent === "plan" ||
    opts.ctx.state.agent === "explore" ||
    opts.ctx.state.mode === "ask";
  if (parentIsReadOnly && requestedRole !== "explore") {
    return {
      output: null,
      error: `Cannot delegate to "${requestedRole}" subagent while parent run is in read-only mode/phase ("${opts.ctx.state.mode}" / "${opts.ctx.state.phase}").`,
    };
  }
  const role = requestedRole;
  if (role === "explore" || role === "reviewer") return runSubagentUnlocked(opts, role);
  const key = opts.ctx.workspaceRoot;
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  writeQueues.set(key, tail);
  await previous;
  try {
    return await runSubagentUnlocked(opts, role);
  } finally {
    release();
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  }
}

async function runSubagentUnlocked(opts: RunSubagentOptions, normalizedRole: string): Promise<ToolExecutionResult> {
  const { input, ctx, provider, toolRouter, emit } = opts;
  const role = normalizedRole;
  const prompt = String(input.prompt ?? input.task ?? "");
  const requestedTools = Array.isArray(input.tools) ? input.tools.map(String) : undefined;
  const maxSteps = Math.min(25, Number(opts.maxSteps ?? (input.budget as any)?.maxIterations ?? 25));
  const parentModel = ctx.state.model;
  const canRouteMeta = /^muse-/i.test(parentModel) && !parentModel.startsWith("mock/");
  const isParallelAuditRole = ["explore", "reviewer", "tester"].includes(role);
  let model = canRouteMeta && role === "document" && opts.modelRouting?.metaApiAvailable
    ? "muse-wonder-1.0"
    : canRouteMeta && isParallelAuditRole
      ? opts.modelRouting?.glimmerAvailable
        ? "muse-glimmer"
        : opts.modelRouting?.metaApiAvailable ? "muse-spark-1.3-contributor" : parentModel
      : parentModel;
  const fallbackModel = model === "muse-glimmer" && opts.modelRouting?.metaApiAvailable
    ? "muse-spark-1.3-contributor"
    : parentModel;
  const providerLabel = model === "muse-glimmer" ? "Meta Open-Weights · Modal" : model.startsWith("muse-") ? "Meta Model API" : undefined;
  const childSessionId = `sub_${ctx.runId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const effectivePolicyGate: PolicyGate =
    opts.policyGate ??
    new RiskPolicyGate({
      osEnforcedSandbox: Boolean(ctx.sandboxHandleId),
      defaultConfirmationPolicy: ctx.state.confirmationPolicy ?? "risky",
    });

  const parentMsgId = ctx.state.assistantMessageId ?? `msg-a-${ctx.runId}-${ctx.state.iteration}`;
  const runningPart: DelegatedTaskPart = {
    type: "delegated_task",
    childSessionId,
    role,
    task: prompt,
    status: "running",
    model,
    ...(providerLabel ? { providerLabel } : {}),
    usage: { input: 0, output: 0 },
  };
  if (emit) {
    await emit(ctx.tenantId, ctx.sessionId, {
      type: "part.updated",
      sessionId: ctx.sessionId,
      messageId: parentMsgId,
      part: runningPart,
    });
  }

  const subState = {
    ...ctx.state,
    phase: ctx.state.phase,
    mode: ctx.state.mode,
    agent: role === "document" ? "document" : role === "explore" ? "explore" : ctx.state.agent,
    webTools: role === "tester" || ctx.state.webTools,
  };
  const allTools = toolRouter.listTools(subState);
  const allowedTools = getAllowedToolsForSubagent(role, allTools, requestedTools);
  const allowedMap = new Map(allowedTools.map((t) => [t.name, t]));
  const systemPrompt = ROLE_PROMPTS[role]!;

  const messages: Message[] = [
    {
      info: { id: `${childSessionId}_u0`, role: "user" },
      createdAt: Date.now(),
      parts: [{ type: "text", text: prompt }],
    },
  ];

  let finalReport = "";
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
  try {
    for (let step = 0; step < maxSteps; step++) {
      const isLastStep = step === maxSteps - 1;
      const request = (signal?: AbortSignal) => provider.generateTurn({
        runId: childSessionId,
        sessionId: ctx.sessionId,
        tenantId: ctx.state.tenantId,
        model,
        systemPrompt,
        messages,
        tools: isLastStep
          ? []
          : allowedTools.map((t) => ({
              name: t.name,
              description: t.description ?? "",
              parameters: t.parameters,
            })),
        maxOutputTokens: ctx.state.budgets.maxOutputTokensPerCall,
        signal,
      });
      let turn;
      try {
        const signal = model === "muse-glimmer" && step === 0
          ? (ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000))
          : ctx.signal;
        turn = await request(signal);
      } catch (error) {
        if (step !== 0 || model === fallbackModel) throw error;
        model = fallbackModel;
        turn = await request(ctx.signal);
      }

      if (turn.usage) {
        usage.input += turn.usage.input ?? 0;
        usage.output += turn.usage.output ?? 0;
        usage.reasoning += turn.usage.reasoning ?? 0;
        usage.cacheRead += turn.usage.cacheRead ?? 0;
        ctx.state.usage.input += turn.usage.input ?? 0;
        ctx.state.usage.output += turn.usage.output ?? 0;
        ctx.state.usage.reasoning = (ctx.state.usage.reasoning ?? 0) + (turn.usage.reasoning ?? 0);
        ctx.state.usage.cacheRead = (ctx.state.usage.cacheRead ?? 0) + (turn.usage.cacheRead ?? 0);
        ctx.state.inputTokensThisRun = (ctx.state.inputTokensThisRun ?? 0) + (turn.usage.input ?? 0);
      }

      if (turn.text) {
        finalReport = turn.text;
      }

      if (!turn.toolCalls || turn.toolCalls.length === 0 || isLastStep) {
        break;
      }

      const toolParts: ToolPart[] = [];
      for (let i = 0; i < turn.toolCalls.length; i++) {
        const tc = turn.toolCalls[i]!;
        const callId = tc.id || `${childSessionId}_call_${step}_${i}`;
        const toolDef = allowedMap.get(tc.name);
        const args =
          typeof tc.arguments === "string"
            ? (() => {
                try {
                  return JSON.parse(tc.arguments) as Record<string, unknown>;
                } catch {
                  return {};
                }
              })()
            : (tc.arguments ?? {});

        if (!toolDef || toolDef.masked) {
          toolParts.push({
            type: "tool",
            tool: tc.name,
            callId,
            state: "error",
            input: args,
            error: `Tool "${tc.name}" is not permitted for subagent role "${role}"`,
          });
          continue;
        }

        const decision = await effectivePolicyGate.evaluateToolCall(toolDef, args, ctx.state);
        if (decision.action !== "allow") {
          toolParts.push({
            type: "tool",
            tool: toolDef.name,
            callId,
            state: "denied",
            input: args,
            risk: decision.risk,
            error:
              decision.reason ??
              `Tool "${toolDef.name}" requires confirmation (${decision.action}) under active policy and cannot execute unattended in subagent "${role}".`,
          });
          continue;
        }

        const res = await toolRouter.executeTool(callId, toolDef.name, args, ctx);
        if (res.untrusted) {
          ctx.state.tainted = true;
          const prov = res.provenance ?? `subagent:${role}:${toolDef.name}`;
          if (!ctx.state.taintSources.includes(prov)) {
            ctx.state.taintSources.push(prov);
          }
        }
        toolParts.push({
          type: "tool",
          tool: toolDef.name,
          callId,
          state: res.error ? "error" : "completed",
          input: args,
          output: res.output,
          error: res.error,
        });
      }

      messages.push({
        info: { id: `${childSessionId}_a_${step}`, role: "assistant" },
        createdAt: Date.now(),
        parts: [
          ...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
          ...toolParts,
        ],
      });
    }

    const summary = capSubagentReportTokens(
      finalReport || `Completed ${role} subagent task: ${prompt.slice(0, 120)}`,
      2000
    );
    const donePart: DelegatedTaskPart = {
      type: "delegated_task",
      childSessionId,
      role,
      task: prompt,
      status: "completed",
      model,
      ...(model.startsWith("muse-") ? { providerLabel: model === "muse-glimmer" ? "Meta Open-Weights · Modal" : "Meta Model API" } : {}),
      summary,
      usage,
    };
    if (emit) {
      await emit(ctx.tenantId, ctx.sessionId, {
        type: "part.updated",
        sessionId: ctx.sessionId,
        messageId: parentMsgId,
        part: donePart,
      });
    }
    return {
      output: {
        taskId: childSessionId,
        agent: role,
        status: "completed",
        report: summary,
        usage,
      },
      metadata: { childSessionId, model, ...(model.startsWith("muse-") ? { providerLabel: model === "muse-glimmer" ? "Meta Open-Weights · Modal" : "Meta Model API" } : {}) },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failedPart: DelegatedTaskPart = {
      type: "delegated_task",
      childSessionId,
      role,
      task: prompt,
      status: "failed",
      model,
      ...(model.startsWith("muse-") ? { providerLabel: model === "muse-glimmer" ? "Meta Open-Weights · Modal" : "Meta Model API" } : {}),
      summary: errMsg,
      usage,
    };
    if (emit) {
      await emit(ctx.tenantId, ctx.sessionId, {
        type: "part.updated",
        sessionId: ctx.sessionId,
        messageId: parentMsgId,
        part: failedPart,
      });
    }
    return {
      output: null,
      error: `Subagent (${role}) failed: ${errMsg}`,
      metadata: { childSessionId, model, ...(model.startsWith("muse-") ? { providerLabel: model === "muse-glimmer" ? "Meta Open-Weights · Modal" : "Meta Model API" } : {}) },
    };
  }
}
