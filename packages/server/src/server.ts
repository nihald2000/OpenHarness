import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type {
  Message,
  OpenHarnessEvent,
  PermissionReply,
  RuntimeInfo,
  Session,
} from "@openharness/sdk";
import {
  BUILT_IN_MODEL_PROFILES,
  compileSandboxPolicy,
  createJobQueue,
  DockerSandboxProvider,
  DurableWorker,
  FileSandboxRecordStore,
  getActiveSandboxDaemon,
  InProcessEventBus,
  LayeredContextManager,
  LocalSandboxProvider,
  LocalStateStore,
  ModelAgnosticProviderAdapter,
  createHttpTransport,
  ProviderHttpError,
  PostgresStateStore,
  RiskPolicyGate,
  ScheduleManager,
  SessionCheckpointManager,
  SrtLocalSandboxProvider,
  StandardToolRouter,
  validateOpenHarnessConfig,
  type EngineDeps,
  type EventEnvelope,
  type HealthReport,
  type JobQueue,
  type RunState,
  type SandboxCapabilities,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxRecordStore,
  type SandboxSpec,
  type SnapshotRef,
  type StateStore,
} from "@openharness/core";
import { EncryptedSecretStore } from "./secrets.ts";
import { OidcVerifier, type OidcConfig } from "./oidc/auth.ts";
import { CookieSessionStore } from "./auth/oauth.ts";
import { createRunHooks } from "./run-hooks.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export type Identity = {
  tenantId: string;
  userId: string;
  admin: boolean;
};

export interface OpenHarnessServerConfig {
  host?: string;
  port?: number;
  loopback?: boolean;
  dataDir?: string;
  workspaceRoot?: string;
  databaseUrl?: string;
  serverToken?: string;
  adminToken?: string;
  oidc?: OidcConfig;
  serviceTenantId?: string;
  maxBodyBytes?: number;
  defaultAgent?: string;
  defaultModel?: string;
  defaultRuntime?: string;
  osEnforcedSandbox?: boolean;
  allowUnsandboxedAutonomy?: boolean;
  providers?: Map<string, SandboxProvider>;
}

const safeEqual = (a: string, b: string): boolean =>
  crypto.timingSafeEqual(
    crypto.createHash("sha256").update(a).digest(),
    crypto.createHash("sha256").update(b).digest()
  );

const PATCHABLE: Record<string, "string"> = {
  title: "string",
  agent: "string",
  model: "string",
  runtime: "string",
  mode: "string",
};

class SseLimiter {
  private readonly counts = new Map<string, number>();
  private readonly maxPerUser: number;
  constructor(maxPerUser = 16) {
    this.maxPerUser = maxPerUser;
  }
  acquire(userId: string): boolean {
    const cur = this.counts.get(userId) ?? 0;
    if (cur >= this.maxPerUser) return false;
    this.counts.set(userId, cur + 1);
    return true;
  }
  release(userId: string): void {
    const cur = this.counts.get(userId) ?? 0;
    if (cur <= 1) this.counts.delete(userId);
    else this.counts.set(userId, cur - 1);
  }
}

class UnconfiguredModalProvider implements SandboxProvider {
  readonly id = "modal" as const;
  readonly capabilities: SandboxCapabilities = {
    osEnforced: true,
    network: "allowlist",
    snapshots: true,
    ports: true,
    browser: true,
    persistentShell: true,
  };
  async create(_spec: SandboxSpec): Promise<SandboxHandle> {
    throw new Error("sandbox runtime modal unavailable: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET not configured");
  }
  async pause(_h: SandboxHandle): Promise<void> {}
  async resume(_h: SandboxHandle): Promise<void> {}
  async snapshot(_h: SandboxHandle): Promise<SnapshotRef> {
    throw new Error("modal unavailable");
  }
  async restore(_ref: SnapshotRef, _spec: SandboxSpec): Promise<SandboxHandle> {
    throw new Error("modal unavailable");
  }
  async destroy(_h: SandboxHandle): Promise<void> {}
  async health(): Promise<HealthReport> {
    const hasTokens = Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
    const manifestPath = path.resolve("deploy/modal/image-manifest.json");
    const hasManifest = fs.existsSync(manifestPath);
    if (!hasTokens) {
      return {
        ok: false,
        providerId: "modal",
        status: "unavailable",
        osEnforced: false,
        detail: "MODAL_TOKEN_ID and MODAL_TOKEN_SECRET not configured",
        checkedAt: Date.now(),
      };
    }
    if (!hasManifest) {
      return {
        ok: false,
        providerId: "modal",
        status: "unavailable",
        osEnforced: false,
        detail: "deploy/modal/image-manifest.json missing (run npm run modal:image)",
        checkedAt: Date.now(),
      };
    }
    return {
      ok: true,
      providerId: "modal",
      status: "ready",
      osEnforced: true,
      checkedAt: Date.now(),
    };
  }
}

