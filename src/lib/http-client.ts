import type {
  AgentInfo,
  CheckpointInfo,
  CommandInfo,
  ConnectionStatus,
  ContextUsage,
  McpPreset,
  McpServerAdminInfo,
  McpServerInfo,
  Message,
  ModelInfo,
  OpenHarnessEvent,
  PermissionReply,
  PermissionRequest,
  PluginInfo,
  RunRecord,
  RuntimeInfo,
  ScheduleRecord,
  SecretItem,
  ServerInfo,
  Session,
  SettingsPreviewResponse,
  SkillInfo,
  ToolInfo,
} from "@openharness/sdk";
import { OpenHarnessError } from "@openharness/sdk";

export interface HttpClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  eventSourceFactory?: (url: string) => {
    onopen: (() => void) | null;
    onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null;
    onerror: ((err: unknown) => void) | null;
    close: () => void;
  };
}

export class HttpOpenHarnessClient {
  private readonly base: string;
  private readonly token?: string;
  private readonly fetchFn: typeof fetch;
  private readonly esFactory?: HttpClientOptions["eventSourceFactory"];

  constructor(opts: HttpClientOptions = {}) {
    const envUrl =
      typeof import.meta !== "undefined" && (import.meta as any).env
        ? ((import.meta as any).env.VITE_OPENHARNESS_URL as string | undefined)
        : undefined;
    this.base = (opts.baseUrl ?? envUrl ?? "").replace(/\/$/, "");
    this.token = opts.token;
    this.fetchFn = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.esFactory = opts.eventSourceFactory;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.token) {
      headers["authorization"] = `Bearer ${this.token}`;
    }
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers,
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new OpenHarnessError(err.error ?? `HTTP ${res.status}`, res.status);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  async info(): Promise<ServerInfo> {
    return this.request<ServerInfo>("GET", "/v1/info");
  }

  async agents(): Promise<AgentInfo[]> {
    return this.request<AgentInfo[]>("GET", "/v1/agents");
  }

  async models(): Promise<ModelInfo[]> {
    return this.request<ModelInfo[]>("GET", "/v1/models");
  }

  async commands(): Promise<CommandInfo[]> {
    return this.request<CommandInfo[]>("GET", "/v1/commands");
  }

  async skills(): Promise<SkillInfo[]> {
    return this.request<SkillInfo[]>("GET", "/v1/skills");
  }

  async mcp(): Promise<McpServerInfo[]> {
    return this.request<McpServerInfo[]>("GET", "/v1/mcp");
  }

  async tools(agent?: string): Promise<ToolInfo[]> {
    const q = agent ? `?agent=${encodeURIComponent(agent)}` : "";
    return this.request<ToolInfo[]>("GET", `/v1/tools${q}`);
  }

  async reload(force = false): Promise<{ reloaded: boolean }> {
    return this.request<{ reloaded: boolean }>("POST", "/v1/reload", { force });
  }

