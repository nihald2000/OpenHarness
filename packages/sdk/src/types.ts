export type RunStatus =
  | "idle"
  | "queued"
  | "running"
  | "awaiting_permission"
  | "awaiting_input"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type RunPhase =
  | "planning"
  | "building"
  | "testing"
  | "fixing"
  | "reviewing"
  | "awaiting_permission"
  | "awaiting_input"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "stuck";

export type RunMode = "chat" | "task" | "long_task" | "ask";

export type RiskLevel = "low" | "medium" | "high" | "unknown";

export type ConfirmationPolicy = "always" | "risky" | "never";

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "awaiting_permission",
  "awaiting_input",
  "verifying",
] as const;

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export type PermissionReply = "once" | "always" | "reject";

export interface TokenUsage {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
  estimated?: boolean;
}

export interface CheckpointInfo {
  sha: string;
  message: string;
  createdAt: number | string;
  sessionId?: string;
  runId?: string;
  featureId?: string;
  step?: number;
  automatic?: boolean;
  paths?: string[];
  files?: string[];
}

export interface FeatureItem {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  verification: string[];
  status: "pending" | "in_progress" | "passing" | "blocked";
  attempts: number;
  lastCheckpoint?: string;
  blockedReason?: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "low" | "medium" | "high";
}

export interface Session {
  id: string;
  parentId?: string;
  title: string;
  agent: string;
  model?: string;
  runtime?: string | null;
  status: RunStatus;
  phase?: RunPhase;
  mode?: RunMode;
  runId?: string;
  activeRunId?: string | null;
  sandboxHandleId?: string;
  lastSeq?: number;
  featureId?: string;
  lastCheckpoint?: string;
  tainted?: boolean;
  sandboxPolicy?: Record<string, unknown>;
  error?: string;
  usage?: TokenUsage;
  cost?: number;
  updatedAt: number | string;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  tenantId?: string;
  mode: RunMode;
  status: RunStatus;
  phase: RunPhase;
  iteration: number;
  maxIterations: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  pauseReason?: string;
  error?: string;
  featureId?: string;
  lastCheckpoint?: string;
  sandboxHandleId?: string;
  usage: TokenUsage;
  cost: number;
}

