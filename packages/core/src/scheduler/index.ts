import type { RunMode, ScheduleInfo } from "@openharness/sdk";
import { wrapUntrustedContent } from "../security/risk.ts";

export interface EnqueuedScheduledRun {
  runId: string;
  scheduleId?: string;
  mode: RunMode;
  agent: string;
  prompt: string;
  tainted: boolean;
  taintSources: string[];
  startedAt: number;
}

/**
 * Scheduler & GitHub Issue-to-PR Workflow Manager (§10 Phase H).
 * Enforces per-schedule concurrency (default 1), workspace locking, run history,
 * and marks GitHub issue bodies as tainted untrusted input.
 */
export class ScheduleManager {
  private schedules = new Map<string, ScheduleInfo>();
  private activeCountBySchedule = new Map<string, number>();
  private workspaceLockedBySchedule = new Map<string, string>();
  private onEnqueueRun?: (req: EnqueuedScheduledRun) => Promise<{ runId: string; sessionId: string }>;

  constructor(opts?: {
    onEnqueueRun?: (req: EnqueuedScheduledRun) => Promise<{ runId: string; sessionId: string }>;
  }) {
    this.onEnqueueRun = opts?.onEnqueueRun;
  }

  list(): ScheduleInfo[] {
    return Array.from(this.schedules.values()).map((s) => structuredClone(s));
  }

  get(id: string): ScheduleInfo | null {
    const s = this.schedules.get(id);
    return s ? structuredClone(s) : null;
  }

  create(input: Omit<ScheduleInfo, "id" | "history"> & { id?: string }): ScheduleInfo {
    const id = input.id ?? `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const record: ScheduleInfo = {
      id,
      name: input.name,
      cron: input.cron,
      webhookSecret: input.webhookSecret,
      enabled: input.enabled ?? true,
      mode: input.mode ?? "task",
      agent: input.agent ?? "assistant",
      prompt: input.prompt,
      sandboxSpec: input.sandboxSpec,
      budget: input.budget,
      concurrency: input.concurrency ?? 1,
      history: [],
    };
    this.schedules.set(id, record);
    return structuredClone(record);
  }

  update(id: string, patch: Partial<ScheduleInfo>): ScheduleInfo | null {
    const existing = this.schedules.get(id);
    if (!existing) return null;
    const updated: ScheduleInfo = {
      ...existing,
      ...patch,
      id: existing.id,
    };
    this.schedules.set(id, updated);
    return structuredClone(updated);
  }

  delete(id: string): boolean {
    return this.schedules.delete(id);
  }

  /**
   * Triggers a schedule (via cron tick or webhook), enforcing concurrency limits (default 1) and workspace lock.
   */
  async triggerSchedule(
    id: string,
    workspaceKey = "default"
  ): Promise<{ triggered: boolean; runId?: string; reason?: string }> {
    const sched = this.schedules.get(id);
    if (!sched) return { triggered: false, reason: "Schedule not found" };
    if (!sched.enabled) return { triggered: false, reason: "Schedule is disabled" };

    const activeCount = this.activeCountBySchedule.get(id) ?? 0;
    if (activeCount >= sched.concurrency) {
      return {
        triggered: false,
        reason: `Schedule concurrency limit (${sched.concurrency}) reached`,
      };
    }

    const lockedBy = this.workspaceLockedBySchedule.get(workspaceKey);
    if (lockedBy && lockedBy !== id) {
      return {
        triggered: false,
        reason: `Workspace "${workspaceKey}" is currently locked by schedule "${lockedBy}"`,
      };
    }

    this.activeCountBySchedule.set(id, activeCount + 1);
    this.workspaceLockedBySchedule.set(workspaceKey, id);

    const now = Date.now();
    const runId = `run_${id}_${now}`;
    const sessionId = `sess_${id}_${now}`;

    if (this.onEnqueueRun) {
      await this.onEnqueueRun({
        runId,
        scheduleId: id,
        mode: sched.mode,
        agent: sched.agent,
        prompt: sched.prompt,
        tainted: false,
        taintSources: [],
        startedAt: now,
      });
    }

    sched.lastRunAt = now;
    if (!sched.history) sched.history = [];
    sched.history.unshift({
      runId,
      sessionId,
      startedAt: now,
      status: "running",
    });

    return { triggered: true, runId };
  }

  completeScheduledRun(id: string, runId: string, status: "completed" | "failed", workspaceKey = "default"): void {
    const active = this.activeCountBySchedule.get(id) ?? 0;
    this.activeCountBySchedule.set(id, Math.max(0, active - 1));
    if (this.workspaceLockedBySchedule.get(workspaceKey) === id) {
      this.workspaceLockedBySchedule.delete(workspaceKey);
    }
    const sched = this.schedules.get(id);
    const entry = sched?.history?.find((h) => h.runId === runId);
    if (entry) {
      entry.status = status;
    }
  }

  /**
   * GitHub issue -> sandbox clone -> task/long_task -> verification -> reviewer -> brokered github_pr workflow (§10 Phase H).
   * Marks the issue body as tainted input (`tainted: true`) so exfiltration guards apply.
   */
  async triggerGithubIssueWorkflow(issue: {
    repoUrl: string;
    issueNumber: number;
    title: string;
    body: string;
    mode?: RunMode;
  }): Promise<EnqueuedScheduledRun> {
    const provenance = `github_issue:${issue.repoUrl}#${issue.issueNumber}`;
    const delimitedBody = wrapUntrustedContent(
      `Issue #${issue.issueNumber}: ${issue.title}\n\n${issue.body}`,
      provenance
    );
    const prompt = [
      `Resolve GitHub Issue #${issue.issueNumber} in repository ${issue.repoUrl}.`,
      "Follow the Plan -> Build -> Test -> Fix -> Review loop, then create a pull request via brokered `github_pr`.",
      "",
      delimitedBody,
    ].join("\n");

    const runReq: EnqueuedScheduledRun = {
      runId: `run_gh_issue_${issue.issueNumber}_${Date.now()}`,
      mode: issue.mode ?? "task",
      agent: "assistant",
      prompt,
      tainted: true,
      taintSources: [provenance],
      startedAt: Date.now(),
    };

    if (this.onEnqueueRun) {
      await this.onEnqueueRun(runReq);
    }
    return runReq;
  }
}
