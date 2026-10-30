import type {
  AgentInfo,
  CheckpointInfo,
  RunRecord,
  ScheduleInfo,
  CommandInfo,
  ConnectionStatus,
  ContextUsage,
  McpPreset,
  McpServerAdminInfo,
  McpServerInfo,
  Message,
  ModelInfo,
  OpenHarnessEvent,
  Part,
  PermissionReply,
  PermissionRequest,
  PlanData,
  PluginInfo,
  RuntimeInfo,
  SecretItem,
  ServerInfo,
  Session,
  SettingsPreviewResponse,
  SkillInfo,
  ToolInfo,
} from "@openharness/sdk";
import { OpenHarnessError } from "@openharness/sdk";

const STORAGE_KEY_SESSIONS = "oh_sessions_v1";
const STORAGE_KEY_MESSAGES = "oh_messages_v1";
const STORAGE_KEY_PERMISSIONS = "oh_permissions_v1";
const STORAGE_KEY_SECRETS = "oh_secrets_v1";
const STORAGE_KEY_SETTINGS = "oh_settings_v1";
const STORAGE_KEY_MCP = "oh_mcp_v1";

const DEFAULT_AGENTS: AgentInfo[] = [
  {
    name: "assistant",
    description: "General software engineering assistant with full workspace tool access.",
    mode: "primary",
    color: "#2b55ff",
    builtIn: true,
  },
  {
    name: "plan",
    description: "Read-only architect that explores the workspace and drafts an execution plan for your approval.",
    mode: "primary",
    color: "#8b55ff",
    builtIn: true,
  },
  {
    name: "code",
    description: "Precision implementation agent focused on code synthesis, refactoring, and test passing.",
    mode: "primary",
    color: "#24d299",
    builtIn: true,
  },
  {
    name: "architect",
    description: "System design, protocol contracts, and scalability blueprinting agent.",
    mode: "primary",
    color: "#e0bf24",
    builtIn: true,
  },
  {
    name: "reviewer",
    description: "Code and security auditor that reviews diffs and verifies security boundaries.",
    mode: "primary",
    color: "#f87272",
    builtIn: true,
  },
  {
    name: "subagent",
    description: "Subagent worker spawned for targeted exploration or background task verification.",
    mode: "subagent",
    color: "#a855f7",
    builtIn: true,
  },
];

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "Google",
    contextWindow: 2000000,
    isDefault: true,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "Google",
    contextWindow: 1000000,
  },
  {
    id: "claude-3-7-sonnet",
    name: "Claude 3.7 Sonnet",
    provider: "Anthropic",
    contextWindow: 200000,
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "OpenAI",
    contextWindow: 128000,
  },
  {
    id: "local-llama",
    name: "Llama 3.3 70B",
    provider: "Ollama / Local",
    contextWindow: 65536,
  },
];

const DEFAULT_COMMANDS: CommandInfo[] = [
  { name: "help", description: "Show available commands and agent tools", agent: "assistant" },
  { name: "plan", description: "Switch to plan mode to draft an execution blueprint", agent: "plan" },
  { name: "verify", description: "Execute test suites and verify workspace integrity", agent: "assistant" },
  { name: "compact", description: "Compact session token window and summarize conversation", agent: "assistant" },
  { name: "clear", description: "Reset chat context and remove previous turns", agent: "assistant" },
];

const DEFAULT_SKILLS: SkillInfo[] = [
  { name: "git-master", description: "Branching strategies, atomic commits, conflict resolution", triggers: ["git", "commit", "branch", "pr", "diff"] },
  { name: "docker-compose", description: "Multi-container orchestration, networking, and env injection", triggers: ["docker", "compose", "container", "volume"] },
  { name: "code-review", description: "TypeScript best practices, modular architecture, anti-patterns", triggers: ["review", "audit", "lint", "style"] },
  { name: "security-audit", description: "Secret hygiene, safe shell execution, and token leakage", triggers: ["security", "secret", "auth", "oauth", "token"] },
  { name: "database-optimizer", description: "Drizzle migrations, query plans, indexing, connection pooling", triggers: ["sql", "postgres", "database", "migration"] },
];

const DEFAULT_MCP_SERVERS: McpServerAdminInfo[] = [
  {
    name: "github",
    title: "GitHub Integration",
    transport: "http",
    status: "connected",
    url: "https://api.githubcopilot.com/mcp",
    toolsCount: 6,
    tools: ["repo_search", "issue_create", "pr_list", "pr_diff", "git_blame", "release_create"],
    enabled: true,
  },
  {
    name: "filesystem",
    title: "Workspace Filesystem",
    transport: "stdio",
    status: "connected",
    command: ["npx", "@modelcontextprotocol/server-filesystem", "."],
    toolsCount: 5,
    tools: ["read_file", "write_file", "edit_file", "list_dir", "file_search"],
    enabled: true,
  },
  {
    name: "playwright",
    title: "Browser Automation",
    transport: "stdio",
    status: "connected",
    command: ["npx", "@modelcontextprotocol/server-playwright"],
    toolsCount: 4,
    tools: ["browser_navigate", "browser_click", "browser_snapshot", "browser_eval"],
    enabled: true,
  },
];

