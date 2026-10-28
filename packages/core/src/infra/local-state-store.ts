import { localLockService } from "./in-process-lock-service.ts";
import type { StateStore } from "./contracts.ts";
import type { LocalDocumentStore } from "./json-document-store.ts";

type SessionDocument<Session> = { tenantId: string; ownerId?: string; parentId?: string; data: Session };
type EventDocument<Event> = { tenantId: string; seq: number; at: number; data: Event };
type RuleDocument<Rule> = { tenantId: string; sessionId: string | null; data: Rule };
export type LocalStateDocument<Session, Message, Event, Rule> = {
  sessions: Record<string, SessionDocument<Session>>;
  messages: Record<string, Message[]>;
  events: Record<string, EventDocument<Event>[]>;
  nextSeq: Record<string, number>;
  rules: RuleDocument<Rule>[];
};

function emptyState<Session, Message, Event, Rule>(): LocalStateDocument<Session, Message, Event, Rule> {
  return { sessions: {}, messages: {}, events: {}, nextSeq: {}, rules: [] };
}

/** Tenant-scoped JSON-backed StateStore for local mode and adapter contract tests. */
export class LocalStateStore<
  Session extends { id: string; updatedAt?: number; ownerId?: string; parentId?: string },
  Message extends { info: { id: string }; parts: Part[] },
  Part = unknown,
  Event = unknown,
  Rule = unknown,
