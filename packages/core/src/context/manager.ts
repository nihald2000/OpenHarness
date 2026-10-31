import { ASK_MODE_PROMPT, CODING_AGENT_PROMPT, ENVIRONMENT_FACTS } from "./prompts.ts";
import fs from "node:fs";
import path from "node:path";
import type {
  CompactionPart,
  Message,
  OpenHarnessEvent,
  Part,
} from "@openharness/sdk";
import type {
  ContextManager,
  ContextPrepareResult,
  RunState,
} from "../agent/deps.ts";

export const OVERFLOW_SHRINK_RATIOS: readonly number[] = [0.85, 0.7, 0.5, 0.35] as const;

export interface ContextEngineeringConfig {
  contextWindow?: number; // default 32_000 or model profile window
  clearAfterTurns?: number; // default 6
  keepErrorTurns?: number; // default 3
  recitationEveryTurns?: number; // default 8
  keepRecentTokens?: number; // default 20_000 (scaled to window if window <= 32K)
  handoffAtRatio?: number; // default 0.6
  precomputeThresholdRatio?: number; // default 0.85
  precomputeMinTokens?: number; // default 64_000 (or 50% of window if window < 64K)
  includeRepositoryInstructions?: boolean;
  globalInstructionsPath?: string;
  workspaceRoot?: string;
  summarizer?: (transcriptText: string, state: RunState) => Promise<string>;
}

interface PrecomputedCompaction {
  cursorAtCompute: number;
  summaryText: string;
  part: CompactionPart;
}

/**
 * Layered ContextManager for multi-hour agent runs (§7 Phase E):
 * 1. Stable prefix (byte-identical across turns; deterministic JSON ordering; no timestamps in prefix)
 * 2. Tool-result clearing after `clearAfterTurns` (default 6), preserving pinned items and recent errors
 * 3. Periodic todo/feature/budget recitation every `recitationEveryTurns` (default 8) and post-compaction
 * 4. LLM compaction with reserve (`max(16_000, 15% of window)`), background precompute at 85% trigger,
 *    progressive transcript shortening, verbatim tail preserving tool-call/result pairs, and heuristic fallback
 * 5. Overflow shrink steps (85%, 70%, 50%, 35%) and 5-attempt 80% hard context reset (`context.hard_reset`)
 * 6. Handoff / context reset between features in `long_task` mode
 * 7. Hierarchical lazy `AGENTS.md` instruction loading (32 KB cap per file)
 */
export class LayeredContextManager implements ContextManager {
  private cfg: ContextEngineeringConfig;
  private precomputed: PrecomputedCompaction | null = null;
  private backgroundFailures = 0;
  private loadedInstructionDirs = new Set<string>();
  private cachedInstructions: string[] = [];

  constructor(cfg?: ContextEngineeringConfig) {
    this.cfg = cfg ?? {};
  }

  getReserveTokens(contextWindow: number): number {
    return Math.min(
      Math.floor(contextWindow * 0.75),
      Math.max(16_000, Math.floor(contextWindow * 0.15))
    );
  }

  getTriggerTokens(contextWindow: number): number {
    return Math.max(4_000, contextWindow - this.getReserveTokens(contextWindow));
  }

  estimateMessageTokens(msg: Message): number {
    let chars = 16;
    for (const part of msg.parts) {
      if (part.type === "text" || part.type === "reasoning") {
        chars += part.text.length;
      } else if (part.type === "compaction") {
        chars += part.summary.length;
      } else if (part.type === "tool") {
        chars +=
          part.tool.length +
          JSON.stringify(part.input ?? {}).length +
          (typeof part.output === "string"
            ? part.output.length
            : JSON.stringify(part.output ?? "").length) +
          (part.error?.length ?? 0);
      } else {
        chars += JSON.stringify(part).length;
      }
    }
    return Math.ceil(chars / 4);
  }

  estimateTranscriptTokens(systemPrompt: string, messages: Message[]): number {
    let total = Math.ceil(systemPrompt.length / 4);
    for (const m of messages) {
      total += this.estimateMessageTokens(m);
    }
    return total;
  }

