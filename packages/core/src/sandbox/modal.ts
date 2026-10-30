import crypto from "node:crypto";
import type {
  HealthReport,
  SandboxCapabilities,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
  SnapshotRef,
} from "./contracts.ts";
import type { ModalApi, ModalSandboxRef } from "./modal-api.ts";
import { compileSandboxPolicy, type CompiledSandboxPolicy } from "./policy.ts";
import { SETUP_DOMAINS, toModalNetwork } from "./modal-policy.ts";
import { HttpDaemonTransport, type SandboxTransport } from "./transport.ts";
import type { SandboxRecord, SandboxRecordStore } from "./records.ts";
import { materializeWorkspace, packLocal, sha256 } from "./workspace-io.ts";
import { registerSandboxTransport, unregisterSandboxTransport } from "./providers.ts";

const DAEMON_PORT = 8080;
const DAY = 86_400_000;

export type ModalProviderConfig = {
  baseImageId: string;
  cpu: number;
  memoryMiB: number;
  timeoutMs: number;
  bootTimeoutMs: number;
  setupTimeoutMs: number;
  snapshotTtlMs: number;
  envCacheTtlMs: number;
  encryptedPorts: number[];
  allowUnencryptedPorts?: boolean;
  inboundCidrAllowlist: string[];
  encrypt(s: string): string;
  decrypt(s: string): string;
  transportFactory?: (
    ref: ModalSandboxRef,
    sessionKey: string,
    rec: Pick<SandboxRecord, "tenantId" | "runId" | "handleId">
  ) => SandboxTransport;
};

export class SandboxGoneError extends Error {
  constructor(id: string) {
    super(`sandbox ${id} is no longer running`);
    this.name = "SandboxGoneError";
  }
}

export class ModalSandboxProvider implements SandboxProvider {
  readonly id = "modal" as const;
  readonly capabilities: SandboxCapabilities = {
    osEnforced: true,
    network: "allowlist",
    snapshots: true,
    ports: true,
    browser: true,
    persistentShell: true,
  };
  private live = new Map<string, { ref: ModalSandboxRef; transport: SandboxTransport }>();
  private api: ModalApi;
  private cfg: ModalProviderConfig;
  private records: SandboxRecordStore;

  constructor(api: ModalApi, cfg: ModalProviderConfig, records: SandboxRecordStore) {
    this.api = api;
    this.cfg = cfg;
    this.records = records;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const ws = spec.workspace as any;
    const imageId =
      ws?.kind === "snapshot"
        ? String(ws.imageId)
        : await this.environmentImage(spec);
    return this.boot(
      spec,
      imageId,
      `modal-${crypto.randomBytes(4).toString("hex")}`
    );
  }

