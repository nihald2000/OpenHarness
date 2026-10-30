import type { CompiledSandboxPolicy } from "./policy.ts";
import type { DaemonTransport } from "./transport.ts";

export type SandboxProviderId = "local" | "srt-local" | "docker" | "modal";

export interface SandboxCapabilities {
  osEnforced: boolean;
  network: "none" | "allowlist" | "open";
  snapshots: boolean;
  ports: boolean;
  browser: boolean;
  persistentShell: boolean;
}

export interface WorkspaceSource {
  type?: "bind" | "git" | "snapshot";
  kind?: "local" | "git" | "snapshot";
  hostPath?: string;
  path?: string;
  gitUrl?: string;
  gitRef?: string;
  snapshotId?: string;
  imageId?: string;
}

export interface SandboxResourceLimits {
  cpuCores?: number;
  memoryMb?: number;
  diskMb?: number;
  timeoutSec?: number;
  idleTimeoutSec?: number;
}

export interface SandboxSpec {
  runId: string;
  sessionId: string;
  tenantId?: string;
  providerId?: SandboxProviderId;
  toolchain?: "node-python" | "full" | "minimal" | string;
  workspace: WorkspaceSource;
  limits?: SandboxResourceLimits;
  policy: CompiledSandboxPolicy;
  setupCommands?: string[];
  exposedPorts?: number[];
  allowUnsandboxedAutonomy?: boolean;
}

export interface SandboxHandle {
  id: string;
  providerId: SandboxProviderId;
  runId: string;
  sessionId: string;
  agentServerUrl: string;
  sessionKey: string;
  workspacePath: string;
  memoriesPath: string;
  tmpPath: string;
  shadowGitDir: string;
  status: "running" | "paused" | "snapshotted" | "destroyed";
  ports: Record<number, string>;
  policy: CompiledSandboxPolicy;
  snapshotId?: string;
  transport?: DaemonTransport;
}

export interface SnapshotRef {
  id: string;
  providerId: SandboxProviderId;
  runId: string;
  sessionId: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface HealthReport {
  ok: boolean;
  providerId: SandboxProviderId;
  status: string;
  osEnforced: boolean;
  detail?: string;
  checkedAt: number;
}

export interface SandboxProvider {
  id: SandboxProviderId;
  capabilities: SandboxCapabilities;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  pause(h: SandboxHandle): Promise<void>;
  resume(h: SandboxHandle): Promise<void>;
  snapshot(h: SandboxHandle): Promise<SnapshotRef>;
  restore(ref: SnapshotRef, spec: SandboxSpec): Promise<SandboxHandle>;
  destroy(h: SandboxHandle): Promise<void>;
  health(h?: SandboxHandle): Promise<HealthReport>;
}
