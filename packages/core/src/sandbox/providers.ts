import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SandboxTelemetryEvent } from "../../../sandboxd/src/server.ts";
import { SandboxDaemon } from "../../../sandboxd/src/server.ts";
import type {
  HealthReport,
  SandboxCapabilities,
  SandboxHandle,
  SandboxProvider,
  SandboxProviderId,
  SandboxSpec,
  SnapshotRef,
} from "./contracts.ts";
import { compileSandboxPolicy } from "./policy.ts";

const activeDaemons = new Map<string, SandboxDaemon>();
const snapshotStore = new Map<string, { workspaceBackupDir: string; sha?: string; createdAt: number }>();

export function getActiveSandboxDaemon(handleId: string): SandboxDaemon | undefined {
  return activeDaemons.get(handleId);
}

/**
 * Computes a deterministic content-hashed image tag for Docker sandboxes (§5 C.3).
 */
export function computeDockerRuntimeImageTag(
  toolchain = "node-python",
  dockerfileContent = "FROM node:24-slim",
  lockfileContent = ""
): string {
  const hash = crypto
    .createHash("sha256")
    .update(toolchain)
    .update("\0")
    .update(dockerfileContent)
    .update("\0")
    .update(lockfileContent)
    .digest("hex")
    .slice(0, 12);
  return `openharness/sandbox:${toolchain}-${hash}`;
}

/**
 * Builds the hardened `docker run` CLI flags for a container session (§5 C.3).
 */