const DEFAULT_MCP_PRESETS: McpPreset[] = [
  {
    id: "github",
    title: "GitHub",
    category: "Developer Tools",
    description: "Search repos, inspect pull requests, and manage issues directly from agent chat.",
    homepage: "https://github.com/modelcontextprotocol",
    requiredSecrets: [{ name: "GITHUB_TOKEN", stored: true }],
  },
  {
    id: "playwright",
    title: "Playwright Browser",
    category: "Testing & Automation",
    description: "Automate browser interactions, capture screenshots, and test web applications.",
    homepage: "https://playwright.dev",
  },
  {
    id: "memory",
    title: "Memory Graph",
    category: "Knowledge",
    description: "Persistent semantic graph store for remembering workspace preferences and project architecture.",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "postgres",
    title: "PostgreSQL Inspector",
    category: "Database",
    description: "Query schema tables, inspect relations, and test SQL migrations.",
    requiredSecrets: [{ name: "DATABASE_URL", stored: false }],
  },
];

const DEFAULT_PLUGINS: PluginInfo[] = [
  {
    name: "python-runtime",
    version: "1.2.0",
    module: "@openharness/plugin-python",
    status: "attached",
    configured: true,
    description: "Python 3.12 sandbox execution bridge with pip dependency isolation.",
    contributions: { runtimes: ["python-sandbox"], tools: 3, hooks: 1 },
    health: { ok: true, detail: "Python 3.12 active" },
  },
  {
    name: "modal-backend",
    version: "0.9.4",
    module: "@openharness/plugin-modal",
    status: "attached",
    configured: true,
    description: "Modal cloud serverless container execution for distributed runs.",
    contributions: { runtimes: ["remote-modal"], providers: ["modal-inference"] },
    health: { ok: true, detail: "Cloud cluster connected" },
  },
  {
    name: "axe-a11y",
    version: "2.0.1",
    module: "@openharness/plugin-axe",
    status: "attached",
    configured: true,
    description: "Automated WCAG accessibility audits during verification loops.",
    contributions: { tools: 2 },
    health: { ok: true },
  },
];

const DEFAULT_RUNTIMES: RuntimeInfo[] = [
  {
    id: "in-process",
    description: "Fast in-process execution environment (Default).",
    remote: false,
    isDefault: true,
    active: true,
  },
  {
    id: "docker-sandbox",
    description: "Isolated Linux container sandbox with network and memory policies.",
    remote: false,
    isDefault: false,
    active: true,
  },
  {
    id: "remote-modal",
    description: "Modal cloud container runtime with GPU access.",
    remote: true,
    isDefault: false,
    active: true,
    plugin: "modal-backend",
  },
];

const DEFAULT_TOOLS: ToolInfo[] = [
  { name: "read_file", description: "Read file contents from workspace.", readOnly: true, source: "built-in" },
  { name: "write_file", description: "Create or overwrite file in workspace.", readOnly: false, source: "built-in" },
  { name: "edit_file", description: "Apply targeted replacements to a file.", readOnly: false, source: "built-in" },
  { name: "list_dir", description: "List files and directories.", readOnly: true, source: "built-in" },
  { name: "grep_search", description: "Search for regex patterns across files.", readOnly: true, source: "built-in" },
  { name: "file_search", description: "Find files matching glob patterns.", readOnly: true, source: "built-in" },
  { name: "bash", description: "Execute shell command in the active runtime.", readOnly: false, source: "built-in" },
  { name: "run_code", description: "Run sandboxed TypeScript in Code Mode.", readOnly: false, source: "built-in" },
  { name: "update_plan", description: "Update the interactive multi-step execution plan.", readOnly: true, source: "built-in" },
  { name: "subagent", description: "Spawn a delegated subagent session for specialized tasks.", readOnly: false, source: "built-in" },
  { name: "web_search", description: "Search documentation and web resources.", readOnly: true, source: "built-in" },
  { name: "inspect_diff", description: "Show git diff of workspace changes.", readOnly: true, source: "built-in" },
];

function getStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function setStored<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