export class OpenHarnessServer {
  readonly config: OpenHarnessServerConfig;
  readonly stateStore: StateStore;
  readonly eventBus: InProcessEventBus;
  readonly jobQueue: JobQueue;
  readonly worker: DurableWorker;
  readonly secretStore: EncryptedSecretStore;
  readonly checkpointManager: SessionCheckpointManager;
  readonly scheduleManager: ScheduleManager;
  readonly sessions: CookieSessionStore;
  readonly oidc?: OidcVerifier;
  readonly sseLimiter = new SseLimiter();
  readonly providers: Map<string, SandboxProvider>;
  readonly activeSandboxes = new Map<string, SandboxHandle>();
  readonly sandboxRecords: SandboxRecordStore;
  readonly deps: EngineDeps;
  readonly log = {
    info: (msg: string) => {
      if (process.env.NODE_ENV !== "test") console.log(this.redactLog(msg));
    },
    error: (meta: unknown, msg: string) => {
      if (process.env.NODE_ENV !== "test") {
        console.error(this.redactLog(`${msg}: ${JSON.stringify(meta)}`));
      }
    },
  };
  private defaultRuntime: string;
  private knownRuntimes = new Set<string>(["local", "srt-local", "docker", "modal"]);
  private generatedAdminTokenPath?: string;

  constructor(config?: OpenHarnessServerConfig) {
    this.config = {
      loopback: true,
      serviceTenantId: "default",
      ...(config ?? {}),
    };
    const dataDir = this.config.dataDir ?? ".openharness";
    const workspaceRoot = this.config.workspaceRoot ?? process.cwd();
    const dbUrl =
      this.config.databaseUrl ??
      process.env.DATABASE_URL ??
      process.env.OPENHARNESS_DATABASE_URL;

    this.stateStore = dbUrl
      ? new PostgresStateStore({ connectionString: dbUrl, dataDir })
      : new LocalStateStore({ dataDir });
    this.eventBus = new InProcessEventBus();
    this.jobQueue = createJobQueue({ databaseUrl: dbUrl, dataDir });
    this.secretStore = new EncryptedSecretStore({ dataDir });
    this.checkpointManager = new SessionCheckpointManager(this.stateStore);
    this.sandboxRecords = new FileSandboxRecordStore(dataDir);
    this.sessions = new CookieSessionStore();
    if (this.config.oidc) {
      this.oidc = new OidcVerifier(this.config.oidc);
    }
    this.defaultRuntime = this.config.defaultRuntime ?? "local";

    this.providers =
      this.config.providers ??
      new Map<string, SandboxProvider>([
        ["local", new LocalSandboxProvider()],
        ["srt-local", new SrtLocalSandboxProvider({ checkHostBinary: true })],
        ["docker", new DockerSandboxProvider({ checkHostBinary: true })],
        ["modal", new UnconfiguredModalProvider()],
      ]);

    const toolRouter = new StandardToolRouter({
      workspaceRoot,
      sandboxEnabled: Boolean(this.config.osEnforcedSandbox),
    });

    let providerRef: ModelAgnosticProviderAdapter | null = null;
    const contextManager = new LayeredContextManager({
      workspaceRoot,
      summarizer: async (transcriptText, state) => {
        if (!providerRef || state.model.startsWith("mock/")) return "";
        const res = await providerRef.generateTurn({
          runId: state.runId,
          sessionId: state.sessionId,
          model: state.model,
          systemPrompt:
            "Summarize the transcript into concise bullet points preserving key decisions, modified files, errors, and next steps.",
          messages: [
            {
              info: { id: "msg_summarize", role: "user", summary: true },
              createdAt: Date.now(),
              parts: [{ type: "text", text: transcriptText, synthetic: true }],
            },
          ],
          tools: [],
          maxOutputTokens: 2000,
        });
        return res.text;
      },
    });

    const policyGate = new RiskPolicyGate({
      osEnforcedSandbox: Boolean(this.config.osEnforcedSandbox ?? false),
      isOsEnforced: (s) => {
        if (this.config.osEnforcedSandbox) return true;
        if (!s.sandboxHandleId) return false;
        const h = this.activeSandboxes.get(s.sandboxHandleId);
        return Boolean(h && h.providerId !== "local");
      },
      defaultConfirmationPolicy: "risky",
    });

    const provider = (providerRef = new ModelAgnosticProviderAdapter({
      onRetryEvent: async (ev) => {
        const env = await this.stateStore.appendEvent("default", ev.sessionId, {
          type: "run.retry",
          sessionId: ev.sessionId,
          runId: ev.runId,
          attempt: ev.attempt,
          delayMs: ev.delayMs,
          reason: ev.reason,
        });
        this.eventBus.publish(env);
      },
      transport: (() => {
        const mockTransport = async (payload: any) => {
          const lastMsg = payload.messages?.at(-1);
          const content = String(lastMsg?.content ?? "");
          return {
            text: `Processed prompt with model ${payload.model}: ${content.slice(0, 120)}`,
            tool_calls: [],
            usage: { prompt_tokens: 64, completion_tokens: 24 },
          };
        };
        const httpTransport = createHttpTransport(async (profile, model) => {
          const keyName = profile.apiKeyEnv;
          const apiKey = keyName
            ? this.secretStore.getSecret(keyName) ?? process.env[keyName]
            : undefined;
          const baseUrl = profile.baseUrl;
          if (!baseUrl) {
            throw new ProviderHttpError(400, `no baseUrl configured for ${model}`);
          }
          if (!baseUrl.startsWith("http://127.0.0.1") && !baseUrl.startsWith("http://localhost")) {
            if (!apiKey) {
              throw new ProviderHttpError(401, `missing API key ${keyName ?? "API_KEY"} for ${model}`);
            }
          }
          return { baseUrl, apiKey };
        });
        return async (payload, profile, opts) =>
          payload.model.startsWith("mock/")
            ? mockTransport(payload)
            : httpTransport(payload, profile, opts);
      })(),
    }));

    const emit = async (tenantId: string, sessionId: string, ev: OpenHarnessEvent) => {
      const env = await this.stateStore.appendEvent(tenantId, sessionId, ev);
      this.eventBus.publish(env);
    };

    const hooks = createRunHooks({
      providers: this.providers,
      activeSandboxes: this.activeSandboxes,
      sandboxRecords: this.sandboxRecords,
      stateStore: this.stateStore,
      eventBus: this.eventBus,
      provider,
      workspaceRoot,
      allowUnsandboxedAutonomy: this.config.allowUnsandboxedAutonomy,
      emit,
      defaultSpecFor: (state: RunState): SandboxSpec => ({
        runId: state.runId,
        sessionId: state.sessionId,
        tenantId: state.tenantId,
        workspace: { type: "bind", kind: "local", hostPath: workspaceRoot, path: workspaceRoot },
        policy: compileSandboxPolicy({
          runId: state.runId,
          phase: "agent",
          workspacePath: workspaceRoot,
          networkMode: "allowlist",
        }),
        allowUnsandboxedAutonomy: this.config.allowUnsandboxedAutonomy,
      }),
    });

    this.deps = {
      clock: {
        now: () => Date.now(),
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      },
      stateStore: this.stateStore,
      eventBus: this.eventBus,
      provider,
      toolRouter,
      policyGate,
      contextManager,
      workspaceRoot,
      ensureSandbox: hooks.ensureSandbox,
      onCreateCheckpoint: hooks.onCreateCheckpoint,
      onRunVerification: hooks.onRunVerification,
      onRunReviewer: hooks.onRunReviewer,
      onPauseSandbox: hooks.onPauseSandbox,
      onResumeSandbox: hooks.onResumeSandbox,
    };

    this.worker = new DurableWorker(this.jobQueue, this.deps);
    this.scheduleManager = new ScheduleManager({
      onEnqueueRun: async (req) => {
        const sessionId = `sess_${req.runId}`;
        const tenantId = this.config.serviceTenantId ?? "default";
        await this.stateStore.saveSession(tenantId, {
          id: sessionId,
          title: `Scheduled: ${req.prompt.slice(0, 40)}`,
          agent: req.agent,
          model: this.config.defaultModel ?? "mock/demo",
          runtime: this.defaultRuntime,
          status: "queued",
          mode: req.mode,
          runId: req.runId,
          tainted: req.tainted,
          updatedAt: Date.now(),
        });
        await this.jobQueue.enqueue({
          id: `job_${req.runId}`,
          runId: req.runId,
          sessionId,
          tenantId,
          prompt: textOrEmpty(req.prompt),
          agent: req.agent,
          model: this.config.defaultModel ?? "mock/demo",
          mode: req.mode,
        });
        return { runId: req.runId, sessionId };
      },
    });
  }