export function buildDockerRunArgs(
  handleId: string,
  spec: SandboxSpec,
  agentPort: number,
  previewPort: number,
  imageTag: string
): string[] {
  const cpus = String(spec.limits?.cpuCores ?? 2);
  const mem = `${spec.limits?.memoryMb ?? 4096}m`;
  return [
    "run",
    "-d",
    "--name",
    `oh-sb-${handleId}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "1000:1000",
    "--read-only",
    "--cpus",
    cpus,
    "--memory",
    mem,
    "-p",
    `127.0.0.1:${agentPort}:4097`,
    "-p",
    `127.0.0.1:${previewPort}:3000`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=512m",
    "-v",
    `${spec.workspace.hostPath ?? "/workspace"}:/workspace:rw`,
    imageTag,
  ];
}

function createSandboxRootDirs(spec: SandboxSpec): {
  workspacePath: string;
  memoriesPath: string;
  tmpPath: string;
  shadowGitDir: string;
  policyFilePath: string;
} {
  const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), `oh-sb-${spec.runId}-`));
  const workspacePath =
    spec.workspace.type === "bind" && spec.workspace.hostPath
      ? path.resolve(spec.workspace.hostPath)
      : path.join(baseTmp, "workspace");
  const memoriesPath = path.join(baseTmp, "memories");
  const tmpPath = path.join(baseTmp, "tmp");
  const shadowGitDir = path.join(baseTmp, ".shadow-git");
  const policyFilePath = path.join(baseTmp, "policy.json");

  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(memoriesPath, { recursive: true });
  fs.mkdirSync(tmpPath, { recursive: true });
  fs.mkdirSync(shadowGitDir, { recursive: true });

  fs.writeFileSync(policyFilePath, JSON.stringify(spec.policy, null, 2), {
    encoding: "utf8",
    mode: 0o444,
  });

  return { workspacePath, memoriesPath, tmpPath, shadowGitDir, policyFilePath };
}

/**
 * 1. `local` provider — unsandboxed default for the offline demo (§5 C.3).
 * Refuses autonomous long_task mode unless `allowUnsandboxedAutonomy: true` is explicitly set.
 */
export class LocalSandboxProvider implements SandboxProvider {
  readonly id: SandboxProviderId = "local";
  readonly capabilities: SandboxCapabilities = {
    osEnforced: false,
    network: "open",
    snapshots: false,
    ports: false,
    browser: false,
    persistentShell: false,
  };

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (!spec.allowUnsandboxedAutonomy) {
      throw new Error(
        "Refusing to start autonomous sandboxed run on unsandboxed 'local' runtime (fail-closed). Configure 'srt-local', 'docker', or 'modal', or set allowUnsandboxedAutonomy: true explicitly."
      );
    }
    const dirs = createSandboxRootDirs(spec);
    const sessionKey = crypto.randomBytes(24).toString("hex");
    const handleId = `local_${spec.runId}`;
    return {
      id: handleId,
      providerId: "local",
      runId: spec.runId,
      sessionId: spec.sessionId,
      agentServerUrl: "in-process://local",
      sessionKey,
      workspacePath: dirs.workspacePath,
      memoriesPath: dirs.memoriesPath,
      tmpPath: dirs.tmpPath,
      shadowGitDir: dirs.shadowGitDir,
      status: "running",
      ports: {},
      policy: spec.policy,
    };
  }

  async pause(h: SandboxHandle): Promise<void> {
    h.status = "paused";
  }

  async resume(h: SandboxHandle): Promise<void> {
    h.status = "running";
  }

  async snapshot(h: SandboxHandle): Promise<SnapshotRef> {
    return {
      id: `snap_local_${h.runId}_${Date.now()}`,
      providerId: "local",
      runId: h.runId,
      sessionId: h.sessionId,
      createdAt: Date.now(),
    };
  }

  async restore(_ref: SnapshotRef, spec: SandboxSpec): Promise<SandboxHandle> {
    return this.create({ ...spec, allowUnsandboxedAutonomy: true });
  }

  async destroy(h: SandboxHandle): Promise<void> {
    h.status = "destroyed";
  }

  async health(): Promise<HealthReport> {
    return {
      ok: true,
      providerId: "local",
      status: "ready (unsandboxed)",
      osEnforced: false,
      checkedAt: Date.now(),
    };
  }
}

/**
 * Base class for OS-enforced providers (`srt-local`, `docker`, `modal`) backed by `oh-sandboxd` (§5 C.2, C.3).
 */
export class ManagedDaemonSandboxProvider implements SandboxProvider {
  readonly id: SandboxProviderId;
  readonly capabilities: SandboxCapabilities = {
    osEnforced: true,
    network: "allowlist",
    snapshots: true,
    ports: true,
    browser: true,
    persistentShell: true,
  };
  private onTelemetry?: (ev: SandboxTelemetryEvent) => void;
  private onPolicySwitched?: (ev: {
    sessionId: string;
    runId: string;
    fromPhase: "setup";
    toPhase: "agent";
    policy: Record<string, unknown>;
  }) => void;
  private secretValuesToRedact: string[];

  constructor(
    id: SandboxProviderId,
    opts?: {
      onTelemetry?: (ev: SandboxTelemetryEvent) => void;
      onPolicySwitched?: (ev: {
        sessionId: string;
        runId: string;
        fromPhase: "setup";
        toPhase: "agent";
        policy: Record<string, unknown>;
      }) => void;
      secretValuesToRedact?: string[];
    }
  ) {
    this.id = id;
    this.onTelemetry = opts?.onTelemetry;
    this.onPolicySwitched = opts?.onPolicySwitched;
    this.secretValuesToRedact = opts?.secretValuesToRedact ?? [];
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const dirs = createSandboxRootDirs(spec);
    const sessionKey = crypto.randomBytes(24).toString("hex");
    const handleId = `${this.id}_${spec.runId}_${Math.random().toString(36).slice(2, 7)}`;

    // Normalize policy allowWrite roots to include the actual sandbox directories
    const activePolicy = compileSandboxPolicy({
      runId: spec.runId,
      phase: spec.setupCommands?.length ? "setup" : spec.policy.phase,
      workspacePath: dirs.workspacePath,
      memoriesPath: dirs.memoriesPath,
      tmpPath: dirs.tmpPath,
      allowGitConfigWrite: spec.policy.filesystem.allowGitConfigWrite,
      networkMode: spec.setupCommands?.length ? "allowlist" : spec.policy.network.mode,
      additionalAllowedDomains: spec.policy.network.allowedDomains,
      allowedMethods: spec.policy.network.allowedMethods,
      headerInjectionRules: spec.policy.network.headerInjectionRules,
    });

    const daemon = new SandboxDaemon({
      sessionId: spec.sessionId,
      runId: spec.runId,
      sessionKey,
      workspacePath: dirs.workspacePath,
      memoriesPath: dirs.memoriesPath,
      tmpPath: dirs.tmpPath,
      shadowGitDir: dirs.shadowGitDir,
      policyFilePath: dirs.policyFilePath,
      policy: activePolicy,
      secretValuesToRedact: this.secretValuesToRedact,
      onTelemetry: this.onTelemetry,
    });

    // Execute two-phase sandbox setup commands if provided, then switch to agent-phase policy (§2, §5 C.4)
    if (spec.setupCommands && spec.setupCommands.length > 0) {
      for (const cmd of spec.setupCommands) {
        await daemon.handleRequest(
          "POST",
          "/shell/setup/exec",
          { "x-session-key": sessionKey },
          { command: cmd, timeoutSec: 300 }
        );
      }
      const agentPhasePolicy = compileSandboxPolicy({
        runId: spec.runId,
        phase: "agent",
        workspacePath: dirs.workspacePath,
        memoriesPath: dirs.memoriesPath,
        tmpPath: dirs.tmpPath,
        allowGitConfigWrite: spec.policy.filesystem.allowGitConfigWrite,
        networkMode: spec.policy.network.mode,
        additionalAllowedDomains: spec.policy.network.allowedDomains,
        allowedMethods: spec.policy.network.allowedMethods,
        headerInjectionRules: spec.policy.network.headerInjectionRules,
      });
      daemon.config.policy = agentPhasePolicy;
      this.onPolicySwitched?.({
        sessionId: spec.sessionId,
        runId: spec.runId,
        fromPhase: "setup",
        toPhase: "agent",
        policy: agentPhasePolicy as unknown as Record<string, unknown>,
      });
    }

    activeDaemons.set(handleId, daemon);

    const agentPort = 30000 + Math.floor(Math.random() * 9999);
    return {
      id: handleId,
      providerId: this.id,
      runId: spec.runId,
      sessionId: spec.sessionId,
      agentServerUrl: `http://127.0.0.1:${agentPort}`,
      sessionKey,
      workspacePath: dirs.workspacePath,
      memoriesPath: dirs.memoriesPath,
      tmpPath: dirs.tmpPath,
      shadowGitDir: dirs.shadowGitDir,
      status: "running",
      ports: {},
      policy: daemon.config.policy,
    };
  }

  async pause(h: SandboxHandle): Promise<void> {
    h.status = "paused";
  }

  async resume(h: SandboxHandle): Promise<void> {
    h.status = "running";
  }

  async snapshot(h: SandboxHandle): Promise<SnapshotRef> {
    const daemon = activeDaemons.get(h.id);
    let sha: string | undefined;
    if (daemon) {
      const cp = await daemon.handleRequest(
        "POST",
        "/checkpoints/create",
        { "x-session-key": h.sessionKey },
        { message: `Snapshot for ${h.id}` }
      );
      sha = typeof cp.body.sha === "string" ? cp.body.sha : undefined;
    }

    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), `oh-snap-${h.runId}-`));
    copyDirectoryRecursive(h.workspacePath, backupDir);
    const snapId = `snap_${this.id}_${h.runId}_${Date.now()}`;
    snapshotStore.set(snapId, {
      workspaceBackupDir: backupDir,
      sha,
      createdAt: Date.now(),
    });
    h.status = "snapshotted";

    return {
      id: snapId,
      providerId: this.id,
      runId: h.runId,
      sessionId: h.sessionId,
      createdAt: Date.now(),
      metadata: { sha },
    };
  }

  async restore(ref: SnapshotRef, spec: SandboxSpec): Promise<SandboxHandle> {
    const snap = snapshotStore.get(ref.id);
    const handle = await this.create(spec);
    if (snap && fs.existsSync(snap.workspaceBackupDir)) {
      copyDirectoryRecursive(snap.workspaceBackupDir, handle.workspacePath);
    }
    return handle;
  }

  async destroy(h: SandboxHandle): Promise<void> {
    const daemon = activeDaemons.get(h.id);
    if (daemon) {
      await daemon.close();
      activeDaemons.delete(h.id);
    }
    h.status = "destroyed";
  }

  async health(h?: SandboxHandle): Promise<HealthReport> {
    if (this.id === "srt-local" && process.platform === "win32") {
      return {
        ok: false,
        providerId: this.id,
        status: "unavailable",
        osEnforced: false,
        detail: "Windows srt backend not provisioned",
        checkedAt: Date.now(),
      };
    }
    if (h) {
      const daemon = activeDaemons.get(h.id);
      if (!daemon) {
        return {
          ok: false,
          providerId: this.id,
          status: "stopped",
          osEnforced: true,
          checkedAt: Date.now(),
        };
      }
      const res = await daemon.handleRequest("GET", "/health", {});
      return {
        ok: res.status === 200,
        providerId: this.id,
        status: h.status,
        osEnforced: true,
        checkedAt: Date.now(),
      };
    }
    return {
      ok: true,
      providerId: this.id,
      status: "ready",
      osEnforced: true,
      checkedAt: Date.now(),
    };
  }
}

function copyDirectoryRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Brokered host-side secret execution so secrets never enter the sandbox environment or files (§5 C.5).
 */
export class HostSecretBroker {
  private secrets = new Map<string, string>();

  constructor(initialSecrets?: Record<string, string>) {
    for (const [k, v] of Object.entries(initialSecrets ?? {})) {
      this.secrets.set(k, v);
    }
  }

  setSecret(name: string, value: string): void {
    this.secrets.set(name, value);
  }

  getSecretValues(): string[] {
    return Array.from(this.secrets.values());
  }

  /**
   * Injects configured secret headers for explicitly allowlisted API domains at the egress proxy boundary (§5 C.5).
   */
  injectHeadersForDomain(
    policy: SandboxSpec["policy"],
    targetUrl: string,
    existingHeaders: Record<string, string> = {}
  ): Record<string, string> {
    const host = new URL(targetUrl).hostname.toLowerCase();
    const out = { ...existingHeaders };
    for (const rule of policy.network.headerInjectionRules) {
      if (rule.domain.toLowerCase() === host) {
        const secretVal = this.secrets.get(rule.secretRef);
        if (secretVal) {
          out[rule.headerName] = secretVal;
        }
      }
    }
    return out;
  }
}
