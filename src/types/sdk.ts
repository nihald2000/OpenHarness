export type RunStatus =
  | "idle"
  | "queued"
  | "running"
  | "awaiting_permission"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "awaiting_permission",
  "verifying",
] as const;

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export type PermissionReply = "once" | "always" | "reject";

export interface TokenUsage {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
}

export interface Session {
  id: string;
  parentId?: string;
  title: string;
  agent: string;
  model?: string;
  runtime?: string | null;
  status: RunStatus;
  error?: string;
  usage?: TokenUsage;
  cost?: number;
  updatedAt: number | string;
}

export interface TextPart {
  type: "text";
  text: string;
  synthetic?: boolean;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface ToolPart {
  type: "tool";
  tool: string;
  callId: string;
  state: "pending" | "running" | "completed" | "error" | "denied";
  input: unknown;
  output?: unknown;
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  startedAt?: number;
  endedAt?: number;
}

export interface SkillPart {
  type: "skill";
  name: string;
  reason?: "trigger" | "agent" | string;
}

export interface CompactionPart {
  type: "compaction";
  summary: string;
  reason: "tokens" | "messages" | "manual" | "overflow" | string;
  compactedMessages: number;
  tokensBefore?: number;
  tokensAfter?: number;
  keptMessages?: number;
  requirements?: string[];
  decisions?: string[];
  openQuestions?: string[];
}

export interface VerifyPart {
  type: "verify";
  name: string;
  command: string;
  passed: boolean;
  exitCode: number;
  durationMs?: number;
  output?: string;
  iteration: number;
  maxIterations: number;
}

export interface StepPart {
  type: "step";
  usage?: TokenUsage;
  cost?: number;
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | SkillPart
  | CompactionPart
  | VerifyPart
  | StepPart;

export interface MessageInfo {
  id: string;
  role: "user" | "assistant";
  agent?: string;
  model?: string;
  error?: string;
  summary?: boolean;
  usage?: TokenUsage;
  cost?: number;
}

export interface Message {
  info: MessageInfo;
  createdAt: number | string;
  completedAt?: number | string;
  parts: Part[];
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  callId: string;
  permission: string;
  title?: string;
  pattern?: string;
  metadata?: {
    input?: unknown;
    childSessionId?: string;
  };
  createdAt: number | string;
}

export interface ContextUsage {
  sessionId: string;
  estimatedTokens: number;
  contextWindow: number;
  triggerAt?: number;
  messages?: number;
  compactions?: number;
}

export interface ServerInfo {
  version: string;
  workspace?: string;
  defaultAgent?: string;
  defaultModel?: string;
  defaultRuntime?: string;
}

export interface AgentInfo {
  name: string;
  description?: string;
  mode?: "primary" | "subagent" | string;
  color?: string;
  model?: string;
  builtIn?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider?: string;
  contextWindow?: number;
  isDefault?: boolean;
}

export interface CommandInfo {
  name: string;
  description?: string;
  agent?: string;
}

export interface SkillInfo {
  name: string;
  description?: string;
  triggers?: string[];
}

export interface McpServerInfo {
  name: string;
  status: "connected" | "connecting" | "failed" | "disabled" | string;
  readOnly?: boolean;
  toolsCount?: number;
  error?: string;
}

export interface McpServerAdminInfo extends McpServerInfo {
  title?: string;
  transport?: "http" | "sse" | "stdio" | string;
  enabled?: boolean;
  url?: string;
  headers?: Record<string, string>;
  command?: string[];
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  tools?: string[];
}

export interface McpPreset {
  id: string;
  title?: string;
  category?: string;
  description?: string;
  runtimeNote?: string;
  homepage?: string;
  requiredSecrets?: Array<{ name: string; stored?: boolean }>;
}

export interface SkillInfo {
  name: string;
  description?: string;
  triggers?: string[];
  content?: string;
}

export interface ToolInfo {
  name: string;
  description?: string;
  readOnly?: boolean;
  plugin?: string;
  source?: string;
  codeOnly?: boolean;
}

export interface PluginInfo {
  name: string;
  version?: string;
  module?: string;
  status: "attached" | "detached" | "failed" | string;
  configured?: boolean;
  description?: string;
  contributions?: {
    runtimes?: string[];
    providers?: string[];
    tools?: number;
    hooks?: number;
  };
  health?: {
    ok: boolean;
    detail?: string;
  };
  error?: string;
}

export interface RuntimeInfo {
  id: string;
  description?: string;
  remote?: boolean;
  isDefault?: boolean;
  active?: boolean;
  plugin?: string;
}

export interface SettingsPreviewResponse {
  config: Record<string, unknown>;
  effective: Record<string, unknown>;
  file: string;
  exists: boolean;
  fixedConfig?: boolean;
  sources?: string[];
}

export interface SecretItem {
  name: string;
  updatedAt?: number | string;
}

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  detail?: string;
}

export interface PlanData {
  title: string;
  explanation?: string;
  steps: PlanStep[];
}

export interface FixStatusEvent {
  type: "fix.status";
  sessionId: string;
  iteration: number;
  maxIterations: number;
  phase: "verifying" | "fixing" | "succeeded" | "failed" | "stopped";
  reason?: string;
}

export type OpenHarnessEvent =
  | { type: "session.updated"; session: Session }
  | { type: "session.deleted"; sessionId: string }
  | { type: "runtime.reloaded"; at: number }
  | { type: "run.status"; sessionId: string; status: RunStatus; error?: string }
  | FixStatusEvent
  | { type: "verification.started"; sessionId: string; command: string; iteration: number; maxIterations: number }
  | { type: "verification.completed"; sessionId: string; result: { command?: string; passed?: boolean; exitCode?: number | null; timedOut?: boolean; stdout?: string; stderr?: string; truncated?: boolean }; iteration: number; maxIterations: number }
  | { type: "permission.asked"; request: PermissionRequest }
  | { type: "permission.replied"; requestId: string; reply?: PermissionReply }
  | { type: "message.updated"; sessionId: string; message: Message }
  | { type: "part.updated"; sessionId: string; messageId: string; part: Part };

export class OpenHarnessError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenHarnessError";
    this.status = status;
  }
}

