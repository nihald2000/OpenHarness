export type ModalCreateParams = {
  imageId: string;
  command: string[];
  env: Record<string, string>;
  workdir: string;
  cpu: number;
  cpuLimit?: number;
  memoryMiB: number;
  memoryLimitMiB?: number;
  timeoutMs: number;
  idleTimeoutMs?: number;
  runtime: "vm" | "gvisor";
  encryptedPorts: number[];
  tags: Record<string, string>;
  inboundCidrAllowlist?: string[];
  readinessPort?: number;
  h2Ports?: number[];
  blockNetwork?: boolean;
  outboundDomainAllowlist?: string[];
  outboundCidrAllowlist?: string[];
};

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

export interface ModalSandboxRef {
  readonly id: string;
  poll(): Promise<number | null>;
  exec(cmd: string[], o?: { timeoutMs?: number; workdir?: string }): Promise<ExecResult>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  connectToken(port: number, meta: Record<string, string>): Promise<{ url: string; token: string }>;
  tunnels(): Promise<Record<number, string>>;
  snapshotFilesystem(ttlMs: number | null): Promise<string>;
  terminate(): Promise<void>;
  waitUntilReady?(timeoutMs?: number): Promise<void>;
  readStartupLogs?(): Promise<{ stdout: string; stderr: string }>;
}

export interface ModalApi {
  create(p: ModalCreateParams): Promise<ModalSandboxRef>;
  fromId(id: string): Promise<ModalSandboxRef>;
  list(tags: Record<string, string>): AsyncIterable<ModalSandboxRef>;
}