  readonly session = {
    list: async (limit = 200): Promise<Session[]> => {
      return this.request<Session[]>("GET", `/v1/sessions?limit=${limit}`);
    },

    create: async (input: {
      title?: string;
      agent?: string;
      model?: string;
      runtime?: string;
      mode?: "chat" | "task" | "long_task";
    }): Promise<Session> => {
      return this.request<Session>("POST", "/v1/sessions", input);
    },

    get: async (id: string): Promise<Session> => {
      return this.request<Session>("GET", `/v1/sessions/${encodeURIComponent(id)}`);
    },

    update: async (
      id: string,
      patch: {
        title?: string;
        agent?: string;
        model?: string;
        runtime?: string | null;
        mode?: "chat" | "task" | "long_task";
      }
    ): Promise<Session> => {
      return this.request<Session>(
        "PATCH",
        `/v1/sessions/${encodeURIComponent(id)}`,
        patch
      );
    },

    delete: async (id: string): Promise<void> => {
      return this.request<void>("DELETE", `/v1/sessions/${encodeURIComponent(id)}`);
    },

    messages: async (id: string): Promise<{ messages: Message[]; lastSeq: number }> => {
      return this.request<{ messages: Message[]; lastSeq: number }>(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/messages`
      );
    },

    prompt: async (
      id: string,
      input: {
        text: string;
        agent?: string;
        mode?: "chat" | "task" | "long_task";
        fix?: { commands: string[] };
      }
    ): Promise<{ messageId: string; runId?: string }> => {
      return this.request<{ messageId: string; runId?: string }>(
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}/prompt`,
        input
      );
    },

    abort: async (id: string): Promise<void> => {
      await this.request<unknown>("POST", `/v1/sessions/${encodeURIComponent(id)}/abort`, {});
    },

    compact: async (id: string): Promise<void> => {
      await this.request<unknown>("POST", `/v1/sessions/${encodeURIComponent(id)}/compact`, {});
    },

    checkpoints: async (id: string): Promise<CheckpointInfo[]> => {
      const res = await this.request<{ checkpoints: CheckpointInfo[] }>(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/checkpoints`
      );
      return res.checkpoints ?? [];
    },

    rewind: async (
      id: string,
      opts: { checkpoint: string; files?: boolean; conversation?: boolean }
    ): Promise<{ restoredFiles: boolean; truncatedConversation: boolean }> => {
      return this.request<{ restoredFiles: boolean; truncatedConversation: boolean }>(
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}/rewind`,
        opts
      );
    },

    fork: async (
      id: string,
      opts?: { atMessageId?: string; checkpoint?: string }
    ): Promise<Session> => {
      const res = await this.request<{ session: Session }>(
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}/fork`,
        opts ?? {}
      );
      return res.session;
    },

    context: async (id: string): Promise<{ contextUsage: ContextUsage }> => {
      return this.request<{ contextUsage: ContextUsage }>(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/context`
      );
    },
  };

  readonly runs = {
    list: async (): Promise<RunRecord[]> => {
      const res = await this.request<{ runs: RunRecord[] }>("GET", "/v1/runs");
      return res.runs ?? [];
    },
    get: async (id: string): Promise<RunRecord> => {
      return this.request<RunRecord>("GET", `/v1/runs/${encodeURIComponent(id)}`);
    },
    pause: async (id: string): Promise<RunRecord> => {
      return this.request<RunRecord>("POST", `/v1/runs/${encodeURIComponent(id)}/pause`, {});
    },
    resume: async (id: string, opts?: { extend?: boolean }): Promise<RunRecord> => {
      return this.request<RunRecord>(
        "POST",
        `/v1/runs/${encodeURIComponent(id)}/resume`,
        opts ?? {}
      );
    },
    cancel: async (id: string): Promise<RunRecord> => {
      return this.request<RunRecord>("POST", `/v1/runs/${encodeURIComponent(id)}/cancel`, {});
    },
  };

  readonly schedules = {
    list: async (): Promise<ScheduleRecord[]> => {
      return this.request<ScheduleRecord[]>("GET", "/v1/schedules");
    },
    create: async (input: Partial<ScheduleRecord>): Promise<ScheduleRecord> => {
      return this.request<ScheduleRecord>("POST", "/v1/schedules", input);
    },
  };

  readonly sandboxes = {
    list: async (): Promise<Array<{ id: string; provider: string; status: string }>> => {
      const res = await this.request<{
        sandboxes: Array<{ id: string; provider: string; status: string }>;
      }>("GET", "/v1/sandboxes");
      return res.sandboxes ?? [];
    },
    shell: async (
      id: string,
      command: string
    ): Promise<{ sandboxId: string; output: string; exitCode: number }> => {
      return this.request<{ sandboxId: string; output: string; exitCode: number }>(
        "POST",
        `/v1/sandboxes/${encodeURIComponent(id)}/shell`,
        { command }
      );
    },
    destroy: async (id: string): Promise<{ destroyed: string }> => {
      return this.request<{ destroyed: string }>(
        "DELETE",
        `/v1/sandboxes/${encodeURIComponent(id)}`
      );
    },
  };

  readonly permissions = {
    list: async (sessionId?: string): Promise<PermissionRequest[]> => {
      const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
      return this.request<PermissionRequest[]>("GET", `/v1/permissions${q}`);
    },
    reply: async (id: string, reply: PermissionReply): Promise<void> => {
      await this.request<unknown>(
        "POST",
        `/v1/permissions/${encodeURIComponent(id)}/reply`,
        { reply }
      );
    },
  };

  readonly plugins = {
    list: async (): Promise<PluginInfo[]> => {
      return this.request<PluginInfo[]>("GET", "/v1/plugins");
    },
    attach: async (input: {
      name: string;
      module?: string;
      options?: Record<string, unknown>;
      persist?: boolean;
      force?: boolean;
    }): Promise<void> => {
      await this.request<unknown>("POST", "/v1/plugins", input);
    },
    detach: async (
      name: string,
      opts?: { persist?: boolean; force?: boolean }
    ): Promise<void> => {
      await this.request<unknown>(
        "DELETE",
        `/v1/plugins/${encodeURIComponent(name)}`,
        opts
      );
    },
  };

  readonly runtimes = {
    list: async (): Promise<RuntimeInfo[]> => {
      return this.request<RuntimeInfo[]>("GET", "/v1/runtimes");
    },
    setDefault: async (id: string, remember?: boolean): Promise<void> => {
      await this.request<unknown>("POST", "/v1/runtimes/default", { id, remember });
    },
  };

  readonly settings = {
    get: async (): Promise<SettingsPreviewResponse> => {
      return this.request<SettingsPreviewResponse>("GET", "/v1/admin/settings");
    },
    update: async (
      section: string,
      value: unknown,
      force?: boolean
    ): Promise<{ extractedSecrets?: string[] }> => {
      return this.request<{ extractedSecrets?: string[] }>(
        "PATCH",
        "/v1/admin/settings",
        { section, value, force }
      );
    },
  };

  readonly secrets = {
    list: async (): Promise<SecretItem[]> => {
      return this.request<SecretItem[]>("GET", "/v1/admin/secrets");
    },
    set: async (name: string, value: string): Promise<void> => {
      await this.request<unknown>(
        "PUT",
        `/v1/admin/secrets/${encodeURIComponent(name)}`,
        { value }
      );
    },
    delete: async (name: string): Promise<void> => {
      await this.request<void>("DELETE", `/v1/admin/secrets/${encodeURIComponent(name)}`);
    },
  };

  readonly mcpServers = {
    list: async (): Promise<McpServerAdminInfo[]> => {
      return this.request<McpServerAdminInfo[]>("GET", "/v1/admin/mcp");
    },
    presets: async (): Promise<McpPreset[]> => {
      return this.request<McpPreset[]>("GET", "/v1/admin/mcp/presets");
    },
    install: async (presetId: string): Promise<void> => {
      await this.request<unknown>(
        "POST",
        `/v1/admin/mcp/presets/${encodeURIComponent(presetId)}`,
        {}
      );
    },
    put: async (name: string, cfg: Record<string, unknown>): Promise<void> => {
      await this.request<unknown>(
        "PUT",
        `/v1/admin/mcp/${encodeURIComponent(name)}`,
        cfg
      );
    },
    enable: async (name: string, enabled: boolean): Promise<void> => {
      await this.request<unknown>(
        "PATCH",
        `/v1/admin/mcp/${encodeURIComponent(name)}`,
        { enabled }
      );
    },
    reconnect: async (name: string): Promise<void> => {
      await this.request<unknown>(
        "POST",
        `/v1/admin/mcp/${encodeURIComponent(name)}/reconnect`,
        {}
      );
    },
    remove: async (name: string): Promise<void> => {
      await this.request<void>("DELETE", `/v1/admin/mcp/${encodeURIComponent(name)}`);
    },
  };

  subscribe(
    sessionId: string | undefined,
    onEvent: (event: OpenHarnessEvent) => void,
    onStatus?: (status: ConnectionStatus) => void,
    onError?: (err: unknown) => void,
    opts?: { after?: number }
  ): { close: () => void } {
    let after = opts?.after ?? 0;
    const q = new URLSearchParams();
    if (sessionId) q.set("sessionId", sessionId);
    if (after) q.set("after", String(after));
    const url = `${this.base}/v1/events?${q.toString()}`;

    onStatus?.("connecting");
    const es = this.esFactory
      ? this.esFactory(url)
      : new EventSource(url, { withCredentials: true });

    es.onopen = () => onStatus?.("open");
    es.onmessage = (m: { data: string; lastEventId?: string }) => {
      const ev = JSON.parse(m.data) as OpenHarnessEvent & { seq?: number };
      const seq = Number(m.lastEventId || ev.seq || 0);
      if (seq && seq <= after) return;
      if (seq) after = seq;
      onEvent(ev);
    };
    es.onerror = (e: unknown) => {
      onStatus?.("reconnecting");
      onError?.(e);
    };
    return {
      close: () => {
        es.close();
        onStatus?.("closed");
      },
    };
  }
}
