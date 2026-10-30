import type { CompiledSandboxPolicy } from "./policy.ts";
import type { SandboxProviderId } from "./contracts.ts";

export type SandboxRecord = {
  handleId: string;
  providerId: SandboxProviderId;
  tenantId: string;
  sessionId: string;
  runId: string;
  status: "setup" | "starting" | "running" | "snapshotted" | "terminated";
  modalSandboxId?: string;
  imageId: string;
  lastSnapshotImageId?: string;
  sessionKeyEnc: string;
  cpu: number;
  memoryMiB: number;
  createdAt: number;
  timeoutMs: number;
  billedUntil: number;
  ports: Record<number, string>;
  policy: CompiledSandboxPolicy;
};

export interface SandboxRecordStore {
  save(r: SandboxRecord): Promise<void>;
  get(handleId: string): Promise<SandboxRecord | null>;
  update(handleId: string, patch: Partial<SandboxRecord>): Promise<SandboxRecord>;
  findModalId(id: string): Promise<SandboxRecord | null>;
  list(status?: string, tenantId?: string): Promise<SandboxRecord[]>;
  putEnvImage(key: string, v: { imageId: string; expiresAt: number }): Promise<void>;
  getEnvImage(key: string): Promise<{ imageId: string; expiresAt: number } | null>;
}

export class InMemorySandboxRecordStore implements SandboxRecordStore {
  private records = new Map<string, SandboxRecord>();
  private envImages = new Map<string, { imageId: string; expiresAt: number }>();

  async save(r: SandboxRecord): Promise<void> {
    this.records.set(r.handleId, structuredClone(r));
  }

  async get(handleId: string): Promise<SandboxRecord | null> {
    const rec = this.records.get(handleId);
    return rec ? structuredClone(rec) : null;
  }

  async update(
    handleId: string,
    patch: Partial<SandboxRecord>
  ): Promise<SandboxRecord> {
    const existing = this.records.get(handleId);
    if (!existing) throw new Error(`SandboxRecord not found: ${handleId}`);
    const updated: SandboxRecord = { ...existing, ...patch, handleId };
    this.records.set(handleId, structuredClone(updated));
    return structuredClone(updated);
  }

  async findModalId(id: string): Promise<SandboxRecord | null> {
    for (const r of this.records.values()) {
      if (r.modalSandboxId === id) return structuredClone(r);
    }
    return null;
  }

  async list(status?: string, tenantId?: string): Promise<SandboxRecord[]> {
    return Array.from(this.records.values())
      .filter((r) => {
        if (status && r.status !== status) return false;
        if (tenantId && r.tenantId !== tenantId) return false;
        return true;
      })
      .map((r) => structuredClone(r));
  }

  async putEnvImage(
    key: string,
    v: { imageId: string; expiresAt: number }
  ): Promise<void> {
    this.envImages.set(key, { ...v });
  }

  async getEnvImage(
    key: string
  ): Promise<{ imageId: string; expiresAt: number } | null> {
    const hit = this.envImages.get(key);
    return hit ? { ...hit } : null;
  }
}