  /** Setup phase: networked sandbox installs dependencies, then its filesystem becomes the agent image (cached). */
  private async environmentImage(spec: SandboxSpec): Promise<string> {
    const ws = spec.workspace as any;
    const isLocal =
      ws?.kind === "local" || ws?.type === "bind" || ws?.type === "copy";
    const localPath = ws?.path ?? ws?.hostPath;
    let prepackedTar: Uint8Array | undefined;
    let wsFingerprint = JSON.stringify(ws);

    if (isLocal && localPath) {
      prepackedTar = await packLocal(localPath);
      wsFingerprint = sha256(prepackedTar).digest("hex");
    }

    const key = sha256(
      JSON.stringify([this.cfg.baseImageId, wsFingerprint, spec.setupCommands ?? []])
    ).digest("hex");

    const hit = await this.records.getEnvImage(key);
    if (hit && hit.expiresAt > Date.now()) return hit.imageId;

    const setupPolicy = compileSandboxPolicy({
      runId: spec.runId,
      phase: "setup",
      networkMode: "allowlist",
      additionalAllowedDomains: SETUP_DOMAINS,
      workspacePath: "/workspace",
      memoriesPath: "/memories",
      tmpPath: "/tmp/oh",
    });

    const setupHandleId = `setup-${crypto.randomBytes(4).toString("hex")}`;
    const tenantId = (spec as any).tenantId ?? "local";
    const sb = await this.api.create({
      imageId: this.cfg.baseImageId,
      command: ["sleep", "infinity"],
      env: {},
      workdir: "/workspace",
      cpu: this.cfg.cpu,
      memoryMiB: this.cfg.memoryMiB,
      timeoutMs: this.cfg.setupTimeoutMs,
      runtime: "vm",
      encryptedPorts: [],
      tags: { oh: "1", phase: "setup", tenant: tenantId, run: spec.runId, handle: setupHandleId },
      ...toModalNetwork(setupPolicy),
    });

    const now = Date.now();
    await this.records.save({
      handleId: setupHandleId,
      providerId: "modal",
      tenantId,
      sessionId: spec.sessionId,
      runId: spec.runId,
      status: "setup",
      modalSandboxId: sb.id,
      imageId: this.cfg.baseImageId,
      sessionKeyEnc: "",
      cpu: this.cfg.cpu,
      memoryMiB: this.cfg.memoryMiB,
      createdAt: now,
      timeoutMs: this.cfg.setupTimeoutMs,
      billedUntil: now,
      ports: {},
      policy: setupPolicy,
    });

    try {
      await materializeWorkspace(sb, prepackedTar ? { kind: "local", path: localPath, prepackedTar } : ws);
      for (const cmd of spec.setupCommands ?? []) {
        const r = await sb.exec(["bash", "-lc", cmd], {
          timeoutMs: this.cfg.setupTimeoutMs,
          workdir: "/workspace",
        });
        if (r.exitCode !== 0) {
          throw new Error(
            `setup failed (${r.exitCode}): ${cmd}\n${(r.stderr || r.stdout).slice(-4_000)}`
          );
        }
      }
      const imageId = await sb.snapshotFilesystem(this.cfg.envCacheTtlMs);
      await this.records.putEnvImage(key, {
        imageId,
        expiresAt: Date.now() + this.cfg.envCacheTtlMs,
      });
      return imageId;
    } finally {
      await sb.terminate().catch(() => {});
      await this.records.update(setupHandleId, { status: "terminated" }).catch(() => {});
    }
  }