> implements StateStore<Session, Message, Part, Event, Rule> {
  private state: LocalStateDocument<Session, Message, Event, Rule>;
  private readonly ready: Promise<void>;

  constructor(
    private readonly persistence: LocalDocumentStore<LocalStateDocument<Session, Message, Event, Rule>>,
    private readonly lockKey: string,
    private readonly transactional = false,
    initial?: LocalStateDocument<Session, Message, Event, Rule>,
  ) {
    this.state = initial ?? emptyState<Session, Message, Event, Rule>();
    this.ready = initial ? Promise.resolve() : persistence.load().then((value) => {
      this.state = { ...emptyState<Session, Message, Event, Rule>(), ...value };
    });
  }

  async tx<T>(fn: (tx: StateStore<Session, Message, Part, Event, Rule>) => Promise<T>): Promise<T> {
    if (this.transactional) return fn(this);
    await this.ready;
    return localLockService.withLock(this.lockKey, 30_000, async () => {
      const working = structuredClone(this.state);
      const txStore = new LocalStateStore<Session, Message, Part, Event, Rule>(this.persistence, this.lockKey, true, working);
      const result = await fn(txStore);
      await this.persistence.save(working);
      this.state = working;
      return result;
    });
  }

  private async read<T>(fn: (state: LocalStateDocument<Session, Message, Event, Rule>) => T): Promise<T> {
    await this.ready;
    return structuredClone(fn(this.state));
  }

  private async write<T>(fn: (state: LocalStateDocument<Session, Message, Event, Rule>) => T): Promise<T> {
    await this.ready;
    if (this.transactional) return fn(this.state);
    return localLockService.withLock(this.lockKey, 30_000, async () => {
      const working = structuredClone(this.state);
      const result = fn(working);
      await this.persistence.save(working);
      this.state = working;
      return structuredClone(result);
    });
  }

  async putSession(tenantId: string, session: Session): Promise<void> {
    await this.write((state) => {
      const current = state.sessions[session.id];
      if (current && current.tenantId !== tenantId) throw new Error("session belongs to another tenant");
      state.sessions[session.id] = { tenantId, ownerId: session.ownerId, parentId: session.parentId, data: structuredClone(session) };
    });
  }

  async getSession(tenantId: string, sessionId: string): Promise<Session | undefined> {
    return this.read((state) => state.sessions[sessionId]?.tenantId === tenantId ? state.sessions[sessionId]!.data : undefined);
  }

  async listSessions(input: { tenantId: string; ownerId?: string; limit: number; cursor?: string }): Promise<Session[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) throw new Error("limit must be an integer from 1 to 500");
    return this.read((state) => {
      const rows = Object.values(state.sessions).filter((row) => row.tenantId === input.tenantId && row.parentId === undefined && (!input.ownerId || row.ownerId === input.ownerId))
        .sort((a, b) => (b.data.updatedAt ?? 0) - (a.data.updatedAt ?? 0) || a.data.id.localeCompare(b.data.id));
      const start = input.cursor ? Math.max(0, rows.findIndex((row) => row.data.id === input.cursor) + 1) : 0;
      return rows.slice(start, start + input.limit).map((row) => row.data);
    });
  }

  async childSessions(tenantId: string, parentSessionId: string): Promise<Session[]> {
    return this.read((state) => Object.values(state.sessions).filter((row) => row.tenantId === tenantId && row.parentId === parentSessionId).map((row) => row.data));
  }

  async deleteSession(tenantId: string, sessionId: string): Promise<boolean> {
    return this.write((state) => {
      if (state.sessions[sessionId]?.tenantId !== tenantId) return false;
      delete state.sessions[sessionId]; delete state.messages[sessionId]; delete state.events[sessionId]; delete state.nextSeq[sessionId];
      state.rules = state.rules.filter((rule) => rule.tenantId !== tenantId || rule.sessionId !== sessionId);
      return true;
    });
  }

  async putMessage(tenantId: string, sessionId: string, message: Message): Promise<void> {
    await this.write((state) => {
      this.requireSession(state, tenantId, sessionId);
      const messages = state.messages[sessionId] ?? [];
      const index = messages.findIndex((item) => item.info.id === message.info.id);
      if (index < 0) messages.push(structuredClone(message)); else messages[index] = structuredClone(message);
      state.messages[sessionId] = messages;
    });
  }

  async putPart(tenantId: string, sessionId: string, messageId: string, part: Part): Promise<void> {
    await this.putParts(tenantId, sessionId, messageId, [part]);
  }

  async putParts(tenantId: string, sessionId: string, messageId: string, parts: Part[]): Promise<void> {
    await this.write((state) => {
      this.requireSession(state, tenantId, sessionId);
      const message = state.messages[sessionId]?.find((item) => item.info.id === messageId);
      if (!message) throw new Error("message not found");
      for (const part of parts) {
        const key = this.partKey(part);
        const index = message.parts.findIndex((existing) => this.partKey(existing) === key);
        if (index < 0) message.parts.push(structuredClone(part)); else message.parts[index] = structuredClone(part);
      }
    });
  }

  async getMessages(tenantId: string, sessionId: string): Promise<Message[]> {
    return this.read((state) => state.sessions[sessionId]?.tenantId === tenantId ? state.messages[sessionId] ?? [] : []);
  }

  async appendEvents(tenantId: string, sessionId: string, events: Event[]): Promise<number[]> {
    return this.write((state) => {
      this.requireSession(state, tenantId, sessionId);
      let seq = state.nextSeq[sessionId] ?? 1;
      const stored = state.events[sessionId] ?? [];
      const assigned = events.map((data) => {
        const current = seq++;
        stored.push({ tenantId, seq: current, at: Date.now(), data: structuredClone(data) });
        return current;
      });
      state.events[sessionId] = stored;
      state.nextSeq[sessionId] = seq;
      return assigned;
    });
  }

  async listEvents(tenantId: string, sessionId: string, afterSeq: number, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("event limit must be an integer from 1 to 10000");
    return this.read((state) => state.sessions[sessionId]?.tenantId === tenantId
      ? (state.events[sessionId] ?? []).filter((event) => event.seq > afterSeq).slice(0, limit).map(({ seq, data }) => ({ seq, event: data }))
      : []);
  }

  async lastSeq(tenantId: string, sessionId: string): Promise<number> {
    return this.read((state) => state.sessions[sessionId]?.tenantId === tenantId ? (state.nextSeq[sessionId] ?? 1) - 1 : 0);
  }

  async pruneEvents(olderThan: number): Promise<number> {
    return this.write((state) => {
      let removed = 0;
      for (const sessionId of Object.keys(state.events)) {
        const events = state.events[sessionId]!;
        state.events[sessionId] = events.filter((event) => { const keep = event.at >= olderThan; if (!keep) removed++; return keep; });
      }
      return removed;
    });
  }

  async addRule(tenantId: string, sessionId: string | null, rule: Rule): Promise<void> {
    await this.write((state) => { state.rules.push({ tenantId, sessionId, data: structuredClone(rule) }); });
  }

  async listRules(tenantId: string, sessionId?: string): Promise<Rule[]> {
    return this.read((state) => state.rules.filter((rule) => rule.tenantId === tenantId && (sessionId === undefined || rule.sessionId === null || rule.sessionId === sessionId)).map((rule) => rule.data));
  }

  private requireSession(state: LocalStateDocument<Session, Message, Event, Rule>, tenantId: string, sessionId: string) {
    if (state.sessions[sessionId]?.tenantId !== tenantId) throw new Error("session not found");
  }

  private partKey(part: Part): string {
    if (!part || typeof part !== "object") return `value:${String(part)}`;
    const value = part as Record<string, unknown>;
    if (typeof value.callId === "string") return `call:${value.callId}`;
    if (typeof value.id === "string") return `id:${value.id}`;
    if (value.type === "skill" && typeof value.name === "string") return `skill:${value.name}`;
    if (value.type === "verify" && typeof value.command === "string") return `verify:${value.command}:${String(value.iteration ?? 0)}`;
    if (value.type === "text") return "text";
    if (value.type === "step") return "step";
    if (value.type === "compaction") return "compaction";
    return `${String(value.type ?? "part")}:${JSON.stringify(value)}`;
  }
}