// Initial sample sessions so user immediately sees a working app
function createInitialSessions(): { sessions: Session[]; messages: Record<string, Message[]> } {
  const sess1: Session = {
    id: "sess-architecture-tour",
    title: "Workspace Architecture & Agent Capabilities",
    agent: "assistant",
    model: "gemini-2.5-pro",
    runtime: "in-process",
    status: "completed",
    usage: { input: 1240, output: 860, reasoning: 320, cacheRead: 512 },
    cost: 0.0042,
    updatedAt: Date.now() - 3600_000,
  };

  const msgs1: Message[] = [
    {
      info: { id: "msg-1-u", role: "user" },
      createdAt: Date.now() - 3600_000,
      parts: [
        { type: "text", text: "Give me a tour of this workspace and what OpenHarness can do." }
      ],
    },
    {
      info: { id: "msg-1-a", role: "assistant", agent: "assistant", model: "gemini-2.5-pro" },
      createdAt: Date.now() - 3590_000,
      completedAt: Date.now() - 3585_000,
      parts: [
        {
          type: "reasoning",
          text: "Analyzing repository layout, agent roles, and harness capabilities. Let's inspect the tools, MCP servers, and plan mode features.",
        },
        {
          type: "skill",
          name: "code-review",
          reason: "trigger",
        },
        {
          type: "tool",
          tool: "list_dir",
          callId: "call_inspect_root",
          state: "completed",
          input: { path: "." },
          output: "apps/\npackages/\ndocs/\nPLAN.md\nREADME.md\nopenharness.json",
          title: "List workspace root directory",
          startedAt: Date.now() - 3590_000,
          endedAt: Date.now() - 3589_000,
        },
        {
          type: "text",
          text: `Welcome to **OpenHarness**! OpenHarness is an open, local-first agent harness featuring:

- **Multi-Agent Orchestration**: Switch seamlessly between specialized agents including \`assistant\` (general build & tools), \`plan\` (read-only architectural planning), \`code\` (precision implementation), \`architect\`, and \`reviewer\`.
- **Interactive Plan & Approval Workflow**: The \`plan\` agent drafts structured execution plans with progress tracking, allowing you to review steps, revise instructions, or approve execution.
- **Permission & Security Gates**: Sensitive operations (like command execution and file edits) trigger interactive permission prompts with *Allow once*, *Always*, or *Reject*.
- **Self-Healing Verification Loop**: Run automated test commands with iterative self-repair attempts.
- **Model Context Protocol (MCP)**: Easily connect local or remote MCP servers (GitHub, Playwright, Filesystem, Memory) with one-click catalog presets.
- **Context Compaction**: Monitor token usage with live progress indicators and automatic or manual token compaction.

Feel free to ask questions, explore features, or type \`/help\` to inspect available commands!`,
        },
        {
          type: "step",
          usage: { input: 1240, output: 860 },
          cost: 0.0042,
        },
      ],
    },
  ];

  const sess2: Session = {
    id: "sess-plan-feature",
    title: "Plan User Authentication Feature",
    agent: "plan",
    model: "gemini-2.5-pro",
    runtime: "in-process",
    status: "idle",
    usage: { input: 890, output: 640 },
    cost: 0.0028,
    updatedAt: Date.now() - 7200_000,
  };

  const msgs2: Message[] = [
    {
      info: { id: "msg-2-u", role: "user" },
      createdAt: Date.now() - 7200_000,
      parts: [
        { type: "text", text: "Plan a user greeting and session authentication feature" }
      ],
    },
    {
      info: { id: "msg-2-a", role: "assistant", agent: "plan", model: "gemini-2.5-pro" },
      createdAt: Date.now() - 7190_000,
      completedAt: Date.now() - 7185_000,
      parts: [
        {
          type: "reasoning",
          text: "Plan mode is active. Deconstructing user requirements into modular verification steps. Creating a structured plan with status and details.",
        },
        {
          type: "tool",
          tool: "update_plan",
          callId: "call_plan_auth",
          state: "completed",
          input: {},
          metadata: {
            plan: {
              title: "User Greeting & Session Authentication Architecture",
              explanation: "Structured 5-step implementation plan with security rules, session token validation, and test verification.",
              steps: [
                { id: "1", title: "Review existing session contracts and token storage", status: "completed", detail: "Checked session store and client cookie validation." },
                { id: "2", title: "Implement session greeting hook with user profile display", status: "in_progress", detail: "Adding greeting banner in ChatHeader." },
                { id: "3", title: "Add OAuth callback handler and CSRF state validation", status: "pending", detail: "Verify provider state in authentication redirect." },
                { id: "4", title: "Write unit tests for token expiration and sign-out cleanup", status: "pending", detail: "bun test packages/server/test/auth.test.ts" },
                { id: "5", title: "Verify end-to-end authentication flow and guardrails", status: "pending", detail: "Run automated test suite." },
              ],
            } as PlanData,
          },
        },
        {
          type: "text",
          text: `I've prepared an execution plan for the **User Greeting & Authentication Feature**. 

You can review the steps in the plan card above or in the docking bar at the bottom. When you're ready, click **Approve & build** to switch to the \`assistant\` agent and execute each step automatically!`,
        },
      ],
    },
  ];

  return {
    sessions: [sess1, sess2],
    messages: {
      [sess1.id]: msgs1,
      [sess2.id]: msgs2,
    },
  };
}

type EventListener = (ev: OpenHarnessEvent) => void;
type StatusListener = (st: ConnectionStatus) => void;

class StreamHub {
  private listeners = new Set<{ sessionId?: string; onEvent: EventListener; onStatus?: StatusListener }>();

  subscribe(
    sessionId: string | undefined,
    onEvent: EventListener,
    onStatus?: StatusListener
  ) {
    const entry = { sessionId, onEvent, onStatus };
    this.listeners.add(entry);
    setTimeout(() => {
      onStatus?.("open");
    }, 50);

    return {
      close: () => {
        this.listeners.delete(entry);
        onStatus?.("closed");
      },
    };
  }

  broadcast(event: OpenHarnessEvent) {
    for (const listener of this.listeners) {
      if (!listener.sessionId || ("sessionId" in event && event.sessionId === listener.sessionId)) {
        try {
          listener.onEvent(event);
        } catch {
          // ignore error in listener
        }
      }
    }
  }
}

const hub = new StreamHub();

export class OpenHarnessClient {
  private baseUrl: string;
  private sessions: Session[];
  private messages: Record<string, Message[]>;
  private _permissions: PermissionRequest[];
  private _secrets: SecretItem[];
  private _mcpServers: McpServerAdminInfo[];
  private activeTimeouts = new Map<string, ReturnType<typeof setTimeout>[]>();