  private async boot(
    spec: SandboxSpec,
    imageId: string,
    handleId: string
  ): Promise<SandboxHandle> {
    const sessionKey = crypto.randomBytes(32).toString("hex");
    const rawNetMode =
      spec.policy?.network?.mode === "open"
        ? "none"
        : (spec.policy?.network?.mode ?? "none");
    const policy: CompiledSandboxPolicy = compileSandboxPolicy({
      runId: spec.runId,
      phase: "agent",
      networkMode: rawNetMode,
      additionalAllowedDomains: spec.policy?.network?.allowedDomains ?? [],
      workspacePath: "/workspace",
      memoriesPath: "/memories",
      tmpPath: "/tmp/oh",
    });
    const timeoutMs = Math.min(this.cfg.timeoutMs, DAY);
    const cpu = spec.limits?.cpuCores ?? this.cfg.cpu;
    const memoryMiB = spec.limits?.memoryMb ?? this.cfg.memoryMiB;
    const ports = [DAEMON_PORT, ...this.cfg.encryptedPorts.filter((p) => p !== DAEMON_PORT)];
    const tenantId = (spec as any).tenantId ?? "local";

    const ref = await this.api.create({
      imageId,
      runtime: "vm",
      timeoutMs,
      command: [
        "/usr/local/bin/oh-sandboxd",
        "--host",
        "0.0.0.0",
        "--port",
        String(DAEMON_PORT),
      ],
      env: {
        OH_SESSION_KEY: sessionKey,
        OH_RUN_ID: spec.runId,
        OH_SESSION_ID: spec.sessionId,
        OH_POLICY_B64: Buffer.from(JSON.stringify(policy)).toString("base64"),
      },
      workdir: "/workspace",
      cpu,
      memoryMiB,
      encryptedPorts: ports,
      inboundCidrAllowlist: this.cfg.inboundCidrAllowlist,
      ...toModalNetwork(policy),
      tags: {
        oh: "1",
        tenant: tenantId,
        session: spec.sessionId,
        run: spec.runId,
        handle: handleId,
      },
    });

    const now = Date.now();
    const record: SandboxRecord = {
      handleId,
      providerId: "modal",
      tenantId,
      sessionId: spec.sessionId,
      runId: spec.runId,
      status: "starting",
      modalSandboxId: ref.id,
      imageId,
      sessionKeyEnc: this.cfg.encrypt(sessionKey),
      cpu,
      memoryMiB,
      timeoutMs,
      billedUntil: now,
      createdAt: now,
      ports: {},
      policy,
    };
    await this.records.save(record);

    const transport = this.transportFor(ref, sessionKey, record);
    try {
      await waitForHealth(transport, this.cfg.bootTimeoutMs);
    } catch (err) {
      await ref.terminate().catch(() => {});
      await this.records.update(handleId, { status: "terminated" });
      throw new Error(
        `Modal sandbox failed to become healthy: ${(err as Error).message}`
      );
    }

    const tunnels = { ...(await ref.tunnels()) };
    delete tunnels[DAEMON_PORT];
    await this.records.update(handleId, { status: "running", ports: tunnels });
    this.live.set(handleId, { ref, transport });
    registerSandboxTransport(handleId, transport, sessionKey);

    return {
      id: handleId,
      providerId: "modal",
      runId: spec.runId,
      sessionId: spec.sessionId,
      agentServerUrl: "modal:connect-token",
      sessionKey: "", // never expose plaintext sessionKey on SandboxHandle
      workspacePath: "/workspace",
      memoriesPath: "/memories",
      tmpPath: "/tmp/oh",
      shadowGitDir: "/oh/.shadow-git",
      status: "running",
      ports: tunnels,
      policy,
      transport,
    };
  }

  private transportFor(
    ref: ModalSandboxRef,
    sessionKey: string,
    r: Pick<SandboxRecord, "tenantId" | "runId" | "handleId">
  ): SandboxTransport {
    if (this.cfg.transportFactory) {
      return this.cfg.transportFactory(ref, sessionKey, r);
    }
    return new HttpDaemonTransport(sessionKey, () =>
      ref.connectToken(DAEMON_PORT, {
        tenant: r.tenantId,
        run: r.runId,
        handle: r.handleId,
      })
    );
  }

  /** Re-attach after a worker restart; throws SandboxGoneError if the Modal sandbox has exited. */
  async attach(
    handleId: string
  ): Promise<{ ref: ModalSandboxRef; transport: SandboxTransport }> {
    const cached = this.live.get(handleId);
    if (cached) {
      if ((await cached.ref.poll()) !== null) {
        this.live.delete(handleId);
        unregisterSandboxTransport(handleId);
        await this.records.update(handleId, { status: "terminated" });
        throw new SandboxGoneError(handleId);
      }
      return cached;
    }
    const rec = await this.records.get(handleId);
    if (!rec?.modalSandboxId || rec.status !== "running") {
      throw new SandboxGoneError(handleId);
    }
    const ref = await this.api.fromId(rec.modalSandboxId);
    if ((await ref.poll()) !== null) {
      await this.records.update(handleId, { status: "terminated" });
      throw new SandboxGoneError(handleId);
    }
    const decryptedKey = this.cfg.decrypt(rec.sessionKeyEnc);
    const transport = this.transportFor(ref, decryptedKey, rec);
    const entry = { ref, transport };
    this.live.set(handleId, entry);
    registerSandboxTransport(handleId, transport, decryptedKey);
    return entry;
  }

