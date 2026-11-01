import crypto from "node:crypto";
import type {
  HealthReport,
  SandboxCapabilities,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
  SnapshotRef,
} from "./contracts.ts";
import { registerSandboxTransport, unregisterSandboxTransport } from "./providers.ts";
import type { DaemonResponse, SandboxTransport } from "./transport.ts";

export interface PinnedModalSandboxConfig {
  endpointUrl: string;
  sharedKey: string;
  fetchImpl?: typeof fetch;
}

export class PinnedModalSandboxProvider implements SandboxProvider {
  readonly id = "modal" as const;
  readonly capabilities: SandboxCapabilities = {
    osEnforced: true,
    network: "allowlist",
    snapshots: true,
    ports: true,
    browser: true,
    persistentShell: true,
  };
  private readonly endpointUrl: string;
  private readonly sharedKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly transports = new Map<string, SandboxTransport>();

  constructor(config: PinnedModalSandboxConfig) {
    this.endpointUrl = config.endpointUrl.replace(/\/+$/, "");
    this.sharedKey = config.sharedKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
    if (!this.endpointUrl) throw new Error("OH_MODAL_SANDBOX_URL is empty");
    if (!this.sharedKey) throw new Error("OH_MODAL_SANDBOX_KEY is empty");
  }

  handleIdFor(spec: SandboxSpec): string {
    const safeTenant = String((spec as any).tenantId ?? "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 20);
    const safeSession = spec.sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    return `modal_${safeTenant}_${safeSession}`;
  }

  private transportFor(handleId: string): SandboxTransport {
    const current = this.transports.get(handleId);
    if (current) return current;
    const transport: SandboxTransport = {
      request: async (method, route, body, options = {}) => {
        let lastError: unknown;
        for (let attempt = 0; attempt <= 3; attempt++) {
          try {
            const response = await this.fetchImpl(`${this.endpointUrl}${route}`, {
              method: method.toUpperCase(),
              headers: {
                "x-session-key": this.sharedKey,
                "x-oh-sandbox-id": handleId,
                "x-oh-request-id": crypto.randomUUID(),
                ...(body === undefined || method.toUpperCase() === "GET" ? {} : { "content-type": "application/json" }),
              },
              body: body === undefined || method.toUpperCase() === "GET" ? undefined : JSON.stringify(body),
              signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 120_000),
            });
            const text = await response.text();
            let parsed: any;
            try { parsed = text ? JSON.parse(text) : {}; }
            catch { parsed = { error: text.slice(0, 1000) }; }
            const result: DaemonResponse = {
              status: response.status,
              body: parsed,
              daemon: response.headers.get("x-oh-daemon") === "1",
            };
            const transient = [502, 503, 504].includes(response.status);
            if (!transient || attempt === 3) return result;
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
          } catch (err) {
            lastError = err;
            if (attempt === 3) break;
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
          }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Modal sandbox hub request failed"));
      },
    };
    this.transports.set(handleId, transport);
    registerSandboxTransport(handleId, transport, this.sharedKey);
    return transport;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const handleId = this.handleIdFor(spec);
    const transport = this.transportFor(handleId);
    const init = await transport.request("POST", "/sessions/init", {} , { timeoutMs: 45_000 });
    if (init.status !== 200) throw new Error(`Modal sandbox hub session init failed (${init.status}): ${init.body?.error ?? "unknown error"}`);
    for (const command of spec.setupCommands ?? []) {
      const result = await transport.request("POST", "/shell/setup/exec", { command }, { timeoutMs: 300_000 });
      if (result.status !== 200 || (typeof result.body?.exitCode === "number" && result.body.exitCode !== 0)) {
        throw new Error(`Modal sandbox setup command failed: ${String(result.body?.output ?? result.body?.error ?? command)}`);
      }
    }
    const ports = Object.fromEntries((spec.exposedPorts ?? []).filter((port) => port !== 8080).map((port) => [port, this.resolveTunnelUrl(handleId, port)!]));
    const handle: SandboxHandle = {
      id: handleId,
      providerId: "modal",
      runId: spec.runId,
      sessionId: spec.sessionId,
      agentServerUrl: `${this.endpointUrl}`,
      sessionKey: "",
      workspacePath: String(init.body.workspacePath),
      memoriesPath: `/workspaces/${handleId}/memories`,
      tmpPath: `/tmp/oh/${handleId}`,
      shadowGitDir: `/workspaces/${handleId}/.shadow-git`,
      status: "running",
      ports,
      policy: spec.policy,
      transport,
    };
    return handle;
  }

  async attach(handleId: string): Promise<{ transport: SandboxTransport }> {
    if (!/^modal_[A-Za-z0-9_-]{3,90}$/.test(handleId)) throw new Error("Invalid pinned Modal handle ID");
    const transport = this.transportFor(handleId);
    const init = await transport.request("POST", "/sessions/init", {}, { timeoutMs: 45_000 });
    if (init.status !== 200) throw new Error(`Modal sandbox hub attach failed (${init.status})`);
    return { transport };
  }

  resolveTunnelUrl(_handleId: string, port: number): string | undefined {
    return port === 8080 ? undefined : `${this.endpointUrl}/preview/${port}/`;
  }

  async pause(handle: SandboxHandle): Promise<void> {
    const res = await this.transportFor(handle.id).request("POST", "/processes/stop-all", {});
    if (res.status !== 200) throw new Error(`Modal sandbox pause failed (${res.status})`);
    handle.status = "paused";
  }

  async resume(handle: SandboxHandle): Promise<void> {
    const res = await this.transportFor(handle.id).request("POST", "/sessions/init", {}, { timeoutMs: 45_000 });
    if (res.status !== 200) throw new Error(`Modal sandbox resume failed (${res.status})`);
    handle.status = "running";
  }

  async snapshot(handle: SandboxHandle): Promise<SnapshotRef> {
    const result = await this.transportFor(handle.id).request("POST", "/checkpoints/create", { message: "Pinned Modal snapshot" });
    if (result.status !== 200 || typeof result.body?.sha !== "string") throw new Error(`Modal sandbox snapshot failed (${result.status})`);
    handle.snapshotId = result.body.sha;
    return { id: result.body.sha, providerId: "modal", runId: handle.runId, sessionId: handle.sessionId, createdAt: Date.now() };
  }

  async restore(ref: SnapshotRef, spec: SandboxSpec): Promise<SandboxHandle> {
    const handle = await this.create(spec);
    const result = await handle.transport!.request("POST", "/checkpoints/restore", { sha: ref.id });
    if (result.status !== 200) throw new Error(`Modal sandbox restore failed (${result.status})`);
    return handle;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const result = await this.transportFor(handle.id).request("DELETE", "/sessions", {});
    if (result.status !== 200) throw new Error(`Modal sandbox destroy failed (${result.status})`);
    handle.status = "destroyed";
    this.transports.delete(handle.id);
    unregisterSandboxTransport(handle.id);
  }

  async health(_handle?: SandboxHandle): Promise<HealthReport> {
    const checkedAt = Date.now();
    try {
      const response = await this.fetchImpl(`${this.endpointUrl}/health`, { signal: AbortSignal.timeout(10_000) });
      const body = await response.json() as Record<string, unknown>;
      return {
        ok: response.ok && body.ok === true,
        providerId: "modal",
        status: String(body.mode ?? (response.ok ? "healthy" : response.status)),
        osEnforced: body.osEnforced === true,
        checkedAt,
      };
    } catch (err) {
      return { ok: false, providerId: "modal", status: "unavailable", osEnforced: false, detail: (err as Error).message, checkedAt };
    }
  }

  async snapshotIdle(): Promise<string[]> { return []; }
}
