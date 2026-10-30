import crypto from "node:crypto";
import http from "node:http";
import type {
  CheckpointInfo,
  Message,
  PermissionReply,
  RuntimeInfo,
  Session,
} from "@openharness/sdk";
import {
  BUILT_IN_MODEL_PROFILES,
  createJobQueue,
  DurableWorker,
  InProcessEventBus,
  LayeredContextManager,
  LocalStateStore,
  ModelAgnosticProviderAdapter,
  PostgresStateStore,
  RiskPolicyGate,
  ScheduleManager,
  SessionCheckpointManager,
  StandardToolRouter,
  validateOpenHarnessConfig,
} from "@openharness/core";
import type { EngineDeps, JobQueue, StateStore } from "@openharness/core";
import { EncryptedSecretStore } from "./secrets.ts";

export interface OpenHarnessServerConfig {
  dataDir?: string;
  workspaceRoot?: string;
  databaseUrl?: string;
  serverToken?: string;
  adminToken?: string;
  defaultAgent?: string;
  defaultModel?: string;
  defaultRuntime?: string;
  osEnforcedSandbox?: boolean;
}

/**
 * Thin HTTP & SSE server adapter that delegates all agent execution to `DurableWorker`
 * and `AgentEngine` (§3 A.1, A.2). No agent loop lives inside `server.ts`.
 */
export class OpenHarnessServer {
  readonly config: OpenHarnessServerConfig;
  readonly stateStore: StateStore;
  readonly eventBus: InProcessEventBus;
  readonly jobQueue: JobQueue;
  readonly worker: DurableWorker;
  readonly secretStore: EncryptedSecretStore;
  readonly checkpointManager: SessionCheckpointManager;
  readonly scheduleManager: ScheduleManager;
  readonly deps: EngineDeps;
  private defaultRuntime: string;
  private httpServer?: http.Server;

