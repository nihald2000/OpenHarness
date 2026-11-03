import fs from "node:fs";
import path from "node:path";
import type {
  CheckpointInfo,
  Message,
  OpenHarnessEvent,
  PermissionReply,
  PermissionRequest,
  RunRecord,
  ScheduleRecord,
  Session,
} from "@openharness/sdk";
import type { EventBus, EventEnvelope, StateStore, StepCheckpoint } from "../agent/deps.ts";
import { atomicWriteFileSync } from "../util/atomic-write.ts";

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
  schedules?: Record<string, ScheduleRecord & { tenantId?: string }>;
  sandboxes?: Record<string, any>;
  envImages?: Record<string, { imageId: string; expiresAt: number }>;
  tenantSettings?: Record<string, Record<string, unknown>>;
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
  private eventsFilePath: string | null;
  private maxRetainedEvents: number;
  private doc: PersistedStateDocument;
  private lastSnapshotWriteMs = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotThrottleMs: number;

  constructor(opts?: {
    dataDir?: string;
    filePath?: string;
    maxRetainedEvents?: number;
    snapshotThrottleMs?: number;
  }) {
    this.maxRetainedEvents = opts?.maxRetainedEvents ?? 5000;
    this.snapshotThrottleMs = opts?.snapshotThrottleMs ?? 250;
    if (opts?.filePath) {
      this.filePath = opts.filePath;
      this.eventsFilePath = path.join(path.dirname(opts.filePath), "events.jsonl");
    } else if (opts?.dataDir) {
      fs.mkdirSync(opts.dataDir, { recursive: true });
      this.filePath = path.join(opts.dataDir, "state.json");
      this.eventsFilePath = path.join(opts.dataDir, "events.jsonl");
    } else {
      this.filePath = null;
      this.eventsFilePath = null;
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
      schedules: {},
      sandboxes: {},
      envImages: {},
      tenantSettings: {},
    };
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(raw) as Partial<PersistedStateDocument>;
        empty.version = parsed.version ?? 1;
        empty.lastSeq = typeof parsed.lastSeq === "number" ? parsed.lastSeq : 0;
        empty.sessions = parsed.sessions ?? {};
        empty.messages = parsed.messages ?? {};
        empty.events = Array.isArray(parsed.events) ? parsed.events : [];
        empty.runs = parsed.runs ?? {};
        empty.stepCheckpoints = parsed.stepCheckpoints ?? {};
        empty.permissions = parsed.permissions ?? {};
        empty.checkpoints = parsed.checkpoints ?? {};
        empty.schedules = parsed.schedules ?? {};
        empty.sandboxes = parsed.sandboxes ?? {};
        empty.envImages = parsed.envImages ?? {};
        empty.tenantSettings = parsed.tenantSettings ?? {};
      } catch {
        // ignore corrupt state snapshot and recover from events.jsonl if present
      }
    }
    if (this.eventsFilePath && fs.existsSync(this.eventsFilePath)) {
      try {
        const lines = fs.readFileSync(this.eventsFilePath, "utf8").split("\n");
        const seenSeq = new Set(empty.events.map((e) => e.seq));
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as EventEnvelope;
          if (!seenSeq.has(ev.seq)) {
            empty.events.push(ev);
            seenSeq.add(ev.seq);
          }
          if (ev.seq > empty.lastSeq) empty.lastSeq = ev.seq;
        }
        empty.events.sort((a, b) => a.seq - b.seq);
        if (empty.events.length > this.maxRetainedEvents) {
          empty.events.splice(0, empty.events.length - this.maxRetainedEvents);
        }
      } catch {
        // ignore trailing partial line
      }
    }
    return empty;
  }

  flush(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (!this.filePath) return;
    atomicWriteFileSync(this.filePath, JSON.stringify(this.doc));
    this.lastSnapshotWriteMs = Date.now();
  }

  close(): void {
    this.flush();
  }

  private persistToDisk(immediate = false): void {
    if (!this.filePath) return;
    const now = Date.now();
    if (immediate || now - this.lastSnapshotWriteMs >= this.snapshotThrottleMs) {
      this.flush();
      return;
    }
    if (!this.pendingTimer) {
      const waitMs = Math.max(10, this.snapshotThrottleMs - (now - this.lastSnapshotWriteMs));
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.flush();
      }, waitMs);
      this.pendingTimer.unref?.();
    }
  }

  async getTenantSetting(tenantId: string, key: string): Promise<unknown | null> {
    if (!tenantId || !key) return null;
    return this.doc.tenantSettings?.[tenantId]?.[key] ?? null;
  }

  async setTenantSetting(tenantId: string, key: string, value: unknown): Promise<void> {
    if (!tenantId || !key) throw new Error("Tenant ID and setting key are required");
    this.doc.tenantSettings ??= {};
    this.doc.tenantSettings[tenantId] ??= {};
    this.doc.tenantSettings[tenantId]![key] = value;
    this.persistToDisk(true);
  }

  async deleteTenantSetting(tenantId: string, key: string): Promise<void> {
    if (!tenantId || !key) return;
    const settings = this.doc.tenantSettings?.[tenantId];
    if (!settings || !(key in settings)) return;
    delete settings[key];
    if (Object.keys(settings).length === 0) delete this.doc.tenantSettings![tenantId];
    this.persistToDisk(true);
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
    this.persistToDisk(true);
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
    this.persistToDisk(true);
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
    if (this.eventsFilePath) {
      fs.mkdirSync(path.dirname(this.eventsFilePath), { recursive: true });
      fs.appendFileSync(this.eventsFilePath, `${JSON.stringify(envelope)}\n`, "utf8");
    }
    this.persistToDisk(false);
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
    this.persistToDisk(true);
  }

  async getStepCheckpoint(tenantId: string, runId: string): Promise<StepCheckpoint | null> {
    const cp = this.doc.stepCheckpoints[runId];
    if (!cp || cp.tenantId !== tenantId) return null;
    return structuredClone(cp);
  }

  async saveRun(tenantId: string, run: RunRecord): Promise<void> {
    this.doc.runs[run.id] = structuredClone({ ...run, tenantId });
    this.persistToDisk(true);
  }

  async getRun(tenantId: string, runId: string): Promise<RunRecord | null> {
    const run = this.doc.runs[runId];
    if (!run) return null;
    if (run.tenantId && run.tenantId !== tenantId) return null;
    return structuredClone(run);
  }

  async listRuns(tenantId: string): Promise<RunRecord[]> {
    return Object.values(this.doc.runs)
      .filter((run) => !run.tenantId || run.tenantId === tenantId)
      .map((run) => structuredClone(run));
  }

  async saveSchedule(tenantId: string, schedule: ScheduleRecord): Promise<void> {
    this.doc.schedules ??= {};
    this.doc.schedules[`${tenantId}:${schedule.id}`] = structuredClone({ ...schedule, tenantId });
    this.persistToDisk(true);
  }

  async getSchedule(tenantId: string, id: string): Promise<ScheduleRecord | null> {
    const record = this.doc.schedules?.[`${tenantId}:${id}`];
    if (!record) return null;
    const { tenantId: _tenantId, ...schedule } = record;
    return structuredClone(schedule);
  }

  async listSchedules(tenantId: string): Promise<ScheduleRecord[]> {
    return Object.values(this.doc.schedules ?? {})
      .filter((record) => record.tenantId === tenantId)
      .map(({ tenantId: _tenantId, ...schedule }) => structuredClone(schedule));
  }

  async deleteSchedule(tenantId: string, id: string): Promise<void> {
    delete this.doc.schedules?.[`${tenantId}:${id}`];
    this.persistToDisk(true);
  }

  async savePermissionRequest(tenantId: string, req: PermissionRequest): Promise<void> {
    this.doc.permissions[req.id] = { ...structuredClone(req), tenantId };
    this.persistToDisk(true);
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
    this.persistToDisk(true);
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
    this.persistToDisk(true);
  }

  async listCheckpoints(tenantId: string, sessionId: string): Promise<CheckpointInfo[]> {
    const s = await this.getSession(tenantId, sessionId);
    if (!s) return [];
    return structuredClone(this.doc.checkpoints[sessionId] ?? []);
  }
}