  constructor(opts?: { baseUrl?: string }) {
    this.baseUrl = opts?.baseUrl || "/api/oh";

    const initialData = createInitialSessions();
    this.sessions = getStored(STORAGE_KEY_SESSIONS, initialData.sessions);
    this.messages = getStored(STORAGE_KEY_MESSAGES, initialData.messages);
    this._permissions = getStored(STORAGE_KEY_PERMISSIONS, []);
    this._secrets = getStored(STORAGE_KEY_SECRETS, [
      { name: "OPENAI_API_KEY", updatedAt: Date.now() - 86400000 },
      { name: "GITHUB_TOKEN", updatedAt: Date.now() - 43200000 },
      { name: "ANTHROPIC_API_KEY", updatedAt: Date.now() - 172800000 },
    ]);
    this._mcpServers = getStored(STORAGE_KEY_MCP, DEFAULT_MCP_SERVERS);
  }

  private saveSessions() {
    setStored(STORAGE_KEY_SESSIONS, this.sessions);
  }

  private saveMessages() {
    setStored(STORAGE_KEY_MESSAGES, this.messages);
  }

  private savePermissions() {
    setStored(STORAGE_KEY_PERMISSIONS, this._permissions);
  }

  private saveSecrets() {
    setStored(STORAGE_KEY_SECRETS, this._secrets);
  }

  private saveMcpServers() {
    setStored(STORAGE_KEY_MCP, this._mcpServers);
  }

  async info(): Promise<ServerInfo> {
    return {
      version: "0.1.0",
      workspace: "OpenHarness Workspace",
      defaultAgent: "assistant",
      defaultModel: "gemini-2.5-pro",
      defaultRuntime: "in-process",
    };
  }

  async agents(): Promise<AgentInfo[]> {
    return DEFAULT_AGENTS;
  }

  async models(): Promise<ModelInfo[]> {
    return DEFAULT_MODELS;
  }

  async commands(): Promise<CommandInfo[]> {
    return DEFAULT_COMMANDS;
  }

  async skills(): Promise<SkillInfo[]> {
    return DEFAULT_SKILLS;
  }

  async mcp(): Promise<McpServerInfo[]> {
    return this._mcpServers;
  }

  async tools(agent?: string): Promise<ToolInfo[]> {
    if (agent === "plan") {
      return DEFAULT_TOOLS.filter((t) => t.readOnly);
    }
    return DEFAULT_TOOLS;
  }

  async reload(force = false): Promise<{ reloaded: boolean }> {
    return { reloaded: true };
  }

