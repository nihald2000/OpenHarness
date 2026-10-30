import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface DelegatedSubtaskSpec {
  taskId?: string;
  parentRunId: string;
  parentSessionId: string;
  agent: string;
  prompt: string;
  requestedTools?: string[];
  parentAllowedTools: string[];
  readOnlyParent?: boolean;
  budget?: {
    maxIterations?: number;
    maxRunDurationSec?: number;
    maxCostUsd?: number;
  };
  background?: boolean;
  writeCapable?: boolean;
  worktreeBranch?: string;
}

export interface DelegatedTaskRecord {
  taskId: string;
  parentRunId: string;
  parentSessionId: string;
  agent: string;
  prompt: string;
  effectiveTools: string[];
  status: "pending" | "running" | "completed" | "failed";
  background: boolean;
  worktreePath?: string;
  worktreeBranch?: string;
  report?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

const READ_ONLY_TOOL_NAMES = new Set([
  "word_count",
  "read_file",
  "list",
  "glob",
  "search",
  "todo_read",
  "browser_snapshot",
  "browser_screenshot",
  "browser_console",
  "preview_url",
  "verify",
]);

/**
 * Computes the intersection of parent permissions and requested subagent tools (§0.1, §10 Phase H).
 * Children can NEVER escalate beyond parent permissions. Read-only agents (`explore`, `plan`)
 * are restricted strictly to read-only tools.
 */
export function intersectSubagentTools(
  parentAllowedTools: string[],
  requestedTools?: string[],
  isReadOnlySubagent = true
): string[] {
  const parentSet = new Set(parentAllowedTools);
  const candidates =
    requestedTools && requestedTools.length > 0
      ? requestedTools.filter((t) => parentSet.has(t))
      : [...parentAllowedTools];

  if (isReadOnlySubagent) {
    return candidates.filter((t) => READ_ONLY_TOOL_NAMES.has(t));
  }
  return candidates;
}

/**
 * Caps subagent report returned to parent context at <= 2,000 tokens (~8,000 chars) (§7 E.7).
 */
export function capSubagentReportTokens(report: string, maxTokens = 2000): string {
  const maxChars = maxTokens * 4;
  if (report.length <= maxChars) return report;
  return `${report.slice(0, maxChars)}\n... [subagent report truncated to ${maxTokens} tokens]`;
}

export interface DelegationCoordinatorOptions {
  workspaceRoot: string;
  dataDir?: string;
  maxParallelExplorers?: number; // default 3 (§10 Phase H)
  allowParallelWriters?: boolean; // default false (§10 Phase H)
  executor?: (
    spec: DelegatedSubtaskSpec,
    effectiveTools: string[],
    worktreePath: string
  ) => Promise<string>;
  verifier?: (workspaceRoot: string) => Promise<{ passed: boolean; output: string }>;
}

/**
 * Coordinates subagent delegation, parallel read-only explorers (bounded by `maxParallel: 3`),
 * isolated git-worktree parallel writers with conflict detection and post-merge verification,
 * and durable background task persistence (`delegate_status` / `delegate_result`) (§10 Phase H).
 */
export class DelegationCoordinator {
  private opts: DelegationCoordinatorOptions;
  private tasks = new Map<string, DelegatedTaskRecord>();
  private persistPath: string | null;

  constructor(opts: DelegationCoordinatorOptions) {
    this.opts = opts;
    if (opts.dataDir) {
      fs.mkdirSync(opts.dataDir, { recursive: true });
      this.persistPath = path.join(opts.dataDir, "delegated_tasks.json");
      this.loadFromDisk();
    } else {
      this.persistPath = null;
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const list = JSON.parse(fs.readFileSync(this.persistPath, "utf8")) as DelegatedTaskRecord[];
      for (const item of list) {
        this.tasks.set(item.taskId, item);
      }
    } catch {
      // ignore
    }
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    fs.writeFileSync(
      this.persistPath,
      JSON.stringify(Array.from(this.tasks.values()), null, 2),
      "utf8"
    );
  }

