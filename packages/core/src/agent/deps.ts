import type {
  CheckpointInfo,
  ConfirmationPolicy,
  FeatureItem,
  Message,
  OpenHarnessEvent,
  PermissionReply,
  PermissionRequest,
  PlanData,
  RiskLevel,
  RunMode,
  RunPhase,
  RunRecord,
  Session,
  TodoItem,
  TokenUsage,
  ToolInfo,
} from "@openharness/sdk";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface BudgetState {
  maxIterations: number;
  maxTaskIterations?: number;
  maxRunDurationSec: number;
  maxOutputTokensPerCall: number;
  maxCostPerRun?: number;
  maxCostPerTask?: number;
  maxCommandSec: number;
  warnedResources: string[];
  extensionsCount: number;
}

export interface InFlightToolCall {
  callId: string;
  tool: string;
  input: unknown;
  idempotent: boolean;
  startedAt: number;
  partialOutput?: string;
}

export interface StepCheckpoint {
  runId: string;
  sessionId: string;
  tenantId: string;
  stepIndex: number;
  state: RunState;
  transcriptCursor: number;
  usage: TokenUsage;
  cost: number;
  pendingApproval: PermissionRequest | null;
  sandboxHandleId: string | null;
  lastCheckpointSha: string | null;
  inFlightToolCalls: InFlightToolCall[];
  completedToolCallIds: string[];
  savedAt: number;
}

export interface VerifyFailureRecord {
  iteration: number;
  signature: string;
  condensedError: string;
  failedCommands: string[];
}

export interface RunState {
  runId: string;
  jobId?: string;
  sessionId: string;
  tenantId: string;
  agent: string;
  model: string;
  runtime?: string;
  mode: RunMode;
  phase: RunPhase;
  iteration: number;
  taskIteration: number;
  transcriptCursor: number;
  budgets: BudgetState;
  usage: TokenUsage;
  cost: number;
  plan: PlanData | null;
  todos: TodoItem[];
  features: FeatureItem[];
  featureId: string | null;
  pendingApproval: PermissionRequest | null;
  lastCheckpoint: string | null;
  sandboxHandleId: string | null;
  sandboxSnapshotId?: string | null;
  inFlightToolCalls: InFlightToolCall[];
  completedToolCalls: Record<string, { output: unknown; error?: string; state: "completed" | "error" | "interrupted" }>;
  verifyFailures: VerifyFailureRecord[];
  malformedCallStreak: number;
  compactionStreak: number;
  stuckWarningsIssued: number;
  tainted: boolean;
  taintSources: string[];
  preTaintAllowedDomains: string[];
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  pauseReason?: string;
  error?: string;
  assistantMessageId?: string;
  unattended?: boolean;
  onConfirm?: "deny" | "pause";
  confirmationPolicy?: ConfirmationPolicy;
}

export interface ProviderToolCall {
  id?: string;
  name: string;
  arguments: string | Record<string, unknown>;
  risk?: RiskLevel;
}

export interface ProviderTurnRequest {
  runId: string;
  sessionId: string;
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    masked?: boolean;
  }>;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderTurnResponse {
  text: string;
  reasoning?: string;
  toolCalls: ProviderToolCall[];
  usage?: TokenUsage;
  cost?: number;
  modelUsed?: string;
  rawTextToolCall?: boolean;
}

export interface ProviderAdapter {
  generateTurn(req: ProviderTurnRequest): Promise<ProviderTurnResponse>;
}

export interface ToolExecutionContext {
  runId: string;
  sessionId: string;
  tenantId: string;
  workspaceRoot: string;
  sandboxHandleId?: string | null;
  signal?: AbortSignal;
  state: RunState;
}

export interface ToolExecutionResult {
  output: unknown;
  error?: string;
  truncated?: boolean;
  spillPath?: string;
  untrusted?: boolean;
  provenance?: string;
  metadata?: Record<string, unknown>;
}

