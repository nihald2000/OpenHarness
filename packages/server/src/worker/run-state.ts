import fs from "node:fs";
import path from "node:path";
import type { RunStatus } from "@openharness/sdk";
import { atomicWriteFileSync, PROMPT_VERSION, type StateStore } from "@openharness/core";
import { HttpError } from "../server.ts";
import type { CreateRunInput, DurableRunRecord, FrozenRunSnapshot } from "./types.ts";

export const ALLOWED_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  idle: ["queued", "running", "cancelled"],
  queued: ["running", "cancelled", "failed"],
  running: ["awaiting_input", "awaiting_permission", "verifying", "completed", "failed", "cancelled"],
  awaiting_input: ["running", "cancelled", "failed"],
  awaiting_permission: ["running", "cancelled", "failed"],
  verifying: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export class RunStateMachine {
  private readonly runsDir: string;
  private readonly stateStore: StateStore;
  private readonly cache = new Map<string, DurableRunRecord>();
  private readonly turnDedupe = new Map<string, string>(); // `${sessionId}:${clientTurnId}` -> runId

  constructor(opts: { dataDir: string; stateStore: StateStore }) {
    this.runsDir = path.join(opts.dataDir, "runs-v2");
    this.stateStore = opts.stateStore;
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.runsDir)) return;
    for (const file of fs.readdirSync(this.runsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(
          fs.readFileSync(path.join(this.runsDir, file), "utf8")
        ) as DurableRunRecord;
        this.cache.set(rec.id, rec);
        if (rec.clientTurnId) {
          this.turnDedupe.set(`${rec.sessionId}:${rec.clientTurnId}`, rec.id);
        }
      } catch {
        // ignore corrupted file
      }
    }
  }

  private persist(rec: DurableRunRecord): void {
    this.cache.set(rec.id, rec);
    const file = path.join(this.runsDir, `${rec.id}.json`);
    atomicWriteFileSync(file, JSON.stringify(rec, null, 2));
  }

  async createRun(
    input: CreateRunInput
  ): Promise<{ run: DurableRunRecord; deduplicated: boolean }> {
    const tenantId = input.tenantId ?? "default";
    if (input.clientTurnId) {
      const existingId = this.turnDedupe.get(`${input.sessionId}:${input.clientTurnId}`);
      if (existingId && this.cache.has(existingId)) {
        return { run: structuredClone(this.cache.get(existingId)!), deduplicated: true };
      }
    }

    for (const existing of this.cache.values()) {
      if (
        existing.sessionId === input.sessionId &&
        !isTerminalRunStatus(existing.status)
      ) {
        throw new HttpError(
          409,
          `Session ${input.sessionId} already has an active run (${existing.id} in status ${existing.status})`
        );
      }
    }

    const now = Date.now();
    const runId =
      input.runId ?? `run_${now}_${Math.random().toString(36).slice(2, 8)}`;

    const snapshot: FrozenRunSnapshot = {
      model: input.model,
      promptVersion: PROMPT_VERSION,
      tools: input.tools ?? [],
      limits: {
        maxIterations: input.limits?.maxIterations ?? 40,
        maxFixAttempts: input.limits?.maxFixAttempts ?? Number(process.env.OH_MAX_FIX_ATTEMPTS ?? 5),
        maxQuestions: input.limits?.maxQuestions ?? 3,
        firstActivityTimeoutMs: input.limits?.firstActivityTimeoutMs ?? 45_000,
        toolTimeoutMs: input.limits?.toolTimeoutMs ?? 120_000,
        stallTimeoutMs: input.limits?.stallTimeoutMs ?? 180_000,
      },
    };

    const rec: DurableRunRecord = {
      id: runId,
      sessionId: input.sessionId,
      tenantId,
      prompt: input.prompt,
      agent: input.agent ?? "assistant",
      runtime: input.runtime,
      mode: input.mode ?? "task",
      status: "queued",
      phase: "planning",
      iteration: 0,
      maxIterations: snapshot.limits.maxIterations,
      startedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      clientTurnId: input.clientTurnId,
      snapshot,
      pendingQuestion: null,
      questionsAsked: 0,
      changedFiles: [],
      usage: { input: 0, output: 0 },
      cost: 0,
    };

    this.persist(rec);
    if (input.clientTurnId) {
      this.turnDedupe.set(`${input.sessionId}:${input.clientTurnId}`, runId);
    }

    await this.stateStore.saveRun(tenantId, rec);
    const session = await this.stateStore.getSession(tenantId, input.sessionId);
    if (session) {
      await this.stateStore.saveSession(tenantId, {
        ...session,
        status: "queued",
        phase: "planning",
        runId: rec.id,
        activeRunId: rec.id,
        updatedAt: now,
      });
    }

    return { run: structuredClone(rec), deduplicated: false };
  }

  /**
   * Compare-and-set state transition (H1).
   * If `expectedFrom` is an array or single status, verifies `current.status` matches before transitioning.
   */
  async transition(
    runId: string,
    expectedFrom: RunStatus | readonly RunStatus[],
    to: RunStatus,
    patch: Partial<DurableRunRecord> = {}
  ): Promise<{ ok: boolean; run: DurableRunRecord | null }> {
    const current = this.cache.get(runId);
    if (!current) return { ok: false, run: null };

    const fromList = Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom];
    if (!fromList.includes(current.status)) {
      return { ok: false, run: structuredClone(current) };
    }

    const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
    if (current.status !== to && !allowed.includes(to)) {
      return { ok: false, run: structuredClone(current) };
    }

    const now = Date.now();
    const updated: DurableRunRecord = {
      ...current,
      ...patch,
      status: to,
      updatedAt: now,
      lastHeartbeatAt: now,
      ...(isTerminalRunStatus(to) ? { completedAt: patch.completedAt ?? now } : {}),
    };

    this.persist(updated);
    const tenantId = updated.tenantId ?? "default";
    await this.stateStore.saveRun(tenantId, updated);

    const session = await this.stateStore.getSession(tenantId, updated.sessionId);
    if (session) {
      const isTerminal = isTerminalRunStatus(to);
      await this.stateStore.saveSession(tenantId, {
        ...session,
        status: isTerminal && to === "completed" ? "idle" : to,
        phase: updated.phase,
        runId: updated.id,
        activeRunId: isTerminal ? null : updated.id,
        error: updated.error,
        usage: updated.usage,
        cost: updated.cost,
        updatedAt: now,
      });
    }

    return { ok: true, run: structuredClone(updated) };
  }

  async heartbeat(runId: string, markFirstActivity = false): Promise<DurableRunRecord | null> {
    const current = this.cache.get(runId);
    if (!current) return null;
    const now = Date.now();
    current.lastHeartbeatAt = now;
    current.updatedAt = now;
    if (markFirstActivity && !current.firstActivityAt) {
      current.firstActivityAt = now;
    }
    this.persist(current);
    return structuredClone(current);
  }

  async updateRun(
    runId: string,
    patch: Partial<DurableRunRecord>
  ): Promise<DurableRunRecord | null> {
    const current = this.cache.get(runId);
    if (!current) return null;
    const updated: DurableRunRecord = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    };
    this.persist(updated);
    await this.stateStore.saveRun(updated.tenantId ?? "default", updated);
    return structuredClone(updated);
  }

  getRun(runId: string): DurableRunRecord | null {
    const rec = this.cache.get(runId);
    return rec ? structuredClone(rec) : null;
  }

  listRuns(sessionId?: string): DurableRunRecord[] {
    const all = Array.from(this.cache.values());
    return (sessionId ? all.filter((r) => r.sessionId === sessionId) : all)
      .map((r) => structuredClone(r))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  listActiveRuns(): DurableRunRecord[] {
    return Array.from(this.cache.values())
      .filter((r) => !isTerminalRunStatus(r.status))
      .map((r) => structuredClone(r));
  }
}