  readonly session = {
    list: async (limit = 200): Promise<Session[]> => {
      return [...this.sessions].sort((a, b) => {
        const ta = typeof a.updatedAt === "number" ? a.updatedAt : new Date(a.updatedAt).getTime();
        const tb = typeof b.updatedAt === "number" ? b.updatedAt : new Date(b.updatedAt).getTime();
        return tb - ta;
      }).slice(0, limit);
    },

    create: async (input: { agent?: string; model?: string; runtime?: string }): Promise<Session> => {
      const newId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const sess: Session = {
        id: newId,
        title: "New chat",
        agent: input.agent || "assistant",
        model: input.model || "gemini-2.5-pro",
        runtime: input.runtime || "in-process",
        status: "idle",
        updatedAt: Date.now(),
        usage: { input: 0, output: 0 },
        cost: 0,
      };
      this.sessions = [sess, ...this.sessions];
      this.messages[newId] = [];
      this.saveSessions();
      this.saveMessages();
      hub.broadcast({ type: "session.updated", session: sess });
      return sess;
    },

    get: async (id: string): Promise<Session> => {
      const sess = this.sessions.find((s) => s.id === id);
      if (!sess) throw new OpenHarnessError("Session not found", 404);
      return sess;
    },

    update: async (
      id: string,
      patch: { title?: string; agent?: string; model?: string; runtime?: string | null }
    ): Promise<Session> => {
      const idx = this.sessions.findIndex((s) => s.id === id);
      if (idx === -1) throw new OpenHarnessError("Session not found", 404);
      const updated: Session = {
        ...this.sessions[idx]!,
        ...patch,
        updatedAt: Date.now(),
      };
      this.sessions[idx] = updated;
      this.saveSessions();
      hub.broadcast({ type: "session.updated", session: updated });
      return updated;
    },

    delete: async (id: string): Promise<void> => {
      this.sessions = this.sessions.filter((s) => s.id !== id);
      delete this.messages[id];
      this._permissions = this._permissions.filter((p) => p.sessionId !== id);
      this.saveSessions();
      this.saveMessages();
      this.savePermissions();
      hub.broadcast({ type: "session.deleted", sessionId: id });
    },

    messages: async (id: string): Promise<{ messages: Message[]; lastSeq: number }> => {
      const list = this.messages[id] || [];
      return { messages: list, lastSeq: list.length };
    },

    prompt: async (
      id: string,
      input: { text: string; agent?: string; fix?: { commands: string[] } }
    ): Promise<{ messageId: string }> => {
      const session = this.sessions.find((s) => s.id === id);
      if (!session) throw new OpenHarnessError("Session not found", 404);

      const userMsgId = `msg-u-${Date.now()}`;
      const assistantMsgId = `msg-a-${Date.now()}`;
      const now = Date.now();

      // Set session title from first prompt if title is generic
      if (!session.title || session.title === "New chat" || session.title === "Untitled") {
        session.title = input.text.slice(0, 50).trim() || "Chat";
      }

      const effectiveAgent = input.agent || session.agent || "assistant";
      session.status = "running";
      session.updatedAt = now;
      this.saveSessions();
      hub.broadcast({ type: "session.updated", session });
      hub.broadcast({ type: "run.status", sessionId: id, status: "running" });

      const userMsg: Message = {
        info: { id: userMsgId, role: "user" },
        createdAt: now,
        parts: [{ type: "text", text: input.text }],
      };

      const assistantMsg: Message = {
        info: { id: assistantMsgId, role: "assistant", agent: effectiveAgent, model: session.model },
        createdAt: now + 50,
        parts: [],
      };

      if (!this.messages[id]) this.messages[id] = [];
      this.messages[id].push(userMsg, assistantMsg);
      this.saveMessages();

      hub.broadcast({ type: "message.updated", sessionId: id, message: userMsg });
      hub.broadcast({ type: "message.updated", sessionId: id, message: assistantMsg });

      // Run reactive simulated agent stream
      this.simulateAgentExecution(id, assistantMsgId, input.text, effectiveAgent, input.fix);

      return { messageId: userMsgId };
    },

    abort: async (id: string): Promise<void> => {
      const timeouts = this.activeTimeouts.get(id) || [];
      for (const t of timeouts) clearTimeout(t);
      this.activeTimeouts.delete(id);

      const session = this.sessions.find((s) => s.id === id);
      if (session) {
        session.status = "cancelled";
        session.updatedAt = Date.now();
        this.saveSessions();
        hub.broadcast({ type: "session.updated", session });
        hub.broadcast({ type: "run.status", sessionId: id, status: "cancelled" });
      }
    },

    compact: async (id: string): Promise<void> => {
      const list = this.messages[id] || [];
      if (list.length < 3) {
        throw new OpenHarnessError("Nothing to compact yet.", 400);
      }

      const compactedCount = Math.max(1, list.length - 2);
      const summaryText = `**Context Compaction Summary**\n- User requested exploration and workflow execution.\n- Agent executed tools and established verification criteria.\n- Preserved latest active state.`;

      const compactionPart: Part = {
        type: "compaction",
        summary: summaryText,
        reason: "manual",
        compactedMessages: compactedCount,
        tokensBefore: 4500,
        tokensAfter: 1200,
        keptMessages: 2,
        decisions: ["Preserve active agent selection", "Maintain verified workspace state"],
      };

      const summaryMsg: Message = {
        info: { id: `msg-summary-${Date.now()}`, role: "assistant", summary: true },
        createdAt: Date.now(),
        parts: [compactionPart],
      };

      const kept = list.slice(-2);
      this.messages[id] = [summaryMsg, ...kept];
      this.saveMessages();

      hub.broadcast({ type: "message.updated", sessionId: id, message: summaryMsg });
      hub.broadcast({
        type: "part.updated",
        sessionId: id,
        messageId: summaryMsg.info.id,
        part: compactionPart,
      });
      hub.broadcast({ type: "run.status", sessionId: id, status: "idle" });
    },


    checkpoints: async (id: string): Promise<CheckpointInfo[]> => {
      return [
        {
          sha: `cp_${id.slice(0, 6)}_step1`,
          message: "Auto-checkpoint before file edit",
          createdAt: Date.now() - 1800_000,
          sessionId: id,
          step: 1,
          automatic: true,
        },
        {
          sha: `cp_${id.slice(0, 6)}_verify`,
          message: "Checkpoint after passing verification",
          createdAt: Date.now() - 600_000,
          sessionId: id,
          step: 2,
          automatic: true,
        },
      ];
    },

    rewind: async (
      id: string,
      opts: { checkpoint: string; files?: boolean; conversation?: boolean }
    ): Promise<{ restoredFiles: boolean; truncatedConversation: boolean }> => {
      const sess = this.sessions.find((s) => s.id === id);
      if (sess) {
        sess.lastCheckpoint = opts.checkpoint;
        sess.updatedAt = Date.now();
        this.saveSessions();
        hub.broadcast({ type: "session.updated", session: sess });
      }
      if (opts.conversation && this.messages[id] && this.messages[id].length > 2) {
        this.messages[id] = this.messages[id].slice(0, 2);
        this.saveMessages();
      }
      return {
        restoredFiles: opts.files ?? true,
        truncatedConversation: Boolean(opts.conversation),
      };
    },

    fork: async (
      id: string,
      opts?: { atMessageId?: string; checkpoint?: string }
    ): Promise<Session> => {
      const parent = this.sessions.find((s) => s.id === id);
      const forked = await this.session.create({
        agent: parent?.agent,
        model: parent?.model,
        runtime: parent?.runtime ?? undefined,
      });
      forked.parentId = id;
      forked.title = `${parent?.title || "Session"} (Fork)`;
      forked.lastCheckpoint = opts?.checkpoint ?? parent?.lastCheckpoint;
      this.messages[forked.id] = [...(this.messages[id] || [])];
      this.saveSessions();
      this.saveMessages();
      hub.broadcast({ type: "session.updated", session: forked });
      return forked;
    },

    context: async (id: string): Promise<{ contextUsage: ContextUsage }> => {
      const list = this.messages[id] || [];
      const estimatedTokens = Math.max(450, list.length * 420);
      return {
        contextUsage: {
          sessionId: id,
          estimatedTokens,
          contextWindow: 128000,
          triggerAt: 0.8,
          messages: list.length,
          compactions: 1,
        },
      };
    },
  };

