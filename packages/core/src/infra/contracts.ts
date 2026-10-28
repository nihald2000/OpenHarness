/**
 * Infrastructure seams shared by the local and distributed harnesses.
 * Generic document types keep this package independent of the public SDK
 * while adapters can store the current protocol documents unchanged.
 */
export interface StateStore<Session, Message, Part, Event, Rule = unknown> {
  tx<T>(fn: (tx: StateStore<Session, Message, Part, Event, Rule>) => Promise<T>): Promise<T>;
  putSession(tenantId: string, session: Session): Promise<void>;
  getSession(tenantId: string, sessionId: string): Promise<Session | undefined>;
  listSessions(input: { tenantId: string; ownerId?: string; limit: number; cursor?: string }): Promise<Session[]>;
  childSessions(tenantId: string, parentSessionId: string): Promise<Session[]>;
  deleteSession(tenantId: string, sessionId: string): Promise<boolean>;
  putMessage(tenantId: string, sessionId: string, message: Message): Promise<void>;
  putPart(tenantId: string, sessionId: string, messageId: string, part: Part): Promise<void>;
  putParts(tenantId: string, sessionId: string, messageId: string, parts: Part[]): Promise<void>;
  getMessages(tenantId: string, sessionId: string): Promise<Message[]>;
  appendEvents(tenantId: string, sessionId: string, events: Event[]): Promise<number[]>;
  listEvents(tenantId: string, sessionId: string, afterSeq: number, limit: number): Promise<Array<{ seq: number; event: Event }>>;
  lastSeq(tenantId: string, sessionId: string): Promise<number>;
  pruneEvents(olderThan: number): Promise<number>;
  addRule(tenantId: string, sessionId: string | null, rule: Rule): Promise<void>;
  listRules(tenantId: string, sessionId?: string): Promise<Rule[]>;
}

export interface EventEnvelope<Event = unknown> {
  tenantId: string;
  sessionId?: string;
  seq: number;
  at: number;
  data: Event;
}

export interface EventBus<Event = unknown> {
  publish(envelope: EventEnvelope<Event>): Promise<void>;
  publishDelta(envelope: EventEnvelope<Event>): void;
  subscribe(
    filter: { sessionId?: string; tenantId: string; userId?: string },
    listener: (envelope: EventEnvelope<Event>) => void,
  ): () => void;
}

export type JobStatus = "queued" | "leased" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type JobWaitReason = "approval" | "child" | "retry" | "quota";
export interface JobDocument<Input = unknown, Checkpoint = unknown, Result = unknown> {
  id: string;
  tenantId: string;
  sessionId: string;
  rootSessionId: string;
  parentJobId?: string;
  kind: "run" | "resume" | "compact" | "verify" | "subagent";
  status: JobStatus;
  waitReason?: JobWaitReason;
  priority: number;
  attempt: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseUntil?: number;
  fence: number;
  input: Input;
  checkpoint?: Checkpoint;
  result?: Result;
  error?: string;
  cancelRequestedAt?: number;
  idempotencyKey?: string;
  notBefore: number;
  createdAt: number;
  updatedAt: number;
}

export interface JobQueue<Job extends JobDocument = JobDocument> {
  enqueue(job: Omit<Job, "status" | "attempt" | "fence">, options?: { tx?: unknown }): Promise<Job>;
  claim(workerId: string, kinds: Job["kind"][], limit: number): Promise<Job[]>;
  heartbeat(jobIds: string[], workerId: string): Promise<{ lost: string[] }>;
  checkpoint(jobId: string, workerId: string, fence: number, value: NonNullable<Job["checkpoint"]>): Promise<void>;
  complete(jobId: string, workerId: string, fence: number, result?: Job["result"]): Promise<void>;
  fail(jobId: string, workerId: string, fence: number, error: string): Promise<void>;
  wait(jobId: string, workerId: string, fence: number, reason: JobWaitReason, wakeAt?: number): Promise<void>;
  requestCancel(jobId: string): Promise<boolean>;
  resume(jobId: string, input?: Partial<Job["input"]>): Promise<boolean>;
}

export interface CancelBus {
  request(sessionId: string): Promise<void>;
  onCancel(sessionId: string, listener: () => void): () => void;
}

export interface LockService {
  withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
  tryLeader(name: string, fn: () => Promise<void>): Promise<boolean>;
}

export interface RateLimiter {
  consume(key: string, input: { capacity: number; refillPerSecond: number; cost?: number }): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }>;
}

export interface QuotaService {
  acquireRunSlot(tenantId: string, userId: string, limits: { tenant?: number; user?: number }): Promise<boolean>;
  releaseRunSlot(tenantId: string, userId: string): Promise<void>;
}

export interface SecretVault {
  get(tenantId: string | null, name: string): Promise<string | undefined>;
  set(tenantId: string | null, name: string, value: string): Promise<void>;
  delete(tenantId: string | null, name: string): Promise<boolean>;
  list(tenantId: string | null): Promise<Array<{ name: string; updatedAt: number }>>;
}

export interface ConfigRepo<Config = unknown> {
  get(tenantId: string | null): Promise<{ version: number; config: Config }>;
  put(tenantId: string | null, expectedVersion: number, config: Config, author?: string): Promise<number>;
}

export interface RuntimeBackend {
  exec(input: { sessionId: string; command: string; args: string[]; timeoutMs: number; signal?: AbortSignal }): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  readFile(input: { sessionId: string; path: string; maxBytes: number }): Promise<Uint8Array>;
  writeFile(input: { sessionId: string; path: string; content: Uint8Array }): Promise<void>;
}