export interface ScheduleRecord {
  id: string;
  name: string;
  cron?: string;
  webhookSecret?: string;
  enabled: boolean;
  mode: RunMode;
  agent: string;
  prompt: string;
  sandboxSpec?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  concurrency: number;
  lastRunAt?: number;
  nextRunAt?: number;
  activeRunId?: string;
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

export type ToolCallState =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "denied"
  | "interrupted";

export interface ToolPart {
  type: "tool";
  tool: string;
  callId: string;
  state: ToolCallState;
  input?: unknown;
  output?: unknown;
  error?: string;
  risk?: RiskLevel;
  metadata?: {
    childSessionId?: string;
    truncated?: boolean;
    spillPath?: string;
    diagnostics?: string[];
    [key: string]: unknown;
  };
  startedAt?: number | string;
  endedAt?: number | string;
}

export interface SkillPart {
  type: "skill";
  name: string;
  description?: string;
}

export interface CompactionPart {
  type: "compaction";
  strategy?: "microcompact" | "observation_masking" | "summarize" | "hard_reset";
  reason?: string;
  tokensSaved?: number;
  compactedMessages?: number;
  keptMessages?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
  requirements?: string[];
  decisions?: string[];
  openQuestions?: string[];
}

export interface VerifyPart {
  type: "verify";
  command?: string;
  passed?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
}

export interface StepPart {
  type: "step";
  usage?: TokenUsage;
  cost?: number;
}

export interface DelegatedTaskPart {
  type: "delegated_task";
  childSessionId: string;
  role: "explorer" | "coder" | "verifier" | "reviewer" | string;
  task: string;
  status: "running" | "completed" | "failed" | "conflict";
  background?: boolean;
  worktreeBranch?: string;
  summary?: string;
}

export interface PlanPart {
  type: "plan";
  plan: PlanData;
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | SkillPart
  | CompactionPart
  | VerifyPart
  | StepPart
  | DelegatedTaskPart
  | PlanPart;

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
  risk?: RiskLevel;
  metadata?: {
    input?: unknown;
    childSessionId?: string;
    risk?: RiskLevel;
    tainted?: boolean;
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
  content?: string;
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

export interface ToolInfo {
  name: string;
  description?: string;
  readOnly?: boolean;
  plugin?: string;
  source?: string;
  codeOnly?: boolean;
  idempotent?: boolean;
  masked?: boolean;
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
  detail?: string;
  plugin?: string;
  capabilities?: {
    osEnforced: boolean;
    network: "none" | "allowlist" | "open";
    snapshots: boolean;
    ports: boolean;
    browser: boolean;
    persistentShell: boolean;
  };
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
  acceptance?: string[];
  verification?: string[];
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
  | { type: "run.created"; sessionId: string; runId: string; mode?: RunMode; seq?: number }
  | { type: "run.status"; sessionId: string; runId?: string; status: RunStatus; error?: string; seq?: number }
  | { type: "run.phase"; sessionId: string; runId?: string; phase: RunPhase; previousPhase?: RunPhase; featureId?: string; seq?: number }
  | { type: "run.retry"; sessionId: string; runId?: string; attempt: number; delayMs: number; reason: string; seq?: number }
  | { type: "run.stuck"; sessionId: string; runId?: string; detector: string; count: number; message: string; action: "warn" | "blocked" | "paused"; seq?: number }
  | { type: "run.error"; sessionId: string; runId?: string; code?: string; message?: string; recoverable?: boolean; error?: { code: string; message: string; recoverable: boolean }; seq?: number }
  | { type: "run.completed"; sessionId: string; runId: string; changedFiles?: string[]; previewUrl?: string; seq?: number }
  | { type: "plan.updated"; sessionId: string; runId?: string; plan: PlanData; seq?: number }
  | { type: "question.requested"; sessionId: string; runId: string; questionId: string; question: string; options?: string[]; seq?: number }
  | { type: "question.answered"; sessionId: string; runId: string; questionId: string; answer: string; seq?: number }
  | { type: "preview.ready"; sessionId: string; runId?: string; url: string; port?: number; seq?: number }
  | { type: "verification.finished"; sessionId: string; runId?: string; passed: boolean; results: Array<{ name: string; command: string; passed: boolean; exitCode: number; output: string }>; seq?: number }
  | { type: "budget.warning"; sessionId: string; runId?: string; resource: "iterations" | "duration" | "tokens" | "cost"; used: number; limit: number; ratio: number }
  | { type: "checkpoint.created"; sessionId: string; runId?: string; checkpoint: CheckpointInfo }
  | { type: "context.hard_reset"; sessionId: string; runId?: string; attempts: number; tokensBefore: number; tokensAfter: number }
  | { type: "sandbox.status"; sessionId: string; runId?: string; sandboxId: string; provider: string; status: string }
  | { type: "sandbox.violation"; sessionId: string; runId?: string; kind: "fs_read" | "fs_write" | "network" | "mandatory_deny"; target: string; detail?: string; timestamp: number }
  | { type: "sandbox.policy_switched"; sessionId: string; runId?: string; fromPhase: "setup"; toPhase: "agent"; policy: Record<string, unknown> }
  | { type: "process.output"; sessionId: string; processId: string; stream: "stdout" | "stderr"; data: string }
  | { type: "port.opened"; sessionId: string; port: number; previewUrl?: string; processId?: string }
  | FixStatusEvent
  | { type: "verification.started"; sessionId: string; command: string; iteration: number; maxIterations: number }
  | { type: "verification.completed"; sessionId: string; result: { command?: string; passed?: boolean; exitCode?: number | null; timedOut?: boolean; stdout?: string; stderr?: string; truncated?: boolean }; iteration: number; maxIterations: number }
  | { type: "permission.asked"; request: PermissionRequest }
  | { type: "permission.replied"; requestId: string; reply?: PermissionReply }
  | { type: "message.updated"; sessionId: string; message: Message; seq?: number }
  | { type: "part.updated"; sessionId: string; messageId: string; part: Part; seq?: number }
  | { type: "part.delta"; sessionId: string; messageId?: string; delta: string; seq?: number };

export class OpenHarnessError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenHarnessError";
    this.status = status;
  }
}

export interface CreateSessionInput {
  title?: string;
  agent?: string;
  model?: string;
  runtime?: string | null;
  mode?: RunMode;
  sandboxPolicy?: Record<string, unknown>;
}

export interface UpdateSessionInput {
  title?: string;
  agent?: string;
  model?: string;
  runtime?: string | null;
  mode?: RunMode;
}

export interface PromptInput {
  text: string;
  agent?: string;
  mode?: RunMode;
  async?: boolean;
  clientTurnId?: string;
}

export interface PromptResponse {
  message?: Message;
  messageId?: string;
  runId?: string;
}

export interface RewindInput {
  checkpoint: string;
  files?: boolean;
  conversation?: boolean;
  atMessageId?: string;
}

export interface ForkInput {
  atMessageId?: string;
  checkpoint?: string;
  title?: string;
}

export interface OpenHarnessClient {
  info(): Promise<ServerInfo>;
  listAgents(): Promise<AgentInfo[]>;
  listModels(): Promise<ModelInfo[]>;
  listCommands(): Promise<CommandInfo[]>;
  listSkills(): Promise<SkillInfo[]>;
  listMcp(): Promise<McpServerInfo[]>;
  listTools(): Promise<ToolInfo[]>;
  listPlugins(): Promise<PluginInfo[]>;
  listRuntimes(): Promise<RuntimeInfo[]>;
  reloadRuntime(): Promise<void>;