  private simulateAgentExecution(
    sessionId: string,
    messageId: string,
    prompt: string,
    agent: string,
    fix?: { commands: string[] }
  ) {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const isPlan = agent === "plan" || prompt.startsWith("/plan");
    const isVerify = Boolean(fix?.commands?.length) || prompt.startsWith("/verify");

    // Helper to add event
    const emitPart = (part: Part, delayMs: number) => {
      const t = setTimeout(() => {
        const msgs = this.messages[sessionId];
        const msg = msgs?.find((m) => m.info.id === messageId);
        if (msg) {
          if (part.type === "tool") {
            const idx = msg.parts.findIndex((p) => p.type === "tool" && p.callId === part.callId);
            if (idx !== -1) msg.parts[idx] = part;
            else msg.parts.push(part);
          } else {
            msg.parts.push(part);
          }
          this.saveMessages();
          hub.broadcast({ type: "part.updated", sessionId, messageId, part });
        }
      }, delayMs);
      timers.push(t);
    };

    // Step 1: Reasoning
    emitPart(
      {
        type: "reasoning",
        text: isPlan
          ? `Planning mode: Inspecting prompt "${prompt}". Synthesizing architectural dependencies and drafting a multi-step checklist.`
          : `Processing request with agent "${agent}". Reviewing context and executing required tool steps.`,
      },
      250
    );

    // Step 2: Skill detection or tool call
    if (isPlan) {
      const planSteps = [
        { id: "1", title: `Audit requirements for "${prompt.slice(0, 40)}"`, status: "completed" as const, detail: "Analyzed existing repository patterns." },
        { id: "2", title: "Design component interfaces and data flow", status: "in_progress" as const, detail: "Drafting state machine and UI bounds." },
        { id: "3", title: "Implement modular changes across files", status: "pending" as const, detail: "Write clean TypeScript implementations." },
        { id: "4", title: "Run verification checks and automated tests", status: "pending" as const, detail: "bun test / npm test" },
        { id: "5", title: "Final review and accessibility check", status: "pending" as const, detail: "Verify UI polish and responsiveness." },
      ];

      const planData: PlanData = {
        title: `Plan: ${prompt.slice(0, 50)}`,
        explanation: "Comprehensive step-by-step roadmap ready for approval and execution.",
        steps: planSteps,
      };

      emitPart(
        {
          type: "tool",
          tool: "update_plan",
          callId: `call_plan_${Date.now()}`,
          state: "completed",
          input: { title: planData.title, steps: planSteps },
          metadata: { plan: planData },
          title: "Generate structured execution plan",
          startedAt: Date.now(),
          endedAt: Date.now() + 200,
        },
        700
      );

      emitPart(
        {
          type: "text",
          text: `I've constructed an interactive execution plan for: **${prompt}**.\n\nPlease review the steps in the plan card above or in the docking bar below. Click **Approve & build** to switch to the \`assistant\` agent and begin executing the steps!`,
        },
        1100
      );
    } else {
      // Normal execution with a tool call
      const callId = `call_tool_${Date.now()}`;
      emitPart(
        {
          type: "tool",
          tool: "file_search",
          callId,
          state: "running",
          input: { pattern: "**/*.{ts,tsx,css,json}" },
          title: "Find workspace source files",
          startedAt: Date.now(),
        },
        600
      );

      // Complete tool call
      emitPart(
        {
          type: "tool",
          tool: "file_search",
          callId,
          state: "completed",
          input: { pattern: "**/*.{ts,tsx,css,json}" },
          output: "src/App.tsx\nsrc/components/chat-view.tsx\nsrc/components/sidebar.tsx\nsrc/lib/client.ts",
          title: "Find workspace source files",
          startedAt: Date.now(),
          endedAt: Date.now() + 320,
        },
        1200
      );

      // If verify was requested, run verify check
      if (isVerify) {
        const verifyCmd = fix?.commands?.[0] || "npm test";
        emitPart(
          {
            type: "verify",
            name: "Test Verification",
            command: verifyCmd,
            passed: true,
            exitCode: 0,
            output: "✔ 18 tests passed\n✔ 0 failures\nExecution duration: 240ms",
            durationMs: 240,
            iteration: 1,
            maxIterations: 3,
          },
          1600
        );
      }

      // Final response text
      emitPart(
        {
          type: "text",
          text: `Successfully processed your request:\n\n> *"${prompt}"*\n\nAll tools and validations executed with status \`ok\`. The workspace is synchronized and ready for the next command.`,
        },
        isVerify ? 2000 : 1600
      );
    }

    // Completion timer
    const completeTimer = setTimeout(() => {
      const session = this.sessions.find((s) => s.id === sessionId);
      if (session) {
        session.status = "completed";
        session.updatedAt = Date.now();
        if (session.usage) {
          session.usage.input = (session.usage.input || 0) + 480;
          session.usage.output = (session.usage.output || 0) + 320;
        }
        session.cost = (session.cost || 0) + 0.0018;
        this.saveSessions();
        hub.broadcast({ type: "session.updated", session });
        hub.broadcast({ type: "run.status", sessionId, status: "completed" });
      }

      const msgs = this.messages[sessionId];
      const msg = msgs?.find((m) => m.info.id === messageId);
      if (msg) {
        msg.completedAt = Date.now();
        msg.parts.push({
          type: "step",
          usage: { input: 480, output: 320 },
          cost: 0.0018,
        });
        this.saveMessages();
        hub.broadcast({ type: "message.updated", sessionId, message: msg });
      }

      this.activeTimeouts.delete(sessionId);
    }, isPlan ? 1400 : isVerify ? 2300 : 1900);

    timers.push(completeTimer);
    this.activeTimeouts.set(sessionId, timers);
  }