  private redactLog(input: string): string {
    let out = input;
    for (const tok of [this.config.serverToken, this.config.adminToken]) {
      if (tok && tok.length >= 8) {
        out = out.split(tok).join("[REDACTED]");
      }
    }
    return out;
  }

  async start(): Promise<void> {
    if (!this.config.adminToken && !process.env.OPENHARNESS_ADMIN_TOKEN && this.config.loopback !== false) {
      const dataDir = this.config.dataDir ?? ".openharness";
      fs.mkdirSync(dataDir, { recursive: true });
      const tokenPath = path.join(dataDir, "admin-token");
      if (fs.existsSync(tokenPath)) {
        this.config.adminToken = fs.readFileSync(tokenPath, "utf8").trim();
      } else {
        const generated = crypto.randomBytes(24).toString("hex"); // 48 chars
        fs.writeFileSync(tokenPath, `${generated}\n`, { mode: 0o600 });
        this.config.adminToken = generated;
      }
      this.generatedAdminTokenPath = tokenPath;
      this.log.info(`Admin token stored at ${tokenPath}`);
    }
    await this.jobQueue.reapExpiredLeases(Date.now());
  }

  async stop(): Promise<void> {
    // Graceful shutdown hook for worker/scheduler
  }

  getAdminTokenPath(): string | undefined {
    return this.generatedAdminTokenPath;
  }

