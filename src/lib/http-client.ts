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
  RunMode,
  RunRecord,
  RuntimeInfo,
  ScheduleRecord,
  SecretItem,
  ServerInfo,
  Session,
  SessionPendingState,
  SettingsPreviewResponse,
  SkillInfo,
  ToolInfo,
} from "@openharness/sdk";
import { OpenHarnessError } from "@openharness/sdk";

export interface HttpClientOptions {
  baseUrl?: string;
  token?: string;
  accessKey?: string;
  fetchImpl?: typeof fetch;
  eventSourceFactory?: (url: string) => {
    onopen: (() => void) | null;
    onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null;
    onerror: ((err: unknown) => void) | null;
    addEventListener?: (type: string, listener: (event: { data?: string }) => void) => void;
    close: () => void;
  };
}

export class HttpOpenHarnessClient {
  private readonly base: string;
  private readonly token?: string;
  private readonly accessKey?: string;
  private readonly fetchFn: typeof fetch;
  private readonly esFactory?: HttpClientOptions["eventSourceFactory"];

  constructor(opts: HttpClientOptions = {}) {
    const envUrl =
      typeof import.meta !== "undefined" && (import.meta as any).env
        ? ((import.meta as any).env.VITE_OPENHARNESS_URL as string | undefined)
        : undefined;
    const browserWindow = (globalThis as typeof globalThis & {
      window?: { localStorage?: { getItem(key: string): string | null } };
    }).window;
    const storedKey =
      browserWindow?.localStorage
        ? browserWindow.localStorage.getItem("oh_access_key") ?? undefined
        : undefined;
    this.base = (opts.baseUrl ?? envUrl ?? "").replace(/\/$/, "");
    this.token = opts.token;
    this.accessKey = opts.accessKey ?? storedKey;
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
    const isBlob = typeof Blob !== "undefined" && body instanceof Blob;
    if (body !== undefined && !isBlob) {
      headers["content-type"] = "application/json";
    } else if (isBlob) {
      headers["content-type"] = (body as Blob).type || "application/octet-stream";
    }
    if (this.token) {
      headers["authorization"] = `Bearer ${this.token}`;
    }
    if (this.accessKey) {
      headers["x-oh-key"] = this.accessKey;
    }
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers,
      credentials: "include",
      body: body === undefined ? undefined : isBlob ? body as Blob : JSON.stringify(body),
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

  async bootstrapGuestSession(): Promise<void> {
    await this.request<{ ok: boolean }>("GET", "/v1/guest/session");
  }

  async agents(): Promise<AgentInfo[]> {
    return this.request<AgentInfo[]>("GET", "/v1/agents");
  }

  async models(): Promise<ModelInfo[]> {
    return this.request<ModelInfo[]>("GET", "/v1/models");
  }

  async modelsWarmup(): Promise<void> {
    await this.request<{ warming: boolean; model: string }>("POST", "/v1/models/warmup", {});
  }

  async transcribeAudio(blob: Blob, filename = "voice-note.webm"): Promise<{ text: string; model: string; provider: string }> {
    const headers: Record<string, string> = {
      "content-type": blob.type || "audio/webm",
      "x-audio-filename": encodeURIComponent(filename),
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.accessKey) headers["x-oh-key"] = this.accessKey;
    const response = await this.fetchFn(`${this.base}/v1/audio/transcribe`, {
      method: "POST", headers, credentials: "include", body: blob,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new OpenHarnessError(payload.error ?? `HTTP ${response.status}`, response.status);
    }
    return await response.json() as { text: string; model: string; provider: string };
  }

  async commands(): Promise<CommandInfo[]> {
    return this.request<CommandInfo[]>("GET", "/v1/commands");
  }

  async skills(): Promise<SkillInfo[]> {
    return this.request<SkillInfo[]>("GET", "/v1/skills");
  }

  async skillsCatalog(): Promise<Array<{ id: string; name: string; category: string; description: string; url: string; repoUrl: string; installed: boolean }>> {
    return this.request("GET", "/v1/skills/catalog");
  }

  async importSkill(input: { id?: string; name?: string; url?: string; content?: string }): Promise<unknown> {
    return this.request("POST", "/v1/skills", input);
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
      mode?: RunMode;
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
        mode?: RunMode;
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

    messages: async (
      id: string
    ): Promise<{ messages: Message[]; lastSeq: number; activeRunId?: string | null }> => {
      return this.request<{ messages: Message[]; lastSeq: number; activeRunId?: string | null }>(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/messages`
      );
    },

    pending: async (id: string): Promise<SessionPendingState> => {
      return this.request<SessionPendingState>(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/pending`
      );
    },

    prompt: async (
      id: string,
      input: {
        text: string;
        agent?: string;
        mode?: RunMode;
        clientTurnId?: string;
        attachments?: string[];
        fix?: { commands: string[] };
        async?: boolean;
      }
    ): Promise<{ messageId: string; runId?: string }> => {
      return this.request<{ messageId: string; runId?: string }>(
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}/prompt`,
        { async: true, ...input }
      );
    },

    uploadAttachment: async (
      id: string,
      input: { file: Blob; path: string; groupId: string }
    ): Promise<{
      id: string;
      groupId: string;
      name: string;
      relativePath: string;
      workspacePath: string;
      mimeType: string;
      size: number;
    }> => {
      const query = new URLSearchParams({
        group: input.groupId,
        path: input.path,
        type: input.file.type || "application/octet-stream",
      });
      const res = await this.request<{
        attachment: {
          id: string;
          groupId: string;
          name: string;
          relativePath: string;
          workspacePath: string;
          mimeType: string;
          size: number;
        };
      }>(
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}/attachments?${query}`,
        input.file
      );
      return res.attachment;
    },

    deleteAttachment: async (id: string, attachmentId: string): Promise<void> => {
      await this.request<void>(
        "DELETE",
        `/v1/sessions/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`
      );
    },

    abort: async (id: string): Promise<void> => {
      await this.request<unknown>("POST", `/v1/sessions/${encodeURIComponent(id)}/abort`, {});
    },

    compact: async (id: string): Promise<void> => {
      await this.request<unknown>("POST", `/v1/sessions/${encodeURIComponent(id)}/compact`, {});
    },

    files: async (id: string): Promise<{ files: string[] }> => {
      return this.request<{ files: string[] }>(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/files`
      );
    },

    file: async (id: string, path: string): Promise<{ path: string; content: string }> => {
      return this.request<{ path: string; content: string }>(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`
      );
    },

    inspectFile: async (id: string, filePath: string, signal?: AbortSignal): Promise<Record<string, unknown>> => {
      return this.request<Record<string, unknown>>(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/file/inspect?path=${encodeURIComponent(filePath)}`,
        undefined,
        signal
      );
    },

    fileRawUrl: (id: string, filePath: string, opts?: { download?: boolean }): string => {
      const q = new URLSearchParams({ path: filePath });
      if (opts?.download) q.set("download", "1");
      if (this.accessKey) q.set("key", this.accessKey);
      return `${this.base}/v1/sessions/${encodeURIComponent(id)}/file/raw?${q.toString()}`;
    },

    attachmentRawUrl: (id: string, attachmentId: string): string => {
      const q = new URLSearchParams();
      if (this.accessKey) q.set("key", this.accessKey);
      return `${this.base}/v1/sessions/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/raw${q.size ? `?${q}` : ""}`;
    },

    diff: async (id: string): Promise<{ changed: string[]; diff: string }> => {
      return this.request<{ changed: string[]; diff: string }>(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/diff`
      );
    },

    archive: async (id: string): Promise<{ archiveBase64: string; filename: string }> => {
      return this.request<{ archiveBase64: string; filename: string }>(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/archive`
      );
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
    resume: async (id: string, opts?: { extend?: boolean }): Promise<RunRecord & { queued?: boolean; message?: string }> => {
      return this.request<RunRecord & { queued?: boolean; message?: string }>(
        "POST",
        `/v1/runs/${encodeURIComponent(id)}/resume`,
        opts ?? {}
      );
    },
    cancel: async (id: string): Promise<RunRecord> => {
      return this.request<RunRecord>("POST", `/v1/runs/${encodeURIComponent(id)}/cancel`, {});
    },
    answer: async (id: string, answer: string): Promise<RunRecord & { queued?: boolean; message?: string }> => {
      return this.request<RunRecord & { queued?: boolean; message?: string }>(
        "POST",
        `/v1/runs/${encodeURIComponent(id)}/answer`,
        { answer }
      );
    },
    retry: async (id: string): Promise<{ runId: string; run: RunRecord }> => {
      return this.request<{ runId: string; run: RunRecord }>(
        "POST",
        `/v1/runs/${encodeURIComponent(id)}/retry`,
        {}
      );
    },
    takeover: async (id: string, input: { reason?: string; instructions?: string } = {}): Promise<{ takeoverRequested: boolean; runId: string }> => {
      return this.request("POST", `/v1/runs/${encodeURIComponent(id)}/takeover`, input);
    },
    returnBrowserControl: async (id: string, note = ""): Promise<{ returned: boolean; queued?: boolean }> => {
      return this.request("POST", `/v1/runs/${encodeURIComponent(id)}/takeover/return`, { note });
    },
  };

  readonly browser = {
    liveTicket: async (sessionId: string, mode: "view" | "control"): Promise<{ url: string }> => {
      return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/browser/live-ticket`, { mode });
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
    if (this.accessKey) q.set("key", this.accessKey);
    const url = `${this.base}/v1/events?${q.toString()}`;

    let reconnectingTimer: ReturnType<typeof setTimeout> | undefined;
    let plannedRotate = false;
    const clearReconnectTimer = () => {
      if (reconnectingTimer) clearTimeout(reconnectingTimer);
      reconnectingTimer = undefined;
    };
    const markConnected = () => {
      clearReconnectTimer();
      plannedRotate = false;
      onStatus?.("open");
    };
    onStatus?.("connecting");
    const es = this.esFactory
      ? this.esFactory(url)
      : new EventSource(url, { withCredentials: true });

    es.onopen = markConnected;
    es.addEventListener?.("ready", markConnected);
    es.addEventListener?.("ping", markConnected);
    es.addEventListener?.("rotate", () => {
      plannedRotate = true;
    });
    es.onmessage = (m: { data: string; lastEventId?: string }) => {
      const ev = JSON.parse(m.data) as OpenHarnessEvent & { seq?: number };
      const seq = Number(m.lastEventId || ev.seq || 0);
      // Token deltas are ephemeral and share the current durable event sequence.
      if (seq && seq <= after && ev.type !== "part.delta") return;
      if (seq) after = seq;
      onEvent(ev);
    };
    es.onerror = (e: unknown) => {
      clearReconnectTimer();
      reconnectingTimer = setTimeout(() => onStatus?.("reconnecting"), plannedRotate ? 4_500 : 3_500);
      onError?.(e);
    };
    return {
      close: () => {
        clearReconnectTimer();
        es.close();
        onStatus?.("closed");
      },
    };
  }
}
