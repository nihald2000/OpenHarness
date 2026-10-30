import fs from "node:fs";
import path from "node:path";
import type { CompiledSandboxPolicy } from "./policy.ts";
import type { SandboxProviderId } from "./contracts.ts";
import { atomicWriteFileSync } from "../util/atomic-write.ts";

export type SandboxRecord = {
  handleId: string;
  providerId: SandboxProviderId;
  tenantId: string;
  sessionId: string;
  runId: string;
  status: "setup" | "starting" | "running" | "paused" | "snapshotted" | "terminated";
  modalSandboxId?: string;
  imageId?: string;
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
  protected records = new Map<string, SandboxRecord>();
  protected envImages = new Map<string, { imageId: string; expiresAt: number }>();

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

export class FileSandboxRecordStore extends InMemorySandboxRecordStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    super();
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, "sandboxes.json");
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as {
        records?: SandboxRecord[];
        envImages?: Record<string, { imageId: string; expiresAt: number }>;
      };
      for (const r of parsed.records ?? []) {
        this.records.set(r.handleId, r);
      }
      for (const [k, v] of Object.entries(parsed.envImages ?? {})) {
        this.envImages.set(k, v);
      }
    } catch {
      // ignore corrupted cache on boot
    }
  }

  private flushToDisk(): void {
    const payload = {
      records: Array.from(this.records.values()),
      envImages: Object.fromEntries(this.envImages.entries()),
    };
    atomicWriteFileSync(this.filePath, JSON.stringify(payload, null, 2));
  }

  override async save(r: SandboxRecord): Promise<void> {
    await super.save(r);
    this.flushToDisk();
  }

  override async update(
    handleId: string,
    patch: Partial<SandboxRecord>
  ): Promise<SandboxRecord> {
    const updated = await super.update(handleId, patch);
    this.flushToDisk();
    return updated;
  }

  override async putEnvImage(
    key: string,
    v: { imageId: string; expiresAt: number }
  ): Promise<void> {
    await super.putEnvImage(key, v);
    this.flushToDisk();
  }
}