export function applyEvent(
  messages: Message[],
  event: OpenHarnessEvent
): Message[] {
  if (event.type === "message.updated") {
    const idx = messages.findIndex((m) => m.info.id === event.message.info.id);
    if (idx === -1) return [...messages, event.message];
    const copy = [...messages];
    copy[idx] = event.message;
    return copy;
  }
  if (event.type === "part.updated") {
    const idx = messages.findIndex((m) => m.info.id === event.messageId);
    if (idx === -1) return messages;
    const msg = messages[idx]!;
    const parts = [...msg.parts];
    const part = event.part;
    if (part.type === "tool") {
      const pIdx = parts.findIndex(
        (p) => p.type === "tool" && p.callId === part.callId
      );
      if (pIdx !== -1) {
        parts[pIdx] = part;
      } else {
        parts.push(part);
      }
    } else {
      parts.push(part);
    }
    const copy = [...messages];
    copy[idx] = { ...msg, parts };
    return copy;
  }
  return messages;
}

export function latestPlan(messages: Message[]): {
  plan: PlanData | null;
  stale: boolean;
} {
  let latest: PlanData | null = null;
  let lastPlanMsgIdx = -1;

  messages.forEach((m, mIdx) => {
    for (const p of m.parts) {
      if (
        p.type === "tool" &&
        (p.tool === "update_plan" ||
          p.tool === "plan" ||
          p.tool === "todowrite" ||
          p.tool === "todo_write")
      ) {
        const metaPlan = p.metadata?.plan as PlanData | undefined;
        if (metaPlan && Array.isArray(metaPlan.steps)) {
          latest = metaPlan;
          lastPlanMsgIdx = mIdx;
        }
      }
    }
  });

  const stale =
    latest !== null &&
    messages
      .slice(lastPlanMsgIdx + 1)
      .some((m) => m.info.role === "user" && !m.info.summary);

  return { plan: latest, stale };
}

export function planProgress(plan: PlanData): {
  completed: number;
  total: number;
  blocked: number;
  done: boolean;
  current: PlanStep | null;
} {
  const total = plan.steps.length;
  let completed = 0;
  let blocked = 0;
  let current: PlanStep | null = null;

  for (const s of plan.steps) {
    if (s.status === "completed") completed += 1;
    else if (s.status === "blocked") blocked += 1;
    else if (!current && s.status === "in_progress") current = s;
  }
  if (!current) {
    current = plan.steps.find((s) => s.status === "pending") ?? null;
  }

  return {
    completed,
    total,
    blocked,
    done: total > 0 && completed === total,
    current,
  };
}
