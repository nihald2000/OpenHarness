import type { DelegatedTaskPart, Message, OpenHarnessEvent, ToolPart } from "@openharness/sdk";
import {
  capSubagentReportTokens,
  type ProviderAdapter,
  type RegisteredTool,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRouter,
} from "@openharness/core";

export type SubagentRole = "explore" | "explorer" | "tester" | "verifier" | "reviewer";

const ROLE_PROMPTS: Record<string, string> = {
  explore:
    "You are an Explore subagent. Use read-only tools (`list`, `glob`, `search`, `read_file`) to investigate the codebase and return a concise, factual summary of findings with exact file paths.",
  tester:
    "You are a Tester subagent. Run tests or inspect the running app in the browser (`bash`, `browser_open`, `browser_console`, `browser_screenshot`) and report what passed or failed.",
  reviewer:
    "You are a Reviewer subagent. Inspect changed files and tests for bugs, regressions, or test tampering, and return a concise review report.",
};

const EXPLORE_TOOLS = new Set(["read_file", "list", "glob", "search", "word_count"]);
const TESTER_TOOLS = new Set([
  ...EXPLORE_TOOLS,
  "bash",
  "process",
  "browser_open",
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

export function getAllowedToolsForSubagent(
  role: string,
  allTools: RegisteredTool[],
  requestedTools?: string[]
): RegisteredTool[] {
  const norm =
    role === "explorer"
      ? "explore"
      : role === "verifier"
      ? "tester"
      : role === "tester" || role === "reviewer"
      ? role
      : "explore";
  const allowSet =
    norm === "tester" ? TESTER_TOOLS : norm === "reviewer" ? REVIEWER_TOOLS : EXPLORE_TOOLS;
  const reqSet =
    requestedTools && requestedTools.length > 0 ? new Set(requestedTools) : null;

  return allTools.filter((t) => {
    if (t.name === "delegate" || t.name === "ask_user" || t.name === "handoff") return false;
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
  emit?: (tenantId: string, sessionId: string, ev: OpenHarnessEvent) => Promise<void>;
  maxSteps?: number;
}

export async function runSubagent(opts: RunSubagentOptions): Promise<ToolExecutionResult> {
  const { input, ctx, provider, toolRouter, emit } = opts;
  const role = String(input.agent ?? input.role ?? "explore");
  const prompt = String(input.prompt ?? input.task ?? "");
  const requestedTools = Array.isArray(input.tools) ? input.tools.map(String) : undefined;
  const maxSteps = Math.min(25, Number(opts.maxSteps ?? (input.budget as any)?.maxIterations ?? 25));
  const childSessionId = `sub_${ctx.runId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const parentMsgId = ctx.state.assistantMessageId ?? `msg-a-${ctx.runId}-${ctx.state.iteration}`;
  const runningPart: DelegatedTaskPart = {
    type: "delegated_task",
    childSessionId,
    role,
    task: prompt,
    status: "running",
  };
  if (emit) {
    await emit(ctx.tenantId, ctx.sessionId, {
      type: "part.updated",
      sessionId: ctx.sessionId,
      messageId: parentMsgId,
      part: runningPart,
    });
  }

  const allTools = toolRouter.listTools({
    ...ctx.state,
    phase: "building",
    mode: "task",
  });
  const allowedTools = getAllowedToolsForSubagent(role, allTools, requestedTools);
  const allowedMap = new Map(allowedTools.map((t) => [t.name, t]));
  const systemPrompt =
    ROLE_PROMPTS[role === "explorer" ? "explore" : role === "verifier" ? "tester" : role] ??
    ROLE_PROMPTS.explore!;

  const messages: Message[] = [
    {
      info: { id: `${childSessionId}_u0`, role: "user" },
      createdAt: Date.now(),
      parts: [{ type: "text", text: prompt }],
    },
  ];

  let finalReport = "";
  try {
    for (let step = 0; step < maxSteps; step++) {
      const isLastStep = step === maxSteps - 1;
      const turn = await provider.generateTurn({
        runId: childSessionId,
        sessionId: ctx.sessionId,
        model: ctx.state.model,
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
        signal: ctx.signal,
      });

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

        if (!toolDef) {
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

        const res = await toolRouter.executeTool(callId, toolDef.name, args, ctx);
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
      summary,
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
      },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failedPart: DelegatedTaskPart = {
      type: "delegated_task",
      childSessionId,
      role,
      task: prompt,
      status: "failed",
      summary: errMsg,
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
    };
  }
}
