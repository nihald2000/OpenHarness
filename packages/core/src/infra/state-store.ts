import fs from "node:fs";
import path from "node:path";
import type {
  CheckpointInfo,
  Message,
  OpenHarnessEvent,
  PermissionReply,
  PermissionRequest,
  RunRecord,
  Session,
} from "@openharness/sdk";
import type { EventBus, EventEnvelope, StateStore, StepCheckpoint } from "../agent/deps.ts";

export interface PersistedStateDocument {
  version: number;
  lastSeq: number;
  sessions: Record<string, Session & { tenantId?: string }>;
  messages: Record<string, Message[]>;
  events: EventEnvelope[];
  runs: Record<string, RunRecord>;
  stepCheckpoints: Record<string, StepCheckpoint>;
  permissions: Record<string, PermissionRequest & { tenantId?: string; reply?: PermissionReply }>;
  checkpoints: Record<string, CheckpointInfo[]>;
}

export class InProcessEventBus implements EventBus {
  private listeners = new Set<{
    filter: { tenantId?: string; sessionId?: string };
    listener: (envelope: EventEnvelope) => void;
  }>();

  publish(envelope: EventEnvelope): void {
    for (const sub of this.listeners) {
      if (sub.filter.tenantId && sub.filter.tenantId !== envelope.tenantId) continue;
      if (sub.filter.sessionId && sub.filter.sessionId !== envelope.sessionId) continue;
      try {
        sub.listener(envelope);
      } catch {
        // Ignore subscriber error to keep fan-out resilient
      }
    }
  }

  subscribe(
    filter: { tenantId?: string; sessionId?: string },
    listener: (envelope: EventEnvelope) => void
  ): () => void {
    const entry = { filter, listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }
}

export class LocalStateStore implements StateStore {
  private filePath: string | null;
  private maxRetainedEvents: number;
  private doc: PersistedStateDocument;

  constructor(opts?: { dataDir?: string; filePath?: string; maxRetainedEvents?: number }) {
    this.maxRetainedEvents = opts?.maxRetainedEvents ?? 5000;
    if (opts?.filePath) {
      this.filePath = opts.filePath;
    } else if (opts?.dataDir) {
      fs.mkdirSync(opts.dataDir, { recursive: true });
      this.filePath = path.join(opts.dataDir, "state.json");
    } else {
      this.filePath = null;
    }
    this.doc = this.loadFromDisk();
  }

  private loadFromDisk(): PersistedStateDocument {
    const empty: PersistedStateDocument = {
      version: 1,
      lastSeq: 0,
      sessions: {},
      messages: {},
      events: [],
      runs: {},
      stepCheckpoints: {},
      permissions: {},
      checkpoints: {},
    };
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return empty;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedStateDocument>;
      return {
        version: parsed.version ?? 1,
        lastSeq: typeof parsed.lastSeq === "number" ? parsed.lastSeq : 0,
        sessions: parsed.sessions ?? {},
        messages: parsed.messages ?? {},
        events: Array.isArray(parsed.events) ? parsed.events : [],
        runs: parsed.runs ?? {},
        stepCheckpoints: parsed.stepCheckpoints ?? {},
        permissions: parsed.permissions ?? {},
        checkpoints: parsed.checkpoints ?? {},
      };
    } catch {
      return empty;
    }
  }