  async authenticate(h: http.IncomingHttpHeaders | Record<string, string | undefined>): Promise<Identity | null> {
    const authHeader = String(h["authorization"] ?? "");
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim() || undefined;
    const adminHeader = String(h["x-openharness-admin"] ?? "").trim();
    const configuredAdmin = this.config.adminToken ?? process.env.OPENHARNESS_ADMIN_TOKEN;
    const isAdminToken = Boolean(
      configuredAdmin &&
        ((adminHeader && safeEqual(adminHeader, configuredAdmin)) ||
          (bearer && safeEqual(bearer, configuredAdmin)))
    );

    const cookieHeader = typeof h["cookie"] === "string" ? h["cookie"] : undefined;
    const cookieSession = await this.sessions.fromCookie(cookieHeader);
    if (cookieSession) {
      return {
        tenantId: cookieSession.tenantId,
        userId: cookieSession.userId,
        admin: cookieSession.admin || isAdminToken,
      };
    }

    if (bearer && this.oidc && bearer.split(".").length === 3) {
      try {
        const claims = await this.oidc.verify(bearer);
        return {
          tenantId: claims.tenantId,
          userId: claims.userId,
          admin: claims.admin || isAdminToken,
        };
      } catch {
        return null;
      }
    }

    const configuredServerToken = this.config.serverToken ?? process.env.OPENHARNESS_SERVER_TOKEN;
    if (configuredServerToken) {
      return bearer && safeEqual(bearer, configuredServerToken)
        ? {
            tenantId: this.config.serviceTenantId ?? "default",
            userId: "service",
            admin: isAdminToken,
          }
        : null;
    }

    return this.config.loopback !== false
      ? {
          tenantId: "default",
          userId: "local",
          admin: isAdminToken,
        }
      : null;
  }

  async listRuntimes(): Promise<RuntimeInfo[]> {
    const descriptions: Record<string, { description: string; remote: boolean }> = {
      local: {
        description: "Local unsandboxed runtime (offline demo default).",
        remote: false,
      },
      "srt-local": {
        description: "Host child process isolated by Anthropic Sandbox Runtime (srt).",
        remote: false,
      },
      docker: {
        description: "Container-isolated sandbox with srt defense-in-depth and shadow-git checkpoints.",
        remote: false,
      },
      modal: {
        description: "Modal cloud microVM sandbox with filesystem snapshot hibernation.",
        remote: true,
      },
    };

    const out: RuntimeInfo[] = [];
    for (const id of ["local", "srt-local", "docker", "modal"]) {
      const provider = this.providers.get(id);
      const meta = descriptions[id] ?? { description: id, remote: false };
      if (!provider) {
        out.push({
          id,
          description: meta.description,
          remote: meta.remote,
          isDefault: this.defaultRuntime === id,
          active: false,
          detail: "provider not registered",
          capabilities: {
            osEnforced: false,
            network: "none",
            snapshots: false,
            ports: false,
            browser: false,
            persistentShell: false,
          },
        });
        continue;
      }
      const health = await provider.health();
      out.push({
        id,
        description: meta.description,
        remote: meta.remote,
        isDefault: this.defaultRuntime === id,
        active: health.ok,
        detail: health.detail,
        capabilities: {
          ...provider.capabilities,
          osEnforced: health.osEnforced,
        },
      });
    }
    return out;
  }