  constructor(config?: OpenHarnessServerConfig) {
    this.config = config ?? {};
    const dataDir = this.config.dataDir;
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
    this.defaultRuntime = this.config.defaultRuntime ?? "local";

    const toolRouter = new StandardToolRouter({
      workspaceRoot,
      sandboxEnabled: Boolean(this.config.osEnforcedSandbox),
    });

    const contextManager = new LayeredContextManager({
      workspaceRoot,
    });

    const policyGate = new RiskPolicyGate({
      osEnforcedSandbox: Boolean(this.config.osEnforcedSandbox ?? true),
      defaultConfirmationPolicy: "risky",
    });

    const provider = new ModelAgnosticProviderAdapter({
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
      transport: async (payload) => {
        // Offline deterministic mock provider response so the offline demo always works (§0.1)
        const lastMsg = payload.messages?.at(-1);
        const content = String(lastMsg?.content ?? "");
        return {
          text: `Processed prompt with model ${payload.model}: ${content.slice(0, 120)}`,
          tool_calls: [],
          usage: { prompt_tokens: 64, completion_tokens: 24 },
        };
      },
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
      onCreateCheckpoint: async (state, message, automatic): Promise<CheckpointInfo> => ({
        sha: `cp_${state.runId}_${state.iteration}_${Date.now()}`,
        message,
        createdAt: Date.now(),
        sessionId: state.sessionId,
        runId: state.runId,
        step: state.iteration,
        automatic,
      }),
    };

    this.worker = new DurableWorker(this.jobQueue, this.deps);
    this.scheduleManager = new ScheduleManager({
      onEnqueueRun: async (req) => {
        const sessionId = `sess_${req.runId}`;
        await this.stateStore.saveSession("default", {
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
          tenantId: "default",
          prompt: req.prompt,
          agent: req.agent,
          model: this.config.defaultModel ?? "mock/demo",
          mode: req.mode,
        });
        return { runId: req.runId, sessionId };
      },
    });
  }

  private constantTimeTokenMatch(provided: string | undefined, expected: string | undefined): boolean {
    if (!expected) return true;
    if (!provided) return false;
    const clean = provided.replace(/^Bearer\s+/i, "").trim();
    const a = Buffer.from(clean, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  async handleRequest(
    method: string,
    urlPath: string,
    headers: Record<string, string | undefined> = {},
    body?: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    const parsedUrl = new URL(urlPath, "http://127.0.0.1:4096");
    const pathname = parsedUrl.pathname;
    const tenantId = headers["x-tenant-id"] || "default";

    if (method === "GET" && pathname === "/health") {
      return { status: 200, body: { ok: true, version: "0.2.0" } };
    }

    // Server bearer token authentication when configured
    const serverToken = this.config.serverToken ?? process.env.OPENHARNESS_SERVER_TOKEN;
    if (serverToken && pathname.startsWith("/v1/") && pathname !== "/v1/admin/verify") {
      if (!this.constantTimeTokenMatch(headers["authorization"], serverToken)) {
        return { status: 401, body: { error: "Unauthorized" } };
      }
    }

    // Admin routes require adminToken when configured
    if (pathname.startsWith("/v1/admin/")) {
      const adminToken = this.config.adminToken ?? process.env.OPENHARNESS_ADMIN_TOKEN;
      if (adminToken) {
        const candidate = headers["x-openharness-admin"] ?? headers["authorization"];
        if (!this.constantTimeTokenMatch(candidate, adminToken)) {
          return { status: 403, body: { error: "Forbidden: invalid admin token" } };
        }
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
      const runtimes: RuntimeInfo[] = [
        {
          id: "local",
          description: "Local unsandboxed runtime (offline demo default).",
          remote: false,
          isDefault: this.defaultRuntime === "local",
          active: true,
          capabilities: {
            osEnforced: false,
            network: "open",
            snapshots: false,
            ports: false,
            browser: false,
            persistentShell: false,
          },
        },
        {
          id: "srt-local",
          description: "Host child process isolated by Anthropic Sandbox Runtime (srt).",
          remote: false,
          isDefault: this.defaultRuntime === "srt-local",
          active: process.platform !== "win32",
          capabilities: {
            osEnforced: true,
            network: "allowlist",
            snapshots: true,
            ports: true,
            browser: true,
            persistentShell: true,
          },
        },
        {
          id: "docker",
          description: "Container-isolated sandbox with srt defense-in-depth and shadow-git checkpoints.",
          remote: false,
          isDefault: this.defaultRuntime === "docker",
          active: true,
          capabilities: {
            osEnforced: true,
            network: "allowlist",
            snapshots: true,
            ports: true,
            browser: true,
            persistentShell: true,
          },
        },
        {
          id: "modal",
          description: "Modal cloud microVM sandbox with filesystem snapshot hibernation.",
          remote: true,
          isDefault: this.defaultRuntime === "modal",
          active: true,
          capabilities: {
            osEnforced: true,
            network: "allowlist",
            snapshots: true,
            ports: true,
            browser: true,
            persistentShell: true,
          },
        },
      ];
      return { status: 200, body: runtimes };
    }

    // --- Sessions CRUD ---
    if (method === "GET" && pathname === "/v1/sessions") {
      const sessions = await this.stateStore.listSessions(tenantId);
      return { status: 200, body: sessions };
    }

    if (method === "POST" && pathname === "/v1/sessions") {
      const payload = body ?? {};
      const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const session: Session = {
        id,
        title: typeof payload.title === "string" ? payload.title : "New chat",
        agent: typeof payload.agent === "string" ? payload.agent : "assistant",
        model: typeof payload.model === "string" ? payload.model : (this.config.defaultModel ?? "mock/demo"),
        runtime: typeof payload.runtime === "string" ? payload.runtime : this.defaultRuntime,
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
        const updated: Session = { ...s, ...(body ?? {}), id: s.id, updatedAt: Date.now() };
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

    // --- Prompt Acceptance (`POST /v1/sessions/:id/prompt`, supporting `async: true` -> `{ messageId, runId }`) (§3 A.2) ---
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
      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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
        // Trigger worker asynchronously and return `{ messageId, runId }` immediately (§3 A.2)
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


    // --- Runs List (`GET /v1/runs`) (§13 Phase K) ---
    if (method === "GET" && pathname === "/v1/runs") {
      const jobs = await this.jobQueue.listJobs({ tenantId });
      const runs = [];
      for (const j of jobs) {
        const r = await this.stateStore.getRun(tenantId, j.runId);
        if (r) runs.push(r);
      }
      return { status: 200, body: { runs } };
    }

    // --- Sandboxes Routes (`/v1/sandboxes`) (§13 Phase K) ---
    if (method === "GET" && pathname === "/v1/sandboxes") {
      return {
        status: 200,
        body: {
          sandboxes: [
            { id: "sb_default", provider: this.defaultRuntime, status: "running" },
          ],
        },
      };
    }
    const sbShellMatch = pathname.match(/^\/v1\/sandboxes\/([^/]+)\/shell$/);
    if (method === "POST" && sbShellMatch) {
      return {
        status: 200,
        body: {
          sandboxId: sbShellMatch[1],
          command: body?.command ?? "pwd",
          output: this.deps.workspaceRoot,
          exitCode: 0,
        },
      };
    }
    const sbDelMatch = pathname.match(/^\/v1\/sandboxes\/([^/]+)$/);
    if (method === "DELETE" && sbDelMatch) {
      return { status: 200, body: { destroyed: sbDelMatch[1] } };
    }

    // --- Admin Settings Validation (`PUT /v1/admin/settings`) (§14 fail-closed) ---
    if (method === "PUT" && pathname === "/v1/admin/settings") {
      const validation = validateOpenHarnessConfig(body ?? {});
      if (!validation.valid) {
        return { status: 400, body: { error: validation.errors.join("; "), errors: validation.errors } };
      }
      return { status: 200, body: { config: validation.sanitizedConfig } };
    }

    // --- Run Control Routes (`GET /v1/runs/:id`, `POST /v1/runs/:id/pause|resume|cancel`) (§3 A.2) ---
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

    // --- Permissions Routes ---
    if (method === "GET" && pathname === "/v1/permissions") {
      const sid = parsedUrl.searchParams.get("sessionId") ?? undefined;
      const list = await this.stateStore.listPermissionRequests(tenantId, sid);
      return { status: 200, body: list };
    }

    const permReplyMatch = pathname.match(/^\/v1\/permissions\/([^/]+)\/reply$/);
    if (method === "POST" && permReplyMatch) {
      const reply = (body?.reply as PermissionReply) ?? "reject";
      const res = await this.worker.replyPermissionAndResume(tenantId, permReplyMatch[1]!, reply);
      return { status: 200, body: { replied: true, phase: res.state?.phase } };
    }

    // --- Phase I Checkpoints, Rewind, and Fork Routes (§11) ---
    const cpListMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/checkpoints$/);
    if (method === "GET" && cpListMatch) {
      const checkpoints = await this.checkpointManager.listCheckpoints(tenantId, cpListMatch[1]!);
      return { status: 200, body: { checkpoints } };
    }

    const rewindMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/rewind$/);
    if (method === "POST" && rewindMatch) {
      const sessionId = rewindMatch[1]!;
      const payload = body ?? {};
      const res = await this.checkpointManager.rewindSession({
        tenantId,
        sessionId,
        checkpoint: String(payload.checkpoint ?? ""),
        files: payload.files !== undefined ? Boolean(payload.files) : true,
        conversation: payload.conversation !== undefined ? Boolean(payload.conversation) : false,
        atMessageId: typeof payload.atMessageId === "string" ? payload.atMessageId : undefined,
      });
      return { status: 200, body: res };
    }

    const forkMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/fork$/);
    if (method === "POST" && forkMatch) {
      const sessionId = forkMatch[1]!;
      const payload = body ?? {};
      const res = await this.checkpointManager.forkSession({
        tenantId,
        sessionId,
        atMessageId: typeof payload.atMessageId === "string" ? payload.atMessageId : undefined,
        checkpoint: typeof payload.checkpoint === "string" ? payload.checkpoint : undefined,
        newTitle: typeof payload.title === "string" ? payload.title : undefined,
      });
      return { status: 201, body: res };
    }

    // --- Phase H Schedules CRUD (`/v1/schedules`) (§10) ---
    if (method === "GET" && pathname === "/v1/schedules") {
      return { status: 200, body: this.scheduleManager.list() };
    }
    if (method === "POST" && pathname === "/v1/schedules") {
      const payload = body ?? {};
      const created = this.scheduleManager.create({
        name: String(payload.name ?? "Scheduled Task"),
        cron: typeof payload.cron === "string" ? payload.cron : undefined,
        webhookSecret: typeof payload.webhookSecret === "string" ? payload.webhookSecret : undefined,
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

    // --- Admin Secrets Routes ---
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