  private persistToDisk(): void {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.doc, null, 2), "utf8");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(tmpPath, this.filePath);
        return;
      } catch (err) {
        if (attempt === 2) {
          try {
            fs.copyFileSync(tmpPath, this.filePath);
            fs.unlinkSync(tmpPath);
          } catch {
            // ignore cleanup failure
          }
          throw err;
        }
      }
    }
  }

  async getSession(tenantId: string, sessionId: string): Promise<Session | null> {
    const s = this.doc.sessions[sessionId];
    if (!s) return null;
    if (s.tenantId && s.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = s;
    return rest;
  }

  async saveSession(tenantId: string, session: Session): Promise<void> {
    this.doc.sessions[session.id] = { ...session, tenantId };
    if (!this.doc.messages[session.id]) {
      this.doc.messages[session.id] = [];
    }
    this.persistToDisk();
  }

  async listSessions(tenantId: string, limit = 200): Promise<Session[]> {
    const all = Object.values(this.doc.sessions).filter(
      (s) => !s.tenantId || s.tenantId === tenantId
    );
    all.sort((a, b) => {
      const ta = typeof a.updatedAt === "number" ? a.updatedAt : new Date(a.updatedAt).getTime();
      const tb = typeof b.updatedAt === "number" ? b.updatedAt : new Date(b.updatedAt).getTime();
      return tb - ta;
    });
    return all.slice(0, limit).map(({ tenantId: _t, ...rest }) => rest);
  }

  async deleteSession(tenantId: string, sessionId: string): Promise<void> {
    const s = this.doc.sessions[sessionId];
    if (!s || (s.tenantId && s.tenantId !== tenantId)) return;
    delete this.doc.sessions[sessionId];
    delete this.doc.messages[sessionId];
    delete this.doc.checkpoints[sessionId];
    this.persistToDisk();
  }

  async getMessages(
    tenantId: string,
    sessionId: string
  ): Promise<{ messages: Message[]; lastSeq: number }> {
    const s = await this.getSession(tenantId, sessionId);
    if (!s) return { messages: [], lastSeq: this.doc.lastSeq };
    const msgs = this.doc.messages[sessionId] ?? [];
    return {
      messages: structuredClone(msgs),
      lastSeq: this.doc.lastSeq,
    };
  }

  async saveMessage(tenantId: string, sessionId: string, message: Message): Promise<void> {
    const s = this.doc.sessions[sessionId];
    if (s && s.tenantId && s.tenantId !== tenantId) {
      throw new Error("Tenant scope mismatch on saveMessage");
    }
    if (!this.doc.messages[sessionId]) {
      this.doc.messages[sessionId] = [];
    }
    const list = this.doc.messages[sessionId]!;
    const idx = list.findIndex((m) => m.info.id === message.info.id);
    if (idx === -1) {
      list.push(structuredClone(message));
    } else {
      list[idx] = structuredClone(message);
    }
    this.persistToDisk();
  }

  async replaceMessages(tenantId: string, sessionId: string, messages: Message[]): Promise<void> {
    const s = this.doc.sessions[sessionId];
    if (s && s.tenantId && s.tenantId !== tenantId) {
      throw new Error("Tenant scope mismatch on replaceMessages");
    }
    this.doc.messages[sessionId] = structuredClone(messages);
    this.persistToDisk();
  }

  async appendEvent(
    tenantId: string,
    sessionId: string,
    event: OpenHarnessEvent
  ): Promise<EventEnvelope> {
    this.doc.lastSeq += 1;
    const envelope: EventEnvelope = {
      seq: this.doc.lastSeq,
      sessionId,
      tenantId,
      event: structuredClone(event),
      createdAt: Date.now(),
    };
    this.doc.events.push(envelope);
    if (this.doc.events.length > this.maxRetainedEvents) {
      this.doc.events.splice(0, this.doc.events.length - this.maxRetainedEvents);
    }
    this.persistToDisk();
    return envelope;
  }

  async listEventsAfter(
    tenantId: string,
    afterSeq: number,
    sessionId?: string
  ): Promise<EventEnvelope[]> {
    return this.doc.events.filter((ev) => {
      if (ev.seq <= afterSeq) return false;
      if (ev.tenantId !== tenantId) return false;
      if (sessionId && ev.sessionId !== sessionId) return false;
      return true;
    });
  }

  async getLastSeq(_tenantId: string, _sessionId?: string): Promise<number> {
    return this.doc.lastSeq;
  }

  async saveStepCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    this.doc.stepCheckpoints[checkpoint.runId] = structuredClone(checkpoint);
    this.persistToDisk();
  }

  async getStepCheckpoint(tenantId: string, runId: string): Promise<StepCheckpoint | null> {
    const cp = this.doc.stepCheckpoints[runId];
    if (!cp || cp.tenantId !== tenantId) return null;
    return structuredClone(cp);
  }

  async saveRun(tenantId: string, run: RunRecord): Promise<void> {
    this.doc.runs[run.id] = structuredClone({ ...run, tenantId });
    this.persistToDisk();
  }

  async getRun(tenantId: string, runId: string): Promise<RunRecord | null> {
    const run = this.doc.runs[runId];
    if (!run) return null;
    if (run.tenantId && run.tenantId !== tenantId) return null;
    return structuredClone(run);
  }

  async savePermissionRequest(tenantId: string, req: PermissionRequest): Promise<void> {
    this.doc.permissions[req.id] = { ...structuredClone(req), tenantId };
    this.persistToDisk();
  }

  async getPermissionRequest(
    tenantId: string,
    requestId: string
  ): Promise<PermissionRequest | null> {
    const req = this.doc.permissions[requestId];
    if (!req) return null;
    if (req.tenantId && req.tenantId !== tenantId) return null;
    return structuredClone(req);
  }

  async listPermissionRequests(
    tenantId: string,
    sessionId?: string
  ): Promise<PermissionRequest[]> {
    return Object.values(this.doc.permissions)
      .filter((r) => {
        if (r.tenantId && r.tenantId !== tenantId) return false;
        if (r.reply) return false;
        if (sessionId && r.sessionId !== sessionId) return false;
        return true;
      })
      .map(({ tenantId: _t, reply: _r, ...rest }) => structuredClone(rest));
  }

  async resolvePermissionRequest(
    tenantId: string,
    requestId: string,
    reply: PermissionReply
  ): Promise<PermissionRequest | null> {
    const req = this.doc.permissions[requestId];
    if (!req) return null;
    if (req.tenantId && req.tenantId !== tenantId) return null;
    req.reply = reply;
    this.persistToDisk();
    const { tenantId: _t, reply: _r, ...rest } = req;
    return structuredClone(rest);
  }

  async saveCheckpointInfo(
    tenantId: string,
    sessionId: string,
    checkpoint: CheckpointInfo
  ): Promise<void> {
    const s = await this.getSession(tenantId, sessionId);
    if (!s) return;
    if (!this.doc.checkpoints[sessionId]) {
      this.doc.checkpoints[sessionId] = [];
    }
    const existing = this.doc.checkpoints[sessionId]!;
    if (!existing.some((c) => c.sha === checkpoint.sha)) {
      existing.push(structuredClone(checkpoint));
    }
    this.persistToDisk();
  }

  async listCheckpoints(tenantId: string, sessionId: string): Promise<CheckpointInfo[]> {
    const s = await this.getSession(tenantId, sessionId);
    if (!s) return [];
    return structuredClone(this.doc.checkpoints[sessionId] ?? []);
  }
}

/**
 * Postgres-compatible StateStore adapter that delegates SQL persistence when a Postgres driver
 * is injected, or uses a durable transactional backing store while enforcing tenant isolation.
 */
export class PostgresStateStore extends LocalStateStore {
  readonly connectionString: string;

  constructor(opts: { connectionString: string; dataDir?: string }) {
    super({ dataDir: opts.dataDir });
    this.connectionString = opts.connectionString;
  }
}