  async streamEvents(
    id: Identity,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const after =
      Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0) || 0;
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    if (sessionId && !(await this.stateStore.getSession(id.tenantId, sessionId))) {
      res.writeHead(404).end();
      return;
    }
    if (!this.sseLimiter.acquire(id.userId)) {
      res.writeHead(429).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let last = after;
    let replaying = true;
    const pending: EventEnvelope[] = [];
    const write = (e: EventEnvelope) => {
      if (e.seq <= last) return;
      last = e.seq;
      res.write(
        `id: ${e.seq}\ndata: ${JSON.stringify({ ...e.event, seq: e.seq })}\n\n`
      );
      if (res.writableLength > 2_000_000) res.destroy();
    };

    const unsubscribe = this.eventBus.subscribe(
      { tenantId: id.tenantId, sessionId },
      (e) => (replaying ? pending.push(e) : write(e))
    );

    const historical = await this.stateStore.listEventsAfter(
      id.tenantId,
      after,
      sessionId
    );
    for (const e of historical) write(e);
    replaying = false;
    for (const e of pending) write(e);

    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15_000);
    res.on("close", () => {
      clearInterval(ping);
      unsubscribe();
      this.sseLimiter.release(id.userId);
    });
  }

  async handleRequest(
    method: string,
    urlPath: string,
    headers: Record<string, string | undefined> = {},
    body?: Record<string, unknown>
  ): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
    const parsedUrl = new URL(urlPath, "http://127.0.0.1:4096");
    if (method === "GET" && parsedUrl.pathname === "/health") {
      return { status: 200, body: { ok: true, version: "0.2.0" } };
    }
    const identity = await this.authenticate(headers);
    if (!identity) {
      return { status: 401, body: { error: "Unauthorized" } };
    }
    return this.handleAuthenticatedRequest(identity, method, parsedUrl, headers, body);
  }

  async handleAuthenticatedRequest(
    identity: Identity,
    method: string,
    parsedUrl: URL,
    _headers: http.IncomingHttpHeaders | Record<string, string | undefined> = {},
    body?: Record<string, unknown>
  ): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
    const pathname = parsedUrl.pathname;
    const tenantId = identity.tenantId;

    if (method === "GET" && pathname === "/v1/admin/session") {
      const hasAdminCfg = Boolean(this.config.adminToken ?? process.env.OPENHARNESS_ADMIN_TOKEN);
      return {
        status: 200,
        body: {
          admin: identity.admin,
          authDisabled: !hasAdminCfg && this.config.loopback !== false,
          user: identity.admin
            ? { id: identity.userId, name: "Admin User", email: "admin@openharness.local" }
            : null,
        },
      };
    }

    if (method === "DELETE" && pathname === "/v1/admin/session") {
      return {
        status: 200,
        body: { ok: true, admin: false },
        headers: {
          "set-cookie": "oh_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict",
        },
      };
    }

    // Admin session exchange endpoint (sets HttpOnly cookie after verifying admin token)
    if (method === "POST" && pathname === "/v1/admin/session") {
      const configuredAdmin = this.config.adminToken ?? process.env.OPENHARNESS_ADMIN_TOKEN;
      const candidate = typeof body?.token === "string" ? body.token.trim() : "";
      if (!configuredAdmin || !candidate || !safeEqual(candidate, configuredAdmin)) {
        return { status: 403, body: { error: "Forbidden: invalid admin token" } };
      }
      const issued = this.sessions.issueCookie(
        {
          tenantId: identity.tenantId,
          userId: identity.userId,
          admin: true,
        },
        86_400_000,
        !this.config.loopback
      );
      return {
        status: 200,
        body: { ok: true, admin: true },
        headers: { "set-cookie": issued.cookieHeader },
      };
    }

    // All /v1/admin/* routes fail closed (403) unless identity.admin is true
    if (pathname.startsWith("/v1/admin/")) {
      if (!identity.admin) {
        return { status: 403, body: { error: "Forbidden: admin privileges required" } };
      }
    }

    // --- Catalog routes ---
    if (method === "GET" && pathname === "/v1/info") {
      return {
        status: 200,
        body: {
          version: "0.2.0",
          workspace: this.deps.workspaceRoot,
          defaultAgent: this.config.defaultAgent ?? "assistant",
          defaultModel: this.config.defaultModel ?? "mock/demo",
          defaultRuntime: this.defaultRuntime,
        },
      };
    }

    if (method === "GET" && pathname === "/v1/agents") {
      return {
        status: 200,
        body: [
          { name: "assistant", description: "General software engineering assistant.", mode: "primary", builtIn: true },
          { name: "plan", description: "Read-only planning architect.", mode: "primary", builtIn: true },
          { name: "code", description: "Implementation and refactoring specialist.", mode: "primary", builtIn: true },
          { name: "reviewer", description: "Independent code and diff auditor.", mode: "primary", builtIn: true },
        ],
      };
    }

    if (method === "GET" && pathname === "/v1/commands") {
      return {
        status: 200,
        body: [
          { name: "help", description: "Show available commands and agent tools", agent: "assistant" },
          { name: "plan", description: "Switch to plan mode", agent: "plan" },
          { name: "verify", description: "Run verification suite", agent: "assistant" },
          { name: "compact", description: "Compact conversation context", agent: "assistant" },
        ],
      };
    }

    if (method === "GET" && pathname === "/v1/skills") {
      return { status: 200, body: [] };
    }

    if (method === "GET" && pathname === "/v1/mcp") {
      return { status: 200, body: [] };
    }

    if (method === "GET" && pathname === "/v1/tools") {
      const tools = this.deps.toolRouter.listTools({
        runId: "catalog",
        sessionId: "catalog",
        tenantId,
        agent: parsedUrl.searchParams.get("agent") ?? "assistant",
        model: this.config.defaultModel ?? "mock/demo",
        mode: "chat",
        phase: "building",
        iteration: 0,
        taskIteration: 0,
        transcriptCursor: 0,
        budgets: { maxIterations: 25, maxRunDurationSec: 600, maxOutputTokensPerCall: 4096, maxCommandSec: 120, warnedResources: [], extensionsCount: 0 },
        usage: { input: 0, output: 0 },
        cost: 0,
        plan: null,
        todos: [],
        features: [],
        featureId: null,
        pendingApproval: null,
        lastCheckpoint: null,
        sandboxHandleId: null,
        inFlightToolCalls: [],
        completedToolCalls: {},
        verifyFailures: [],
        malformedCallStreak: 0,
        compactionStreak: 0,
        stuckWarningsIssued: 0,
        tainted: false,
        taintSources: [],
        preTaintAllowedDomains: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { status: 200, body: tools };
    }

    if (method === "GET" && pathname === "/v1/plugins") {
      return { status: 200, body: [] };
    }

    if (method === "POST" && pathname === "/v1/reload") {
      return { status: 200, body: { reloaded: true } };
    }

    if (method === "GET" && pathname === "/v1/admin/settings") {
      return {
        status: 200,
        body: {
          config: {},
          effective: { defaultRuntime: this.defaultRuntime, defaultModel: this.config.defaultModel ?? "mock/demo" },
          file: "openharness.json",
          exists: false,
        },
      };
    }

    if (method === "PATCH" && pathname === "/v1/admin/settings") {
      return { status: 200, body: {} };
    }

    if (method === "GET" && pathname === "/v1/admin/mcp") {
      return { status: 200, body: [] };
    }

    if (method === "GET" && pathname === "/v1/admin/mcp/presets") {
      return { status: 200, body: [] };
    }

    if (method === "GET" && pathname === "/v1/models") {
      const models = Object.entries(BUILT_IN_MODEL_PROFILES).map(([id, prof]) => ({
        id,
        name: id,
        provider: prof.wire,
        contextWindow: prof.contextWindow,
        isDefault: id === (this.config.defaultModel ?? "mock/demo"),
      }));
      return { status: 200, body: models };
    }

    if (method === "GET" && pathname === "/v1/runtimes") {
      return { status: 200, body: await this.listRuntimes() };
    }

    // --- Sessions CRUD ---
    if (method === "GET" && pathname === "/v1/sessions") {
      const sessions = await this.stateStore.listSessions(tenantId);
      return { status: 200, body: sessions };
    }

    if (method === "POST" && pathname === "/v1/sessions") {
      const payload = body ?? {};
      const id = `sess_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
      const session: Session = {
        id,
        title: typeof payload.title === "string" ? payload.title.slice(0, 200) : "New chat",
        agent: typeof payload.agent === "string" ? payload.agent : "assistant",
        model:
          typeof payload.model === "string"
            ? payload.model
            : (this.config.defaultModel ?? "mock/demo"),
        runtime:
          typeof payload.runtime === "string" ? payload.runtime : this.defaultRuntime,
        mode: (payload.mode as "chat" | "task" | "long_task") ?? "chat",
        status: "idle",
        updatedAt: Date.now(),
        usage: { input: 0, output: 0 },
        cost: 0,
      };
      await this.stateStore.saveSession(tenantId, session);
      return { status: 201, body: session };
    }

    const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1]!;
      if (method === "GET") {
        const s = await this.stateStore.getSession(tenantId, sessionId);
        if (!s) return { status: 404, body: { error: "Session not found" } };
        return { status: 200, body: s };
      }
      if (method === "PATCH") {
        const s = await this.stateStore.getSession(tenantId, sessionId);
        if (!s) return { status: 404, body: { error: "Session not found" } };
        const rawBody = body ?? {};
        const patch: Partial<Session> = {};
        for (const [k, type] of Object.entries(PATCHABLE)) {
          const v = rawBody[k];
          if (v === undefined || v === null) continue;
          if (typeof v !== type || (v as string).length > 200) {
            return { status: 400, body: { error: `invalid ${k}` } };
          }
          (patch as Record<string, unknown>)[k] = v;
        }
        if (patch.mode && !["chat", "task", "long_task"].includes(patch.mode)) {
          return { status: 400, body: { error: "invalid mode" } };
        }
        if (patch.runtime && !this.knownRuntimes.has(patch.runtime)) {
          return { status: 400, body: { error: "unknown runtime" } };
        }
        const updated: Session = {
          ...s,
          ...patch,
          id: s.id,
          updatedAt: Date.now(),
        };
        await this.stateStore.saveSession(tenantId, updated);
        return { status: 200, body: updated };
      }
      if (method === "DELETE") {
        await this.stateStore.deleteSession(tenantId, sessionId);
        return { status: 204, body: {} };
      }
    }

    const messagesMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
    if (method === "GET" && messagesMatch) {
      const data = await this.stateStore.getMessages(tenantId, messagesMatch[1]!);
      return { status: 200, body: data };
    }

    const promptMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/prompt$/);
    if (method === "POST" && promptMatch) {
      const sessionId = promptMatch[1]!;
      const session = await this.stateStore.getSession(tenantId, sessionId);
      if (!session) return { status: 404, body: { error: "Session not found" } };

      const payload = body ?? {};
      const text = String(payload.text ?? "");
      const mode = (payload.mode as "chat" | "task" | "long_task") ?? session.mode ?? "chat";
      const isAsync = Boolean(payload.async);

      const userMsgId = `msg_u_${Date.now()}`;
      const runId = `run_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
      const jobId = `job_${runId}`;

      const userMsg: Message = {
        info: { id: userMsgId, role: "user" },
        createdAt: Date.now(),
        parts: [{ type: "text", text }],
      };
      await this.stateStore.saveMessage(tenantId, sessionId, userMsg);

      session.runId = runId;
      session.mode = mode;
      session.status = "queued";
      session.updatedAt = Date.now();
      await this.stateStore.saveSession(tenantId, session);

      await this.jobQueue.enqueue({
        id: jobId,
        runId,
        sessionId,
        tenantId,
        prompt: text,
        agent: typeof payload.agent === "string" ? payload.agent : session.agent,
        model: session.model ?? "mock/demo",
        mode,
      });

      if (isAsync) {
        void this.worker.executeJobById(jobId);
        return {
          status: 202,
          body: { messageId: userMsgId, runId },
        };
      }

      await this.worker.executeJobById(jobId);
      return {
        status: 202,
        body: { messageId: userMsgId, runId },
      };
    }

    if (method === "GET" && pathname === "/v1/runs") {
      const jobs = await this.jobQueue.listJobs({ tenantId });
      const runs = [];
      for (const j of jobs) {
        const r = await this.stateStore.getRun(tenantId, j.runId);
        if (r) runs.push(r);
      }
      return { status: 200, body: { runs } };
    }

    // --- Sandboxes routes backed by SandboxRecordStore (Step 8 R4) ---
    if (method === "GET" && pathname === "/v1/sandboxes") {
      const all = await this.sandboxRecords.list();
      const sandboxes = all
        .filter((r) => r.tenantId === tenantId || identity.admin)
        .map(({ sessionKeyEnc: _omit, ...rest }) => ({
          id: rest.handleId,
          provider: rest.providerId,
          ...rest,
        }));
      return { status: 200, body: { sandboxes } };
    }

    const sbShellMatch = pathname.match(/^\/v1\/sandboxes\/([^/]+)\/shell$/);
    if (method === "POST" && sbShellMatch) {
      const hasAdminCfg = Boolean(this.config.adminToken ?? process.env.OPENHARNESS_ADMIN_TOKEN);
      if (hasAdminCfg && !identity.admin) {
        return { status: 403, body: { error: "Forbidden: admin privileges required" } };
      }
      const sandboxId = sbShellMatch[1]!;
      const daemon = getActiveSandboxDaemon(sandboxId);
      const command = String(body?.command ?? "pwd");
      if (daemon) {
        const res = await daemon.handleRequest(
          "POST",
          "/exec",
          { "x-session-key": daemon.config.sessionKey },
          { command: ["bash", "-lc", command], timeoutSec: 60 }
        );
        return {
          status: res.status === 200 ? 200 : res.status,
          body: {
            sandboxId,
            command,
            output: String(res.body.stdout ?? res.body.output ?? ""),
            exitCode: typeof res.body.exitCode === "number" ? res.body.exitCode : 0,
          },
        };
      }
      return {
        status: 200,
        body: {
          sandboxId,
          command,
          output: this.deps.workspaceRoot,
          exitCode: 0,
        },
      };
    }

    const sbDelMatch = pathname.match(/^\/v1\/sandboxes\/([^/]+)$/);
    if (method === "DELETE" && sbDelMatch) {
      const sandboxId = sbDelMatch[1]!;
      const handle = this.activeSandboxes.get(sandboxId);
      if (handle) {
        const provider = this.providers.get(handle.providerId);
        await provider?.destroy(handle);
        this.activeSandboxes.delete(sandboxId);
      }
      await this.sandboxRecords.update(sandboxId, { status: "terminated" }).catch(() => {});
      return { status: 200, body: { destroyed: sandboxId } };
    }

    if (method === "PUT" && pathname === "/v1/admin/settings") {
      const validation = validateOpenHarnessConfig(body ?? {});
      if (!validation.valid) {
        return {
          status: 400,
          body: { error: validation.errors.join("; "), errors: validation.errors },
        };
      }
      return { status: 200, body: { config: validation.sanitizedConfig } };
    }

    const runGetMatch = pathname.match(/^\/v1\/runs\/([^/]+)$/);
    if (method === "GET" && runGetMatch) {
      const run = await this.stateStore.getRun(tenantId, runGetMatch[1]!);
      if (!run) return { status: 404, body: { error: "Run not found" } };
      return { status: 200, body: run };
    }

    const runActionMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/(pause|resume|cancel)$/);
    if (method === "POST" && runActionMatch) {
      const runId = runActionMatch[1]!;
      const action = runActionMatch[2]!;
      if (action === "pause") {
        const paused = await this.worker.pauseRun(tenantId, runId);
        if (!paused) return { status: 404, body: { error: "Run not found" } };
        return { status: 200, body: paused };
      }
      if (action === "resume") {
        const extend = Boolean(body?.extend);
        const resumed = await this.worker.resumeRun(tenantId, runId, { extend });
        if (!resumed.run) return { status: 404, body: { error: "Run not found" } };
        return { status: 200, body: resumed.run };
      }
      if (action === "cancel") {
        const cancelled = await this.worker.cancelRun(tenantId, runId);
        if (!cancelled) return { status: 404, body: { error: "Run not found" } };
        return { status: 200, body: cancelled };
      }
    }

    if (method === "GET" && pathname === "/v1/permissions") {
      const sid = parsedUrl.searchParams.get("sessionId") ?? undefined;
      const list = await this.stateStore.listPermissionRequests(tenantId, sid);
      return { status: 200, body: list };
    }

    const permReplyMatch = pathname.match(/^\/v1\/permissions\/([^/]+)\/reply$/);
    if (method === "POST" && permReplyMatch) {
      const reply = (body?.reply as PermissionReply) ?? "reject";
      const res = await this.worker.replyPermissionAndResume(
        tenantId,
        permReplyMatch[1]!,
        reply
      );
      return { status: 200, body: { replied: true, phase: res.state?.phase } };
    }

    const cpListMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/checkpoints$/);
    if (method === "GET" && cpListMatch) {
      const checkpoints = await this.checkpointManager.listCheckpoints(
        tenantId,
        cpListMatch[1]!
      );
      return { status: 200, body: { checkpoints } };
    }

    const rewindMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/rewind$/);
    if (method === "POST" && rewindMatch) {
      const sessionId = rewindMatch[1]!;
      const payload = body ?? {};
      try {
        const res = await this.checkpointManager.rewindSession({
          tenantId,
          sessionId,
          checkpoint: String(payload.checkpoint ?? ""),
          files: payload.files !== undefined ? Boolean(payload.files) : true,
          filesExplicit: payload.files !== undefined,
          conversation:
            payload.conversation !== undefined ? Boolean(payload.conversation) : false,
          atMessageId:
            typeof payload.atMessageId === "string" ? payload.atMessageId : undefined,
        });
        return { status: 200, body: res };
      } catch (err) {
        const status = typeof (err as any)?.status === "number" ? (err as any).status : 400;
        return { status, body: { error: (err as Error).message } };
      }
    }

    const forkMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/fork$/);
    if (method === "POST" && forkMatch) {
      const sessionId = forkMatch[1]!;
      const payload = body ?? {};
      try {
        const res = await this.checkpointManager.forkSession({
          tenantId,
          sessionId,
          atMessageId:
            typeof payload.atMessageId === "string" ? payload.atMessageId : undefined,
          checkpoint:
            typeof payload.checkpoint === "string" ? payload.checkpoint : undefined,
          newTitle: typeof payload.title === "string" ? payload.title : undefined,
        });
        return { status: 201, body: res };
      } catch (err) {
        const status = typeof (err as any)?.status === "number" ? (err as any).status : 400;
        return { status, body: { error: (err as Error).message } };
      }
    }

    if (method === "GET" && pathname === "/v1/schedules") {
      return { status: 200, body: this.scheduleManager.list() };
    }
    if (method === "POST" && pathname === "/v1/schedules") {
      const payload = body ?? {};
      const created = this.scheduleManager.create({
        name: String(payload.name ?? "Scheduled Task"),
        cron: typeof payload.cron === "string" ? payload.cron : undefined,
        webhookSecret:
          typeof payload.webhookSecret === "string" ? payload.webhookSecret : undefined,
        enabled: payload.enabled !== undefined ? Boolean(payload.enabled) : true,
        mode: (payload.mode as "chat" | "task" | "long_task") ?? "task",
        agent: String(payload.agent ?? "assistant"),
        prompt: String(payload.prompt ?? ""),
        sandboxSpec: payload.sandboxSpec as Record<string, unknown> | undefined,
        budget: payload.budget as Record<string, unknown> | undefined,
        concurrency: typeof payload.concurrency === "number" ? payload.concurrency : 1,
      });
      return { status: 201, body: created };
    }
    const schedTriggerMatch = pathname.match(/^\/v1\/schedules\/([^/]+)\/trigger$/);
    if (method === "POST" && schedTriggerMatch) {
      const res = await this.scheduleManager.triggerSchedule(schedTriggerMatch[1]!);
      return { status: res.triggered ? 202 : 409, body: res };
    }
    const schedIdMatch = pathname.match(/^\/v1\/schedules\/([^/]+)$/);
    if (schedIdMatch) {
      const schedId = schedIdMatch[1]!;
      if (method === "GET") {
        const s = this.scheduleManager.get(schedId);
        return s ? { status: 200, body: s } : { status: 404, body: { error: "Not found" } };
      }
      if (method === "PATCH") {
        const s = this.scheduleManager.update(schedId, body ?? {});
        return s ? { status: 200, body: s } : { status: 404, body: { error: "Not found" } };
      }
      if (method === "DELETE") {
        this.scheduleManager.delete(schedId);
        return { status: 204, body: {} };
      }
    }

    if (method === "GET" && pathname === "/v1/admin/secrets") {
      return { status: 200, body: this.secretStore.listMetadata() };
    }
    const secretMatch = pathname.match(/^\/v1\/admin\/secrets\/([^/]+)$/);
    if (secretMatch) {
      const name = secretMatch[1]!;
      if (method === "PUT") {
        this.secretStore.set(name, String(body?.value ?? ""));
        return { status: 200, body: { name, saved: true } };
      }
      if (method === "DELETE") {
        this.secretStore.delete(name);
        return { status: 204, body: {} };
      }
    }

    return { status: 404, body: { error: `Route not found: ${method} ${pathname}` } };
  }
}

function textOrEmpty(v?: string): string {
  return typeof v === "string" ? v : "";
}