  readonly runs = {
    list: async (): Promise<RunRecord[]> => [],
    get: async (id: string): Promise<RunRecord> => ({
      id,
      sessionId: "sess-1",
      mode: "task",
      status: "running",
      phase: "building",
      iteration: 1,
      maxIterations: 150,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }),
    pause: async (id: string): Promise<RunRecord> => ({
      id,
      sessionId: "sess-1",
      mode: "task",
      status: "idle",
      phase: "paused",
      iteration: 1,
      maxIterations: 150,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }),
    resume: async (id: string, _opts?: { extend?: boolean }): Promise<RunRecord> => ({
      id,
      sessionId: "sess-1",
      mode: "task",
      status: "running",
      phase: "building",
      iteration: 1,
      maxIterations: 300,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }),
    cancel: async (id: string): Promise<RunRecord> => ({
      id,
      sessionId: "sess-1",
      mode: "task",
      status: "cancelled",
      phase: "cancelled",
      iteration: 1,
      maxIterations: 150,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }),
  };

  readonly schedules = {
    list: async (): Promise<ScheduleInfo[]> => [],
    create: async (input: Partial<ScheduleInfo>): Promise<ScheduleInfo> => ({
      id: `sched_${Date.now()}`,
      name: input.name || "Schedule",
      enabled: true,
      mode: input.mode || "task",
      agent: input.agent || "assistant",
      prompt: input.prompt || "",
      concurrency: input.concurrency || 1,
    }),
  };

  readonly sandboxes = {
    list: async (): Promise<Array<{ id: string; provider: string; status: string }>> => [
      { id: "sb_default", provider: "docker", status: "running" },
    ],
    shell: async (id: string, command: string): Promise<{ sandboxId: string; output: string; exitCode: number }> => ({
      sandboxId: id,
      output: `Executed in ${id}: ${command}`,
      exitCode: 0,
    }),
    destroy: async (id: string): Promise<{ destroyed: string }> => ({ destroyed: id }),
  };

  readonly permissions = {
    list: async (sessionId?: string): Promise<PermissionRequest[]> => {
      if (sessionId) {
        return this._permissions.filter((p) => p.sessionId === sessionId);
      }
      return this._permissions;
    },

    reply: async (id: string, reply: PermissionReply): Promise<void> => {
      this._permissions = this._permissions.filter((p) => p.id !== id);
      this.savePermissions();
      hub.broadcast({ type: "permission.replied", requestId: id, reply });
    },
  };

  readonly plugins = {
    list: async (): Promise<PluginInfo[]> => DEFAULT_PLUGINS,
    attach: async (input: {
      name: string;
      module?: string;
      options?: Record<string, unknown>;
      persist?: boolean;
      force?: boolean;
    }): Promise<void> => {
      const newP: PluginInfo = {
        name: input.name,
        module: input.module,
        status: "attached",
        configured: true,
        description: `Custom attached plugin ${input.name}`,
        health: { ok: true, detail: "Active" },
      };
      DEFAULT_PLUGINS.push(newP);
    },
    detach: async (
      name: string,
      _opts?: { persist?: boolean; force?: boolean }
    ): Promise<void> => {
      const idx = DEFAULT_PLUGINS.findIndex((p) => p.name === name);
      if (idx !== -1) DEFAULT_PLUGINS.splice(idx, 1);
    },
  };

  readonly runtimes = {
    list: async (): Promise<RuntimeInfo[]> => DEFAULT_RUNTIMES,
    setDefault: async (id: string, _remember?: boolean): Promise<void> => {
      for (const r of DEFAULT_RUNTIMES) {
        r.isDefault = r.id === id;
      }
    },
  };