  /** Pause = stop processes, checkpoint, snapshot filesystem, terminate. */
  async pause(h: SandboxHandle): Promise<void> {
    const { ref, transport } = await this.attach(h.id);
    await transport.request("POST", "/processes/stop-all", {}).catch(() => {});
    await transport.request("POST", "/checkpoints/create", { message: "Pause" });
    const imageId = await ref.snapshotFilesystem(this.cfg.snapshotTtlMs);
    await ref.terminate();
    this.live.delete(h.id);
    unregisterSandboxTransport(h.id);
    await this.records.update(h.id, {
      status: "snapshotted",
      lastSnapshotImageId: imageId,
    });
    h.status = "paused";
    h.snapshotId = imageId;
  }

  /** Resume keeps the same handle id so RunState and checkpoints stay valid. */
  async resume(h: SandboxHandle): Promise<void> {
    const rec = await this.records.get(h.id);
    const snapshotImageId = rec?.lastSnapshotImageId ?? h.snapshotId;
    if (!snapshotImageId) {
      throw new Error(`no snapshot to resume ${h.id}`);
    }
    const next = await this.boot(
      {
        runId: rec?.runId ?? h.runId,
        sessionId: rec?.sessionId ?? h.sessionId,
        providerId: "modal",
        workspace: { kind: "snapshot", imageId: snapshotImageId } as any,
        policy: rec?.policy ?? h.policy,
        limits: { cpuCores: rec?.cpu, memoryMb: rec?.memoryMiB },
      },
      snapshotImageId,
      h.id
    );
    Object.assign(h, next);
  }

  async snapshot(h: SandboxHandle): Promise<SnapshotRef> {
    const { ref, transport } = await this.attach(h.id);
    const cp = await transport.request("POST", "/checkpoints/create", {
      message: "Snapshot",
    });
    const imageId = await ref.snapshotFilesystem(this.cfg.snapshotTtlMs);
    await this.records.update(h.id, { lastSnapshotImageId: imageId });
    h.snapshotId = imageId;
    return {
      id: `${h.id}:${imageId}`,
      providerId: "modal",
      runId: h.runId,
      sessionId: h.sessionId,
      createdAt: Date.now(),
      metadata: { sha: cp.body?.sha },
    };
  }

  restore(ref: SnapshotRef, spec: SandboxSpec): Promise<SandboxHandle> {
    return this.create({
      ...spec,
      workspace: { kind: "snapshot", imageId: ref.id.split(":")[1]! } as any,
    });
  }

  async destroy(h: SandboxHandle): Promise<void> {
    const attached = await this.attach(h.id).catch(() => null);
    if (attached?.ref) {
      await attached.ref.terminate().catch(() => {});
    }
    this.live.delete(h.id);
    unregisterSandboxTransport(h.id);
    await this.records.update(h.id, { status: "terminated" }).catch(() => {});
    h.status = "destroyed";
  }

  async health(h?: SandboxHandle): Promise<HealthReport> {
    const base = { providerId: "modal" as const, checkedAt: Date.now() };
    if (!this.cfg.baseImageId) {
      return {
        ...base,
        ok: false,
        status: "unavailable",
        osEnforced: false,
        detail: "image manifest missing (run npm run modal:image)",
      };
    }
    if (!h) {
      return { ...base, ok: true, status: "ready", osEnforced: true };
    }
    try {
      const { transport } = await this.attach(h.id);
      const res = await transport.request("GET", "/health");
      return {
        ...base,
        ok: res.status === 200 && res.body?.osEnforced !== false,
        status: String(res.body?.status ?? "running"),
        osEnforced: res.body?.osEnforced !== false,
      };
    } catch (err) {
      return {
        ...base,
        ok: false,
        status: "gone",
        osEnforced: false,
        detail: (err as Error).message,
      };
    }
  }
}

async function waitForHealth(t: SandboxTransport, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 50; Date.now() < deadline; delay = Math.min(delay * 2, 1_000)) {
    const res = await t
      .request("GET", "/health", undefined, { timeoutMs: 5_000 })
      .catch(() => null);
    if (res?.status === 200 && res.body?.osEnforced !== false) return;
    if (res?.status === 200 || res?.status === 503) {
      throw new Error("daemon reports enforcement unavailable");
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error("timed out waiting for /health");
}