export interface RegisteredTool extends ToolInfo {
  parameters: Record<string, unknown>;
  idempotent?: boolean;
  requiresSandbox?: boolean;
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export interface ToolRouter {
  listTools(state: RunState): RegisteredTool[];
  getTool(name: string): RegisteredTool | undefined;
  executeTool(
    callId: string,
    name: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext
  ): Promise<ToolExecutionResult>;
}

export interface PolicyDecision {
  action: "allow" | "ask" | "deny";
  risk: RiskLevel;
  reason?: string;
  pattern?: string;
}

export interface PolicyGate {
  evaluateToolCall(
    tool: RegisteredTool,
    input: Record<string, unknown>,
    state: RunState
  ): Promise<PolicyDecision>;
  recordPermissionReply(
    request: PermissionRequest,
    reply: PermissionReply
  ): Promise<void>;
}

export interface ContextPrepareResult {
  systemPrompt: string;
  messages: Message[];
  estimatedTokens: number;
  compacted?: boolean;
  hardReset?: boolean;
  recitationText?: string;
  events: OpenHarnessEvent[];
}

export interface ContextManager {
  prepareTurnContext(state: RunState, messages: Message[]): Promise<ContextPrepareResult>;
  handleContextOverflow(state: RunState, messages: Message[], attempt: number): Promise<Message[]>;
}

export interface EventEnvelope {
  seq: number;
  sessionId: string;
  tenantId: string;
  event: OpenHarnessEvent;
  createdAt: number;
}

export interface StateStore {
  getSession(tenantId: string, sessionId: string): Promise<Session | null>;
  saveSession(tenantId: string, session: Session): Promise<void>;
  listSessions(tenantId: string, limit?: number): Promise<Session[]>;
  deleteSession(tenantId: string, sessionId: string): Promise<void>;

  getMessages(tenantId: string, sessionId: string): Promise<{ messages: Message[]; lastSeq: number }>;
  saveMessage(tenantId: string, sessionId: string, message: Message): Promise<void>;
  replaceMessages(tenantId: string, sessionId: string, messages: Message[]): Promise<void>;

  appendEvent(tenantId: string, sessionId: string, event: OpenHarnessEvent): Promise<EventEnvelope>;
  listEventsAfter(tenantId: string, afterSeq: number, sessionId?: string): Promise<EventEnvelope[]>;
  getLastSeq(tenantId: string, sessionId?: string): Promise<number>;

  saveStepCheckpoint(checkpoint: StepCheckpoint): Promise<void>;
  getStepCheckpoint(tenantId: string, runId: string): Promise<StepCheckpoint | null>;

  saveRun(tenantId: string, run: RunRecord): Promise<void>;
  getRun(tenantId: string, runId: string): Promise<RunRecord | null>;

  savePermissionRequest(tenantId: string, req: PermissionRequest): Promise<void>;
  getPermissionRequest(tenantId: string, requestId: string): Promise<PermissionRequest | null>;
  listPermissionRequests(tenantId: string, sessionId?: string): Promise<PermissionRequest[]>;
  resolvePermissionRequest(tenantId: string, requestId: string, reply: PermissionReply): Promise<PermissionRequest | null>;

  saveCheckpointInfo(tenantId: string, sessionId: string, checkpoint: CheckpointInfo): Promise<void>;
  listCheckpoints(tenantId: string, sessionId: string): Promise<CheckpointInfo[]>;
}

export interface EventBus {
  publish(envelope: EventEnvelope): void;
  subscribe(
    filter: { tenantId?: string; sessionId?: string },
    listener: (envelope: EventEnvelope) => void
  ): () => void;
}

export interface EngineDeps {
  clock: Clock;
  stateStore: StateStore;
  eventBus: EventBus;
  provider: ProviderAdapter;
  toolRouter: ToolRouter;
  policyGate: PolicyGate;
  contextManager: ContextManager;
  workspaceRoot: string;
  ensureSandbox?: (state: RunState) => Promise<{ id: string }>;
  onCreateCheckpoint?: (state: RunState, message: string, automatic: boolean) => Promise<CheckpointInfo | null>;
  onRunVerification?: (state: RunState) => Promise<{
    passed: boolean;
    signature: string;
    condensedError: string;
    results: Array<{ name: string; command: string; passed: boolean; exitCode: number; output: string }>;
  }>;
  onRunReviewer?: (state: RunState) => Promise<{ verdict: "pass" | "fail"; issues: string[]; tamperingDetected?: boolean }>;
  onPauseSandbox?: (state: RunState) => Promise<{ snapshotId?: string }>;
  onResumeSandbox?: (state: RunState) => Promise<{ sandboxHandleId: string }>;
}