  readonly settings = {
    get: async (): Promise<SettingsPreviewResponse> => {
      const cfg = getStored(STORAGE_KEY_SETTINGS, {
        model: "gemini-2.5-pro",
        defaultAgent: "assistant",
        defaultRuntime: "in-process",
        limits: {
          maxConcurrentRuns: 4,
          maxRunDurationSec: 600,
          maxSessionContextTokens: 128000,
          maxTokensPerTurn: 4096,
          maxToolOutputChars: 50000,
          maxToolDepth: 3,
          maxIterations: 20,
        },
        compaction: {
          enabled: true,
          triggerAt: 0.8,
          maxMessages: 100,
          keepFirst: 2,
          keepLast: 10,
        },
        codeMode: {
          enabled: true,
          timeoutMs: 30000,
          memoryLimitMb: 512,
          maxToolCalls: 20,
          maxOutputChars: 50000,
        },
        guardrails: {
          redactPii: false,
          blockedPatterns: [],
        },
        permissions: {
          "bash": "ask",
          "write_file": "allow",
          "read_file": "allow",
        },
        providers: {
          openai: {
            name: "OpenAI",
            type: "openai",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "{secret:OPENAI_API_KEY}",
            models: {
              "gpt-4o": { name: "GPT-4o", contextWindow: 128000 },
              "gpt-4o-mini": { name: "GPT-4o Mini", contextWindow: 128000 },
            },
          },
        },
      });

      return {
        config: cfg,
        effective: {
          ...cfg,
          server: {
            host: "0.0.0.0",
            port: 3000,
            authRequired: false,
            storage: "local-indexed-store",
          },
        },
        file: "openharness.json",
        exists: true,
      };
    },

    update: async (
      section: string,
      value: unknown,
      _force?: boolean
    ): Promise<{ extractedSecrets?: string[] }> => {
      const current = getStored<Record<string, unknown>>(STORAGE_KEY_SETTINGS, {});
      if (value === null || value === undefined) {
        delete current[section];
      } else {
        current[section] = value;
      }
      setStored(STORAGE_KEY_SETTINGS, current);
      return {};
    },
  };

  readonly secrets = {
    list: async (): Promise<SecretItem[]> => this._secrets,
    set: async (name: string, _value: string): Promise<void> => {
      const idx = this._secrets.findIndex((s) => s.name === name);
      if (idx !== -1) {
        this._secrets[idx] = { name, updatedAt: Date.now() };
      } else {
        this._secrets.push({ name, updatedAt: Date.now() });
      }
      this.saveSecrets();
    },
    delete: async (name: string): Promise<void> => {
      this._secrets = this._secrets.filter((s) => s.name !== name);
      this.saveSecrets();
    },
  };

  readonly mcpServers = {
    list: async (): Promise<McpServerAdminInfo[]> => this._mcpServers,
    presets: async (): Promise<McpPreset[]> => DEFAULT_MCP_PRESETS,
    install: async (presetId: string): Promise<void> => {
      const preset = DEFAULT_MCP_PRESETS.find((p) => p.id === presetId);
      if (!preset) throw new OpenHarnessError("Preset not found", 404);
      const existing = this._mcpServers.find((s) => s.name === presetId);
      if (!existing) {
        this._mcpServers.push({
          name: preset.id,
          title: preset.title || preset.id,
          transport: "stdio",
          status: "connected",
          command: ["npx", `-y`, `@modelcontextprotocol/server-${preset.id}`],
          toolsCount: 4,
          tools: [`${preset.id}_query`, `${preset.id}_inspect`, `${preset.id}_action`],
          enabled: true,
        });
        this.saveMcpServers();
      }
    },
    put: async (name: string, cfg: Record<string, unknown>): Promise<void> => {
      const idx = this._mcpServers.findIndex((s) => s.name === name);
      const item: McpServerAdminInfo = {
        name,
        title: typeof cfg.title === "string" ? cfg.title : name,
        transport: typeof cfg.transport === "string" ? cfg.transport : "http",
        status: "connected",
        enabled: true,
        url: typeof cfg.url === "string" ? cfg.url : undefined,
        command: Array.isArray(cfg.command) ? (cfg.command as string[]) : typeof cfg.command === "string" ? [cfg.command] : undefined,
        args: Array.isArray(cfg.args) ? (cfg.args as string[]) : undefined,
        cwd: typeof cfg.cwd === "string" ? cfg.cwd : undefined,
        headers: typeof cfg.headers === "object" ? (cfg.headers as Record<string, string>) : undefined,
        env: typeof cfg.env === "object" ? (cfg.env as Record<string, string>) : undefined,
        timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : undefined,
        readOnly: Boolean(cfg.readOnly),
        toolsCount: 4,
        tools: [`${name}_read`, `${name}_write`, `${name}_search`],
      };
      if (idx !== -1) {
        this._mcpServers[idx] = item;
      } else {
        this._mcpServers.push(item);
      }
      this.saveMcpServers();
    },
    enable: async (name: string, enabled: boolean): Promise<void> => {
      const srv = this._mcpServers.find((s) => s.name === name);
      if (srv) {
        srv.enabled = enabled;
        srv.status = enabled ? "connected" : "disabled";
        this.saveMcpServers();
      }
    },
    reconnect: async (name: string): Promise<void> => {
      const srv = this._mcpServers.find((s) => s.name === name);
      if (srv) {
        srv.status = "connected";
        this.saveMcpServers();
      }
    },
    remove: async (name: string): Promise<void> => {
      this._mcpServers = this._mcpServers.filter((s) => s.name !== name);
      this.saveMcpServers();
    },
  };

  subscribe(
    sessionId: string | undefined,
    onEvent: (event: OpenHarnessEvent) => void,
    onStatus?: (status: ConnectionStatus) => void,
    onError?: (err: unknown) => void,
    opts?: { after?: number }
  ): { close: () => void } {
    return hub.subscribe(sessionId, onEvent, onStatus);
  }
}

export const demoClient = new OpenHarnessClient();
export { OpenHarnessClient as DemoOpenHarnessClient };