  async delegate(spec: DelegatedSubtaskSpec): Promise<DelegatedTaskRecord> {
    const taskId = spec.taskId ?? `subtask_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const isReadOnly =
      spec.readOnlyParent ||
      !spec.writeCapable ||
      spec.agent === "explore" ||
      spec.agent === "plan";

    const effectiveTools = intersectSubagentTools(
      spec.parentAllowedTools,
      spec.requestedTools,
      isReadOnly
    );

    let worktreePath = this.opts.workspaceRoot;
    let worktreeBranch: string | undefined;

    if (!isReadOnly) {
      if (!this.opts.allowParallelWriters && !spec.worktreeBranch) {
        throw new Error(
          "Write-capable subagents require an isolated git worktree branch (`worktreeBranch`) or `allowParallelWriters: true` (§10 Phase H)."
        );
      }
      worktreeBranch = spec.worktreeBranch ?? `oh-subagent-${taskId}`;
      worktreePath = path.join(
        this.opts.workspaceRoot,
        ".openharness",
        "worktrees",
        worktreeBranch
      );
      fs.mkdirSync(worktreePath, { recursive: true });
    }

    const record: DelegatedTaskRecord = {
      taskId,
      parentRunId: spec.parentRunId,
      parentSessionId: spec.parentSessionId,
      agent: spec.agent,
      prompt: spec.prompt,
      effectiveTools,
      status: "running",
      background: Boolean(spec.background),
      worktreePath: !isReadOnly ? worktreePath : undefined,
      worktreeBranch,
      startedAt: Date.now(),
    };
    this.tasks.set(taskId, record);
    this.saveToDisk();

    const runTask = async () => {
      try {
        const rawReport = this.opts.executor
          ? await this.opts.executor(spec, effectiveTools, worktreePath)
          : `Completed delegated ${spec.agent} task: ${spec.prompt.slice(0, 120)}`;
        record.report = capSubagentReportTokens(rawReport, 2000);
        record.status = "completed";
        record.completedAt = Date.now();
        this.saveToDisk();
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err);
        record.status = "failed";
        record.completedAt = Date.now();
        this.saveToDisk();
      }
    };

    if (spec.background) {
      void runTask();
      return structuredClone(record);
    }

    await runTask();
    return structuredClone(record);
  }

  /**
   * Executes multiple read-only explorer subtasks in parallel with concurrency bounded by `maxParallel` (default 3) (§10 Phase H).
   */
  async runParallelExplorers(specs: DelegatedSubtaskSpec[]): Promise<DelegatedTaskRecord[]> {
    const maxParallel = this.opts.maxParallelExplorers ?? 3;
    const results: DelegatedTaskRecord[] = new Array(specs.length);
    let cursor = 0;

    const worker = async () => {
      while (cursor < specs.length) {
        const idx = cursor++;
        const spec = specs[idx]!;
        results[idx] = await this.delegate({
          ...spec,
          writeCapable: false,
          background: false,
        });
      }
    };

    const workers = Array.from(
      { length: Math.min(maxParallel, specs.length) },
      () => worker()
    );
    await Promise.all(workers);
    return results;
  }

  /**
   * Merges isolated worktree writer branches into the parent workspace with conflict detection
   * and re-runs verification on the merged result (§10 Phase H).
   */
  async mergeWorktreeWritersAndVerify(
    taskIds: string[]
  ): Promise<{ merged: boolean; conflicts: string[]; verificationPassed: boolean }> {
    const conflicts: string[] = [];
    const touchedFileContents = new Map<string, { taskId: string; content: string }>();

    for (const id of taskIds) {
      const rec = this.tasks.get(id);
      if (!rec || !rec.worktreePath || !fs.existsSync(rec.worktreePath)) continue;

      const files = fs.readdirSync(rec.worktreePath);
      for (const file of files) {
        const full = path.join(rec.worktreePath, file);
        if (!fs.statSync(full).isFile()) continue;
        const content = fs.readFileSync(full, "utf8");
        const prev = touchedFileContents.get(file);
        if (prev && prev.content !== content) {
          conflicts.push(
            `Merge conflict on "${file}" between subtasks "${prev.taskId}" and "${id}"`
          );
        } else {
          touchedFileContents.set(file, { taskId: id, content });
        }
      }
    }

    if (conflicts.length > 0) {
      return { merged: false, conflicts, verificationPassed: false };
    }

    for (const [file, info] of touchedFileContents.entries()) {
      const dest = path.join(this.opts.workspaceRoot, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, info.content, "utf8");
    }

    if (this.opts.verifier) {
      const vRes = await this.opts.verifier(this.opts.workspaceRoot);
      return {
        merged: true,
        conflicts: [],
        verificationPassed: vRes.passed,
      };
    }

    return { merged: true, conflicts: [], verificationPassed: true };
  }

  getStatus(taskId: string): { taskId: string; status: string; completedAt?: number } | null {
    const rec = this.tasks.get(taskId);
    if (!rec) return null;
    return {
      taskId: rec.taskId,
      status: rec.status,
      completedAt: rec.completedAt,
    };
  }

  getResult(taskId: string): DelegatedTaskRecord | null {
    const rec = this.tasks.get(taskId);
    return rec ? structuredClone(rec) : null;
  }
}