  /**
   * Builds a byte-identical, deterministic system prompt prefix across turns (§7 E.1, E.8).
   */
  buildStableSystemPrompt(state: RunState, touchedPaths: string[] = []): string {
    const sections: string[] = [
      `# OpenHarness Agent (${state.agent})`,
      `Mode: ${state.mode}`,
      state.mode === "ask" ? ASK_MODE_PROMPT : CODING_AGENT_PROMPT,
      ENVIRONMENT_FACTS,
    ];

    if (this.cfg.includeRepositoryInstructions && this.cfg.workspaceRoot) {
      const instr = this.loadHierarchicalInstructions(this.cfg.workspaceRoot, touchedPaths);
      if (instr) {
        sections.push("## Repository Instructions (AGENTS.md)\n" + instr);
      }
    }

    if (this.cfg.workspaceRoot && fs.existsSync(this.cfg.workspaceRoot)) {
      const outline = this.buildWorkspaceOutline(this.cfg.workspaceRoot, 80);
      if (outline.length > 0) {
        sections.push("## Workspace Outline\n" + outline.join("\n"));
      }
    }

    if (state.changedFiles && state.changedFiles.length > 0) {
      sections.push("## Changed Files\n" + state.changedFiles.map((f) => `- ${f}`).join("\n"));
    }

    if (state.plan && Array.isArray(state.plan.steps) && state.plan.steps.length > 0) {
      sections.push(
        "## Current Plan: " +
          state.plan.title +
          "\n" +
          state.plan.steps.map((s) => `- [${s.status}] ${s.id}: ${s.title}`).join("\n")
      );
    }

    if (state.sandboxNotice) {
      sections.push("## Sandbox Notice\n" + state.sandboxNotice);
    }

    return sections.join("\n\n");
  }

