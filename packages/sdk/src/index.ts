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
  | { type: "run.status"; sessionId: string; status: RunStatus; error?: string }
  | FixStatusEvent
  | { type: "permission.asked"; request: PermissionRequest }
  | { type: "permission.replied"; requestId: string }
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

export class OpenHarnessClient {
  private readonly baseUrl: string;

  constructor(opts: { baseUrl: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        if (body.error) msg = body.error;
        else if (body.message) msg = body.message;
      } catch {
        // ignore
      }
      throw new OpenHarnessError(msg, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  info(): Promise<ServerInfo> {
    return this.request("/v1/info");
  }

  agents(): Promise<AgentInfo[]> {
    return this.request("/v1/agents");
  }

  models(): Promise<ModelInfo[]> {
    return this.request("/v1/models");
  }

  commands(): Promise<CommandInfo[]> {
    return this.request("/v1/commands");
  }

  skills(): Promise<SkillInfo[]> {
    return this.request("/v1/skills");
  }

  mcp(): Promise<McpServerInfo[]> {
    return this.request("/v1/mcp");
  }

  tools(agent?: string): Promise<ToolInfo[]> {
    const q = agent ? `?agent=${encodeURIComponent(agent)}` : "";
    return this.request(`/v1/tools${q}`);
  }

  reload(force = false): Promise<{ reloaded: boolean }> {
    return this.request("/v1/admin/reload", {
      method: "POST",
      body: JSON.stringify({ force }),
    });
  }

  readonly session = {
    list: (limit = 200): Promise<Session[]> =>
      this.request(`/v1/sessions?limit=${limit}`),
    create: (input: {
      agent?: string;
      model?: string;
      runtime?: string;
    }): Promise<Session> =>
      this.request("/v1/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    get: (id: string): Promise<Session> =>
      this.request(`/v1/sessions/${encodeURIComponent(id)}`),
    update: (
      id: string,
      patch: {
        title?: string;
        agent?: string;
        model?: string;
        runtime?: string | null;
      }
    ): Promise<Session> =>
      this.request(`/v1/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    delete: (id: string): Promise<void> =>
      this.request(`/v1/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    messages: (
      id: string
    ): Promise<{ messages: Message[]; lastSeq: number }> =>
      this.request(`/v1/sessions/${encodeURIComponent(id)}/messages`),
    prompt: (
      id: string,
      input: {
        text: string;
        agent?: string;
        fix?: { commands: string[] };
      }
    ): Promise<{ messageId: string }> =>
      this.request(`/v1/sessions/${encodeURIComponent(id)}/prompt`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    abort: (id: string): Promise<void> =>
      this.request(`/v1/sessions/${encodeURIComponent(id)}/abort`, {
        method: "POST",
      }),
    compact: (id: string): Promise<void> =>
      this.request(`/v1/sessions/${encodeURIComponent(id)}/compact`, {
        method: "POST",
      }),
    context: (id: string): Promise<{ contextUsage: ContextUsage }> =>
      this.request(`/v1/sessions/${encodeURIComponent(id)}/context`),
  };

  readonly permissions = {
    list: (sessionId?: string): Promise<PermissionRequest[]> => {
      const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
      return this.request(`/v1/permissions${q}`);
    },
    reply: (id: string, reply: PermissionReply): Promise<void> =>
      this.request(`/v1/permissions/${encodeURIComponent(id)}/reply`, {
        method: "POST",
        body: JSON.stringify({ reply }),
      }),
  };

  readonly plugins = {
    list: (): Promise<PluginInfo[]> => this.request("/v1/plugins"),
    attach: (input: {
      name: string;
      module?: string;
      options?: Record<string, unknown>;
      persist?: boolean;
      force?: boolean;
    }): Promise<void> =>
      this.request("/v1/plugins", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    detach: (
      name: string,
      opts?: { persist?: boolean; force?: boolean }
    ): Promise<void> =>
      this.request(`/v1/plugins/${encodeURIComponent(name)}`, {
        method: "DELETE",
        body: JSON.stringify(opts ?? {}),
      }),
  };

  readonly runtimes = {
    list: (): Promise<RuntimeInfo[]> => this.request("/v1/runtimes"),
    setDefault: (id: string, persist = true): Promise<void> =>
      this.request("/v1/runtimes/default", {
        method: "PUT",
        body: JSON.stringify({ id, persist }),
      }),
  };

  readonly settings = {
    get: (): Promise<SettingsPreviewResponse> =>
      this.request("/v1/admin/settings"),
    update: (
      section: string,
      value: unknown,
      force = false
    ): Promise<{ extractedSecrets?: string[] }> =>
      this.request(`/v1/admin/settings/${encodeURIComponent(section)}`, {
        method: "PUT",
        body: JSON.stringify({ value, force }),
      }),
  };

  readonly secrets = {
    list: (): Promise<SecretItem[]> => this.request("/v1/admin/secrets"),
    set: (name: string, value: string): Promise<void> =>
      this.request(`/v1/admin/secrets/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      }),
    delete: (name: string): Promise<void> =>
      this.request(`/v1/admin/secrets/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
  };

  readonly mcpServers = {
    list: (): Promise<McpServerAdminInfo[]> => this.request("/v1/admin/mcp"),
    presets: (): Promise<McpPreset[]> =>
      this.request("/v1/admin/mcp/presets"),
    install: (presetId: string): Promise<void> =>
      this.request(
        `/v1/admin/mcp/presets/${encodeURIComponent(presetId)}/install`,
        { method: "POST" }
      ),
    put: (name: string, cfg: Record<string, unknown>): Promise<void> =>
      this.request(`/v1/admin/mcp/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify(cfg),
      }),
    enable: (name: string, enabled: boolean): Promise<void> =>
      this.request(`/v1/admin/mcp/${encodeURIComponent(name)}/enable`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    reconnect: (name: string): Promise<void> =>
      this.request(`/v1/admin/mcp/${encodeURIComponent(name)}/reconnect`, {
        method: "POST",
      }),
    remove: (name: string): Promise<void> =>
      this.request(`/v1/admin/mcp/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
  };

  subscribe(
    sessionId: string | undefined,
    onEvent: (event: OpenHarnessEvent) => void,
    onStatus?: (status: ConnectionStatus) => void,
    onError?: (err: unknown) => void,
    opts?: { after?: number }
  ): { close: () => void } {
    let closed = false;
    let lastSeq = opts?.after;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let openedOnce = false;

    const connect = () => {
      if (closed || typeof EventSource === "undefined") return;
      onStatus?.(openedOnce ? "reconnecting" : "connecting");
      const params = new URLSearchParams();
      if (sessionId) params.set("sessionId", sessionId);
      if (lastSeq !== undefined) params.set("after", String(lastSeq));
      const qs = params.toString();
      const url = `${this.baseUrl}/v1/events${qs ? `?${qs}` : ""}`;

      es = new EventSource(url);
      es.onopen = () => {
        if (closed) return;
        openedOnce = true;
        onStatus?.("open");
      };
      es.onmessage = (msg) => {
        if (closed) return;
        if (msg.lastEventId) {
          const parsedSeq = Number(msg.lastEventId);
          if (Number.isFinite(parsedSeq)) lastSeq = parsedSeq;
        }
        try {
          const parsed = JSON.parse(msg.data) as OpenHarnessEvent & {
            seq?: number;
          };
          if (typeof parsed.seq === "number") lastSeq = parsed.seq;
          onEvent(parsed);
        } catch {
          // ignore malformed event payload
        }
      };
      es.onerror = (err) => {
        if (closed) return;
        es?.close();
        es = null;
        onStatus?.("reconnecting");
        onError?.(err);
        retryTimer = setTimeout(connect, 1500);
      };
    };

    connect();

    return {
      close: () => {
        closed = true;
        if (retryTimer) clearTimeout(retryTimer);
        es?.close();
        onStatus?.("closed");
      },
    };
  }
}