  listSessions(): Promise<Session[]>;
  createSession(input?: CreateSessionInput): Promise<Session>;
  getSession(id: string): Promise<Session>;
  updateSession(id: string, input: UpdateSessionInput): Promise<Session>;
  deleteSession(id: string): Promise<void>;
  getMessages(sessionId: string): Promise<{ messages: Message[]; lastSeq?: number; activeRunId?: string | null }>;
  prompt(sessionId: string, input: PromptInput): Promise<PromptResponse>;
  abort(sessionId: string): Promise<void>;
  answerQuestion?(runId: string, answer: string): Promise<void>;
  retryRun?(runId: string): Promise<PromptResponse>;
  listSessionFiles?(sessionId: string): Promise<{ files: string[] }>;
  getSessionFile?(sessionId: string, path: string): Promise<{ path: string; content: string }>;
  getSessionDiff?(sessionId: string): Promise<{ changed: string[]; diff: string }>;
  getSessionArchiveUrl?(sessionId: string): string;
  contextUsage(sessionId: string): Promise<ContextUsage>;
  summarize(sessionId: string): Promise<void>;
  executeCommand(
    sessionId: string,
    input: { command: string; arguments?: string }
  ): Promise<{ message: Message }>;

  listRuns?(): Promise<RunRecord[]>;
  pauseRun?(runId: string): Promise<void>;
  resumeRun?(runId: string, opts?: { extend?: boolean }): Promise<void>;
  cancelRun?(runId: string): Promise<void>;
  listCheckpoints?(sessionId: string): Promise<CheckpointInfo[]>;
  rewindSession?(sessionId: string, input: RewindInput): Promise<Session>;
  forkSession?(sessionId: string, input: ForkInput): Promise<Session>;
  listSchedules?(): Promise<ScheduleRecord[]>;
  createSchedule?(input: Partial<ScheduleRecord>): Promise<ScheduleRecord>;
  triggerSchedule?(id: string): Promise<void>;

  listPermissions(sessionId?: string): Promise<PermissionRequest[]>;
  replyPermission(id: string, reply: PermissionReply): Promise<void>;

  adminListMcp(): Promise<McpServerAdminInfo[]>;
  adminListMcpPresets(): Promise<McpPreset[]>;
  adminInstallMcpPreset(
    id: string,
    input?: { secrets?: Record<string, string>; enabled?: boolean }
  ): Promise<void>;
  adminSaveMcp(name: string, config: Partial<McpServerAdminInfo>): Promise<void>;
  adminDeleteMcp(name: string): Promise<void>;
  adminReconnectMcp(name: string): Promise<void>;

  adminGetSettings(): Promise<SettingsPreviewResponse>;
  adminSaveSettings(config: Record<string, unknown>): Promise<SettingsPreviewResponse>;

  adminListSecrets(): Promise<SecretItem[]>;
  adminSetSecret(name: string, value: string): Promise<void>;
  adminDeleteSecret(name: string): Promise<void>;

  subscribe(
    onEvent: (event: OpenHarnessEvent) => void,
    options?: {
      sessionId?: string;
      after?: number;
      onStatus?: (status: ConnectionStatus) => void;
      onError?: (error: Error) => void;
    }
  ): () => void;
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
  if (event.type === "part.delta") {
    const targetIdx = event.messageId
      ? messages.findIndex((m) => m.info.id === event.messageId)
      : messages.length - 1;
    if (targetIdx === -1) return messages;
    const msg = messages[targetIdx]!;
    if (msg.info.role !== "assistant") return messages;
    const parts = [...msg.parts];
    const lastPart = parts[parts.length - 1];
    if (lastPart && lastPart.type === "text") {
      parts[parts.length - 1] = { ...lastPart, text: lastPart.text + event.delta };
    } else {
      parts.push({ type: "text", text: event.delta });
    }
    const copy = [...messages];
    copy[targetIdx] = { ...msg, parts };
    return copy;
  }
  return messages;
}

export function latestPlan(messages: Message[]): {
  plan: PlanData | null;
  stale: boolean;
} {
  let latest: PlanData | null;
  latest = null;
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
      } else if (p.type === "plan" && p.plan && Array.isArray(p.plan.steps)) {
        latest = p.plan;
        lastPlanMsgIdx = mIdx;
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