  private buildWorkspaceOutline(rootDir: string, maxEntries = 80): string[] {
    const out: string[] = [];
    const skip = new Set(["node_modules", ".git", "dist", ".next", ".cache", "__pycache__", ".openharness", ".shadow-git"]);
    const walk = (dir: string, depth: number) => {
      if (out.length >= maxEntries || depth > 2) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= maxEntries) break;
        if (skip.has(e.name)) continue;
        const rel = path.relative(rootDir, path.join(dir, e.name)).replace(/\\/g, "/");
        if (e.isDirectory()) {
          out.push(rel + "/");
          walk(path.join(dir, e.name), depth + 1);
        } else {
          out.push(rel);
        }
      }
    };
    walk(rootDir, 0);
    return out;
  }

  /**
   * Loads AGENTS.md hierarchically (global -> repo root -> touched directories),
   * capped at 32 KB per file, lazily reading nested directories when touched (§7 E.8).
   */
  loadHierarchicalInstructions(workspaceRoot: string, touchedPaths: string[] = []): string {
    const MAX_FILE_BYTES = 32 * 1024;
    const candidateDirs: string[] = [];

    if (this.cfg.globalInstructionsPath) {
      candidateDirs.push(path.dirname(this.cfg.globalInstructionsPath));
    }
    candidateDirs.push(path.resolve(workspaceRoot));

    for (const rel of touchedPaths) {
      const resolved = path.resolve(workspaceRoot, rel);
      let dir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved);
      const dirsToRoot: string[] = [];
      while (dir.startsWith(path.resolve(workspaceRoot)) && dir !== path.resolve(workspaceRoot)) {
        dirsToRoot.unshift(dir);
        dir = path.dirname(dir);
      }
      candidateDirs.push(...dirsToRoot);
    }

    for (const dir of candidateDirs) {
      if (this.loadedInstructionDirs.has(dir)) continue;
      this.loadedInstructionDirs.add(dir);
      const agentsFile = path.join(dir, "AGENTS.md");
      if (fs.existsSync(agentsFile) && fs.statSync(agentsFile).isFile()) {
        const raw = fs.readFileSync(agentsFile, "utf8").slice(0, MAX_FILE_BYTES);
        this.cachedInstructions.push(`<!-- ${path.relative(workspaceRoot, agentsFile) || "AGENTS.md"} -->\n${raw}`);
      }
    }

    return this.cachedInstructions.join("\n\n");
  }

  /**
   * Clears old unpinned tool results older than `clearAfterTurns` (default 6) (§7 E.2).
   * Pinned: skill bodies, latest verification result, feature_list, todo_read/todo_write,
   * pending approvals, and errors from the last `keepErrorTurns` (default 3) turns.
   */
  clearOldToolResults(messages: Message[], workspaceRoot?: string): Message[] {
    const clearAfterTurns = this.cfg.clearAfterTurns ?? 6;
    const keepErrorTurns = this.cfg.keepErrorTurns ?? 3;
    const assistantIndices = messages
      .map((m, idx) => (m.info.role === "assistant" ? idx : -1))
      .filter((idx) => idx !== -1);

    if (assistantIndices.length <= clearAfterTurns) {
      return structuredClone(messages);
    }

    // Find the last message containing a verification result so it stays pinned
    let latestVerifyMsgIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (
        messages[i]!.parts.some(
          (p) =>
            p.type === "verify" ||
            (p.type === "tool" && p.tool === "verify")
        )
      ) {
        latestVerifyMsgIdx = i;
        break;
      }
    }

    const cutoffTurnPos = assistantIndices.length - clearAfterTurns;
    const errorCutoffTurnPos = Math.max(0, assistantIndices.length - keepErrorTurns);
    const cutoffMsgIdx = assistantIndices[cutoffTurnPos]!;
    const errorCutoffMsgIdx = assistantIndices[errorCutoffTurnPos]!;

    return messages.map((msg, msgIdx) => {
      if (msgIdx >= cutoffMsgIdx) {
        return structuredClone(msg);
      }
      const cloned = structuredClone(msg);
      cloned.parts = cloned.parts.map((part) => {
        if (part.type === "skill") {
          // Skill bodies are always pinned
          return part;
        }
        if (part.type !== "tool") {
          return part;
        }
        // Pin pending approvals, feature_list, todo tools, and latest verification result
        if (
          part.state === "pending" ||
          part.tool === "feature_list" ||
          part.tool === "todo_write" ||
          part.tool === "todo_read" ||
          part.tool === "update_plan" ||
          (msgIdx === latestVerifyMsgIdx && part.tool === "verify")
        ) {
          return part;
        }
        // Keep errors from the last 3 turns longer than successes
        const isError = part.state === "error" || Boolean(part.error);
        if (isError && msgIdx >= errorCutoffMsgIdx) {
          return part;
        }

        const outStr =
          typeof part.output === "string"
            ? part.output
            : JSON.stringify(part.output ?? "");
        if (outStr.startsWith("[cleared:")) {
          return part;
        }

        // Spill full output to disk if not already spilled so cleared outputs remain retrievable from disk (§7 Acceptance E)
        let spillRelPath = `.openharness/outputs/${part.callId}.txt`;
        if (workspaceRoot && outStr.length > 0) {
          const outDir = path.join(workspaceRoot, ".openharness", "outputs");
          fs.mkdirSync(outDir, { recursive: true });
          const fullPath = path.join(outDir, `${part.callId.replace(/[^A-Za-z0-9_.-]/g, "_")}.txt`);
          if (!fs.existsSync(fullPath)) {
            fs.writeFileSync(fullPath, outStr, "utf8");
          }
          spillRelPath = `.openharness/outputs/${part.callId.replace(/[^A-Za-z0-9_.-]/g, "_")}.txt`;
        }

        const firstLine = outStr.split("\n")[0]?.slice(0, 80) ?? "done";
        return {
          ...part,
          output: `[cleared: ${part.tool} (${firstLine}), full output at ${spillRelPath}]`,
        };
      });
      return cloned;
    });
  }

  /**
   * Builds the periodic recitation message containing current feature, todo list, budgets remaining, and next move (§7 E.3).
   */
  buildRecitationMessage(state: RunState): string {
    const activeFeature =
      state.features.find((f) => f.id === state.featureId) ??
      state.features.find((f) => f.status === "in_progress") ??
      state.features.find((f) => f.status === "pending");

    const todoSummary =
      state.todos.length > 0
        ? state.todos.map((t) => `[${t.status}] ${t.content}`).join("; ")
        : state.plan?.steps.map((s) => `[${s.status}] ${s.title}`).join("; ") ?? "None";

    const nextPendingTodo =
      state.todos.find((t) => t.status === "in_progress" || t.status === "pending")?.content ??
      state.plan?.steps.find((s) => s.status === "in_progress" || s.status === "pending")?.title ??
      (activeFeature ? `Complete and verify feature "${activeFeature.title}"` : "Complete current objective and verify");

    const remainingIter = Math.max(0, state.budgets.maxIterations - state.iteration);

    return [
      "[Harness Recitation]",
      `- Current Feature: ${activeFeature ? `${activeFeature.id} (${activeFeature.title}) [${activeFeature.status}]` : state.featureId ?? "general"}`,
      `- Todo List: ${todoSummary}`,
      `- Budgets Remaining: ${remainingIter} iterations (phase: ${state.phase})`,
      `- Next Move: ${nextPendingTodo}`,
    ].join("\n");
  }

  /**
   * Progressively shortens older transcript exchanges to fit the summarizer input budget (§7 E.4):
   * Stage 0: whole
   * Stage 1: tool outputs clipped to 2,000 chars
   * Stage 2: tool outputs removed
   * Stage 3: user text only
   * Stage 4: oldest exchanges omitted
   */
  shortenTranscriptForSummarizer(messages: Message[], maxChars: number): string {
    for (let stage = 0; stage <= 4; stage++) {
      const rendered = messages
        .map((m, idx) => {
          const isOldHalf = idx < Math.floor(messages.length / 2);
          if (stage === 4 && isOldHalf) return "";
          if (stage === 3 && isOldHalf && m.info.role !== "user") return "";

          const partTexts = m.parts
            .map((p) => {
              if (p.type === "text") return `${m.info.role.toUpperCase()}: ${p.text}`;
              if (p.type === "compaction") return `PREVIOUS_SUMMARY: ${p.summary}`;
              if (p.type === "tool") {
                if (stage >= 2 && isOldHalf) {
                  return `TOOL(${p.tool}): [output omitted]`;
                }
                const rawOut =
                  typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
                const clippedOut =
                  stage >= 1 ? rawOut.slice(0, 2000) : rawOut;
                return `TOOL(${p.tool} input=${JSON.stringify(p.input)}): ${clippedOut}${p.error ? ` ERROR=${p.error}` : ""}`;
              }
              return "";
            })
            .filter(Boolean)
            .join("\n");
          return partTexts;
        })
        .filter(Boolean)
        .join("\n\n");

      if (rendered.length <= maxChars || stage === 4) {
        return rendered.slice(-maxChars);
      }
    }
    return "";
  }

  /**
   * Produces a structured summary following the mandatory §7 E.4 template:
   * Objective, Requirements, Decisions, Work State (Completed / Active / Blocked),
   * Next Move, Relevant Files (<=15), Important Context.
   */
  async buildStructuredCompaction(
    state: RunState,
    messagesToCompact: Message[],
    tokensBefore: number,
    keptMessagesCount: number
  ): Promise<{ summaryText: string; part: CompactionPart }> {
    const requirements: string[] = [];
    const decisions: string[] = [];
    const openQuestions: string[] = [];
    const filesSet = new Set<string>();

    for (const m of messagesToCompact) {
      for (const p of m.parts) {
        if (p.type === "text") {
          if (m.info.role === "user" && !m.info.summary) {
            const firstSentence = p.text.split(/[.\n]/)[0]?.trim();
            if (firstSentence && firstSentence.length > 3 && requirements.length < 8) {
              requirements.push(firstSentence.slice(0, 160));
            }
          } else if (m.info.role === "assistant") {
            if (/\b(?:decided|chose|implemented|updated|fixed)\b/i.test(p.text) && decisions.length < 8) {
              decisions.push(p.text.split("\n")[0]!.slice(0, 160));
            }
            if (p.text.includes("?") && openQuestions.length < 5) {
              const q = p.text
                .split("\n")
                .find((l) => l.includes("?"))
                ?.trim();
              if (q) openQuestions.push(q.slice(0, 160));
            }
          }
        } else if (p.type === "tool") {
          const inp = p.input as Record<string, unknown> | undefined;
          if (inp && typeof inp.path === "string" && filesSet.size < 15) {
            filesSet.add(inp.path);
          }
        } else if (p.type === "compaction") {
          for (const r of p.requirements ?? []) {
            if (requirements.length < 8 && !requirements.includes(r)) requirements.push(r);
          }
          for (const d of p.decisions ?? []) {
            if (decisions.length < 8 && !decisions.includes(d)) decisions.push(d);
          }
          // Preserve file paths mentioned in earlier compaction summaries
          const fileMatches = p.summary.match(/\b[A-Za-z0-9_./-]+\.(?:ts|tsx|js|py|json|md)\b/g);
          for (const fm of fileMatches ?? []) {
            if (filesSet.size < 15) filesSet.add(fm);
          }
        }
      }
    }

    const completedFeatures = state.features.filter((f) => f.status === "passing").map((f) => f.id);
    const activeFeature =
      state.features.find((f) => f.id === state.featureId) ??
      state.features.find((f) => f.status === "in_progress");
    const blockedFeatures = state.features.filter((f) => f.status === "blocked").map((f) => f.id);

    const nextMove =
      state.todos.find((t) => t.status === "in_progress" || t.status === "pending")?.content ??
      state.plan?.steps.find((s) => s.status === "in_progress" || s.status === "pending")?.title ??
      (activeFeature ? `Implement and verify feature ${activeFeature.id}: ${activeFeature.title}` : "Continue current task");

    const relevantFiles = Array.from(filesSet).slice(0, 15);

    let llmCustomBody: string | null = null;
    if (this.cfg.summarizer) {
      try {
        const shortened = this.shortenTranscriptForSummarizer(messagesToCompact, 24_000);
        llmCustomBody = await this.cfg.summarizer(shortened, state);
      } catch {
        // Fall back to deterministic structured template so offline/mock mode always works (§7 E.4)
      }
    }

    const templateLines = [
      "## Objective",
      requirements[0] ?? `Complete ${state.mode} run (${state.runId})`,
      "",
      "## Requirements",
      ...(requirements.length > 0 ? requirements.map((r) => `- ${r}`) : ["- Preserve all existing contracts and pass verification"]),
      "",
      "## Decisions",
      ...(decisions.length > 0 ? decisions.map((d) => `- ${d}`) : ["- Follow incremental verified steps"]),
      "",
      "## Work State (Completed / Active / Blocked)",
      `- Completed: ${completedFeatures.join(", ") || `${state.iteration} steps completed`}`,
      `- Active: ${activeFeature ? `${activeFeature.id} (${activeFeature.title})` : state.featureId ?? state.phase}`,
      `- Blocked: ${blockedFeatures.join(", ") || "None"}`,
      "",
      "## Next Move",
      `- ${nextMove}`,
      "",
      "## Relevant Files (<=15)",
      ...(relevantFiles.length > 0 ? relevantFiles.map((f) => `- ${f}`) : ["- (workspace root)"]),
      "",
      "## Important Context",
      llmCustomBody ?? `Last checkpoint: ${state.lastCheckpoint ?? "none"}; Tainted: ${state.tainted}`,
    ];

    const summaryText = templateLines.join("\n");
    const tokensAfter = Math.ceil(summaryText.length / 4);

    const part: CompactionPart = {
      type: "compaction",
      summary: summaryText,
      reason: "tokens",
      compactedMessages: messagesToCompact.length,
      tokensBefore,
      tokensAfter,
      keptMessages: keptMessagesCount,
      requirements,
      decisions,
      openQuestions,
    };

    return { summaryText, part };
  }

  /**
   * Selects the verbatim tail of recent messages up to `keepRecentTokens`,
   * never splitting an assistant tool call from its tool result (§7 E.4).
   */
  splitHeadAndVerbatimTail(
    messages: Message[],
    keepRecentTokens: number
  ): { head: Message[]; tail: Message[] } {
    if (messages.length <= 2) {
      return { head: [], tail: messages };
    }
    let tailTokens = 0;
    let splitIdx = messages.length;

    for (let i = messages.length - 1; i >= 1; i--) {
      const mTokens = this.estimateMessageTokens(messages[i]!);
      if (tailTokens + mTokens > keepRecentTokens && splitIdx < messages.length) {
        break;
      }
      tailTokens += mTokens;
      splitIdx = i;
    }

    // Ensure at least the older half is compacted when compaction is triggered
    if (splitIdx <= 1 && messages.length >= 4) {
      splitIdx = Math.max(2, Math.floor(messages.length / 2));
    }

    return {
      head: messages.slice(0, splitIdx),
      tail: messages.slice(splitIdx),
    };
  }

  /**
   * Hard context reset: truncates the largest items by 80% per attempt for up to 5 attempts (§7 E.5).
   */
  applyHardReset(
    state: RunState,
    messages: Message[],
    targetTokens: number,
    systemPrompt: string
  ): { messages: Message[]; attempts: number; tokensBefore: number; tokensAfter: number } {
    const tokensBefore = this.estimateTranscriptTokens(systemPrompt, messages);
    const working = structuredClone(messages);
    let attempts = 0;

    while (attempts < 5) {
      const currentTokens = this.estimateTranscriptTokens(systemPrompt, working);
      if (currentTokens <= targetTokens) break;
      attempts += 1;

      // Find the largest text/tool part and truncate it by 80% (retaining 20%)
      for (const msg of working) {
        for (const p of msg.parts) {
          if (p.type === "text" && p.text.length > 200) {
            const keepLen = Math.max(100, Math.floor(p.text.length * 0.2));
            p.text = `${p.text.slice(0, keepLen)} ... [hard_reset truncated 80%]`;
          } else if (p.type === "tool") {
            const outStr =
              typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
            if (outStr.length > 200) {
              const keepLen = Math.max(100, Math.floor(outStr.length * 0.2));
              p.output = `${outStr.slice(0, keepLen)} ... [hard_reset truncated 80%]`;
            }
          }
        }
      }
    }

    const tokensAfter = this.estimateTranscriptTokens(systemPrompt, working);
    return { messages: working, attempts: Math.max(1, attempts), tokensBefore, tokensAfter };
  }

  /**
   * Prepares turn context with tool clearing, background precompute, LLM compaction, hard reset, and recitation (§7).
   */
  async prepareTurnContext(
    state: RunState,
    rawMessages: Message[]
  ): Promise<ContextPrepareResult> {
    const events: OpenHarnessEvent[] = [];
    const contextWindow = this.cfg.contextWindow ?? 32_000;
    const triggerTokens = this.getTriggerTokens(contextWindow);
    const keepRecentTokens =
      this.cfg.keepRecentTokens ?? Math.min(20_000, Math.floor(contextWindow * 0.35));

    // Collect touched file paths from recent tool calls for lazy AGENTS.md loading
    const touchedPaths: string[] = [];
    for (const m of rawMessages) {
      for (const p of m.parts) {
        if (p.type === "tool" && p.input && typeof (p.input as { path?: string }).path === "string") {
          touchedPaths.push((p.input as { path: string }).path);
        }
      }
    }

    const systemPrompt = this.buildStableSystemPrompt(state, touchedPaths);

    // Layer 2: Clear old tool outputs first (cheapest defense)
    let workingMessages = this.clearOldToolResults(rawMessages, this.cfg.workspaceRoot);
    let estimatedTokens = this.estimateTranscriptTokens(systemPrompt, workingMessages);

    // Background precomputation when usage passes 85% of trigger (§7 E.4)
    const precomputeThreshold = Math.floor(
      triggerTokens * (this.cfg.precomputeThresholdRatio ?? 0.85)
    );
    if (
      estimatedTokens >= precomputeThreshold &&
      estimatedTokens < triggerTokens &&
      !this.precomputed &&
      this.backgroundFailures < 2 &&
      workingMessages.length >= 4
    ) {
      try {
        const { head, tail } = this.splitHeadAndVerbatimTail(workingMessages, keepRecentTokens);
        if (head.length > 0) {
          const built = await this.buildStructuredCompaction(
            state,
            head,
            estimatedTokens,
            tail.length
          );
          this.precomputed = {
            cursorAtCompute: workingMessages.length,
            summaryText: built.summaryText,
            part: built.part,
          };
        }
      } catch {
        this.backgroundFailures += 1;
      }
    }

    // Layer 4: Compaction when estimated tokens exceed triggerTokens
    let compacted = false;
    if (estimatedTokens >= triggerTokens && workingMessages.length >= 3) {
      const { head, tail } = this.splitHeadAndVerbatimTail(workingMessages, keepRecentTokens);
      if (head.length > 0) {
        let compactionPart: CompactionPart;
        if (this.precomputed) {
          compactionPart = {
            ...this.precomputed.part,
            tokensBefore: estimatedTokens,
            keptMessages: tail.length,
          };
          this.precomputed = null;
        } else {
          const built = await this.buildStructuredCompaction(
            state,
            head,
            estimatedTokens,
            tail.length
          );
          compactionPart = built.part;
        }

        const summaryMsg: Message = {
          info: {
            id: `msg-compact-${state.runId}-${state.iteration}`,
            role: "assistant",
            summary: true,
          },
          createdAt: Date.now(),
          parts: [compactionPart],
        };

        workingMessages = [summaryMsg, ...tail];
        compacted = true;
        state.compactionStreak += 1;
        estimatedTokens = this.estimateTranscriptTokens(systemPrompt, workingMessages);

        events.push({
          type: "message.updated",
          sessionId: state.sessionId,
          message: summaryMsg,
        });
        events.push({
          type: "part.updated",
          sessionId: state.sessionId,
          messageId: summaryMsg.info.id,
          part: compactionPart,
        });
      }
    }

    // Layer 5: Hard reset if compaction still cannot fit a giant message (§7 E.5)
    let hardReset = false;
    if (estimatedTokens >= contextWindow) {
      const resetRes = this.applyHardReset(
        state,
        workingMessages,
        triggerTokens,
        systemPrompt
      );
      workingMessages = resetRes.messages;
      estimatedTokens = resetRes.tokensAfter;
      hardReset = true;
      events.push({
        type: "context.hard_reset",
        sessionId: state.sessionId,
        runId: state.runId,
        attempts: resetRes.attempts,
        tokensBefore: resetRes.tokensBefore,
        tokensAfter: resetRes.tokensAfter,
      });
    }

    // Layer 3: Recitation every `recitationEveryTurns` (default 8) steps and after every compaction (§7 E.3)
    const recitationEvery = this.cfg.recitationEveryTurns ?? 8;
    let recitationText: string | undefined;
    if (
      compacted ||
      (state.iteration > 0 && state.iteration % recitationEvery === 0)
    ) {
      recitationText = this.buildRecitationMessage(state);
      const recitationPart: Part = {
        type: "text",
        text: recitationText,
        synthetic: true,
      };
      const recitationMsg: Message = {
        info: {
          id: `msg-recite-${state.runId}-${state.iteration}`,
          role: "user",
          summary: true,
        },
        createdAt: Date.now(),
        parts: [recitationPart],
      };
      workingMessages = [...workingMessages, recitationMsg];
      estimatedTokens = this.estimateTranscriptTokens(systemPrompt, workingMessages);
    }

    return {
      systemPrompt,
      messages: workingMessages,
      estimatedTokens,
      compacted,
      hardReset,
      recitationText,
      events,
    };
  }

  /**
   * Overflow shrink retry steps: shrinks context to 85%, 70%, 50%, then 35% of rejected size (§7 E.4).
   */
  async handleContextOverflow(
    state: RunState,
    messages: Message[],
    attempt: number
  ): Promise<Message[]> {
    const ratio =
      OVERFLOW_SHRINK_RATIOS[Math.min(attempt - 1, OVERFLOW_SHRINK_RATIOS.length - 1)] ?? 0.35;
    const systemPrompt = this.buildStableSystemPrompt(state);
    const currentTokens = this.estimateTranscriptTokens(systemPrompt, messages);
    const targetTokens = Math.max(1000, Math.floor(currentTokens * ratio));

    const keepTailTokens = Math.floor(targetTokens * 0.5);
    const { head, tail } = this.splitHeadAndVerbatimTail(messages, keepTailTokens);
    if (head.length > 0) {
      const built = await this.buildStructuredCompaction(
        state,
        head,
        currentTokens,
        tail.length
      );
      built.part.reason = "overflow";
      const summaryMsg: Message = {
        info: {
          id: `msg-overflow-${state.runId}-${attempt}`,
          role: "assistant",
          summary: true,
        },
        createdAt: Date.now(),
        parts: [built.part],
      };
      const candidate = [summaryMsg, ...tail];
      if (this.estimateTranscriptTokens(systemPrompt, candidate) <= targetTokens) {
        return candidate;
      }
      return this.applyHardReset(state, candidate, targetTokens, systemPrompt).messages;
    }

    return this.applyHardReset(state, messages, targetTokens, systemPrompt).messages;
  }

  /**
   * Builds a fresh seeded context for feature handoff in `long_task` mode (§7 E.6).
   */
  buildFeatureHandoffSeedMessage(params: {
    state: RunState;
    brief: string;
    progressTail: string;
    shadowGitLog: string;
  }): Message {
    const featureSummary = params.state.features
      .map((f) => `- [${f.status}] ${f.id}: ${f.title}`)
      .join("\n");

    const seedText = [
      "# Feature Handoff Context Reset",
      "## Handoff Brief",
      params.brief,
      "",
      "## Feature List",
      featureSummary || "No features listed.",
      "",
      "## Progress Log Tail",
      params.progressTail || "No prior progress entries.",
      "",
      "## Recent Shadow Git Log (last 20 commits)",
      params.shadowGitLog || "Initial commit.",
    ].join("\n");

    return {
      info: {
        id: `msg-handoff-${params.state.runId}-${params.state.iteration}`,
        role: "user",
        summary: true,
      },
      createdAt: Date.now(),
      parts: [{ type: "text", text: seedText, synthetic: true }],
    };
  }
}
