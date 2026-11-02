import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { FeatureItem, PlanData, TodoItem } from "@openharness/sdk";
import type {
  BrowserCheck,
  BrowserCheckStep,
  RegisteredTool,
  RunState,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRouter,
} from "../agent/deps.ts";
import { formatBrowserEvidence } from "../agent/verification.ts";
import { getActiveSandboxDaemon, LocalSandboxProvider } from "../sandbox/providers.ts";
import { compileSandboxPolicy } from "../sandbox/policy.ts";
import { enforceToolOutputLimit } from "./output-limit.ts";
import { resolveInside, PathEscapeError } from "../util/safe-path.ts";
import { SkillsRegistry } from "../skills/registry.ts";
import { McpClientManager } from "../mcp/client.ts";

const IGNORED_WORKSPACE_DIRS = new Set(["node_modules", ".git", "dist", ".openharness"]);

const READ_TOOL_NAMES = ["read_file", "list", "glob", "search", "ask_user"] as const;
const BUILD_TOOL_NAMES = ["write_file", "edit", "apply_patch", "bash", "verify", "delegate", "todo_write", "update_plan", "request_takeover", "service_start"] as const;
const WEB_TOOL_NAMES = ["process_start", "process_logs", "process_stop", "preview_url", "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_screenshot", "browser_console", "browser_check_def", "browser_check_run"] as const;
const WEB_INTENT = /\b(web|ui|page|browser|frontend|react|vue|svelte|vite|next|html|css|preview|dev server|express|api server)\b/i;

export function selectTools(state: RunState, all: RegisteredTool[]): RegisteredTool[] {
  if (state.mode === "ask" || state.mode === "chat") {
    const allowed = new Set<string>(READ_TOOL_NAMES);
    return all.filter((tool) => allowed.has(tool.name));
  }
  const web = state.webTools === true || WEB_INTENT.test(state.initialPrompt ?? "");
  const allowed = new Set<string>([
    ...READ_TOOL_NAMES,
    ...BUILD_TOOL_NAMES,
    ...(web ? WEB_TOOL_NAMES : []),
    "load_tools",
  ]);
  return all.filter((tool) => allowed.has(tool.name)
    || (state.loadedGroups?.includes("mcp") && tool.source === "mcp")
    || (state.loadedGroups?.includes("skills") && tool.source === "skill"));
}

function walkWorkspaceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_WORKSPACE_DIRS.has(entry.name)) continue;
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath, relativePath);
      else if (entry.isFile()) files.push(relativePath.replace(/\\/g, "/"));
    }
  };
  visit(root, "");
  return files;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  let source = "^";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!;
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        i++;
        if (normalized[i + 1] === "/") {
          source += "(?:.*/)?";
          i++;
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function htmlToReadableText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(?:br|hr)\b[^>]*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|li|h[1-6]|tr|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_entity, decimal: string) => {
      const codePoint = Number(decimal);
      return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : "\uFFFD";
    })
    .replace(/&#x([\da-f]+);/gi, (_entity, hexadecimal: string) => {
      const codePoint = parseInt(hexadecimal, 16);
      return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : "\uFFFD";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const HOST_TOOLS = new Set([
  "load_tools",
  "update_plan",
  "todo_write",
  "todowrite",
  "plan",
  "ask_user",
  "request_takeover",
  "delegate",
  "handoff",
  "word_count",
  "webfetch",
  "websearch",
  "skill",
  "load_skill",
  "list_skills",
  "import_skill",
  "mcp_list_servers",
  "mcp_call_tool",
  "mcp_connect_server",
]);

/**
 * Sandbox lifecycle tools manage the sandbox itself, so they must not be gated on
 * an already-active sandbox daemon (unlike `bash`, `process_start`, `browser_*`, ...).
 */
export const SANDBOX_CONTROL_TOOLS = new Set([
  "sandbox_create",
  "sandbox_status",
  "sandbox_stop",
]);

export interface SandboxToolRouterOptions {
  workspaceRoot: string;
  dataDir?: string;
  skillsRegistry?: SkillsRegistry;
  mcpManager?: McpClientManager;
  sandboxEnabled?: boolean;
  ensureSandbox?: (state: RunState) => Promise<{ id: string; workspacePath: string }>;
  resolvePreviewUrl?: (sandboxId: string, port: number) => Promise<string | undefined> | string | undefined;
  onSandboxStop?: (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>;
  onDelegate?: (
    input: Record<string, unknown>,
    ctx: ToolExecutionContext
  ) => Promise<ToolExecutionResult>;
  onHandoff?: (
    brief: string,
    ctx: ToolExecutionContext
  ) => Promise<ToolExecutionResult>;
  onVerify?: (
    commands: string[] | undefined,
    ctx: ToolExecutionContext
  ) => Promise<ToolExecutionResult>;
}

/**
 * Full long-horizon tool catalog & router (§6 Phase D).
 * Keeps tool names and definitions stable across the entire run and masks tools
 * by policy (`masked: true`) instead of removing them mid-run so KV caches remain valid.
 */
export class StandardToolRouter implements ToolRouter {
  readonly skillsRegistry: SkillsRegistry;
  readonly mcpManager: McpClientManager;
  private tools = new Map<string, RegisteredTool>();
  private opts: SandboxToolRouterOptions;
  private localFallbackProvider = new LocalSandboxProvider();
  private localFallbackHandles = new Map<string, Promise<{ id: string }>>();

  constructor(opts: SandboxToolRouterOptions) {
    this.opts = opts;
    this.skillsRegistry = opts.skillsRegistry ?? new SkillsRegistry({ workspaceRoot: opts.workspaceRoot, dataDir: opts.dataDir });
    this.mcpManager = opts.mcpManager ?? new McpClientManager({ workspaceRoot: opts.workspaceRoot, dataDir: opts.dataDir });
    for (const tool of this.buildCatalog()) {
      this.tools.set(tool.name, tool);
    }
    for (const tool of this.skillsRegistry.buildTools()) this.tools.set(tool.name, tool);
    for (const tool of this.mcpManager.buildTools()) this.tools.set(tool.name, tool);
  }

  private refreshMcpTools(): void {
    for (const name of this.tools.keys()) {
      if (name.startsWith("mcp__")) this.tools.delete(name);
    }
    for (const tool of this.mcpManager.buildTools()) this.tools.set(tool.name, tool);
  }

  listTools(state: RunState): RegisteredTool[] {
    this.refreshMcpTools();
    const selected = selectTools(state, Array.from(this.tools.values()));
    const isReadOnlyPhase = state.phase === "planning" || state.agent === "plan" || state.agent === "explore";
    const isAskMode = state.mode === "ask";

    return selected
      .filter((t) => {
        if (isAskMode && !t.readOnly && t.name !== "ask_user") {
          return false;
        }
        return true;
      })
      .map((t) => ({
        ...t,
        description: compactToolDescription(t.description),
        // Mask mutating tools in read-only planning phase rather than removing them mid-run ("mask, don't remove" §6)
        masked: isReadOnlyPhase && !t.readOnly ? true : false,
      }));
  }

  getTool(name: string): RegisteredTool | undefined {
    if (name.startsWith("mcp__")) this.refreshMcpTools();
    const resolvedName = name === "load_skill" ? "skill" : name === "grep" ? "search" : name;
    return this.tools.get(resolvedName);
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    callId: string,
    ctx: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    return this.executeTool(callId, name, input, ctx);
  }

  async executeTool(
    callId: string,
    name: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const tool = this.getTool(name);
    if (!tool) {
      return { output: null, error: `Unknown tool: ${name}` };
    }
    if (!HOST_TOOLS.has(name) && !name.startsWith("mcp__") && !ctx.sandboxHandleId && this.opts.ensureSandbox && ctx.state) {
      try {
        const h = await this.opts.ensureSandbox(ctx.state);
        ctx.sandboxHandleId = h.id;
        ctx.state.sandboxHandleId = h.id;
      } catch {
        // Workspace tools can still use the local fallback daemon when no selected runtime is available.
      }
    }
    const rawRes = await tool.execute(input, ctx);
    if (!rawRes.error && name === "process_start") ctx.state.webTools = true;
    const outputField = name === "process_logs" ? "logs" : name === "browser_snapshot" ? "snapshot" : undefined;
    const fieldValue = outputField && rawRes.output && typeof rawRes.output === "object"
      ? (rawRes.output as Record<string, unknown>)[outputField]
      : undefined;
    if (typeof rawRes.output === "string" || typeof fieldValue === "string") {
      const maxChars = name === "bash" ? 12_000 : name === "browser_snapshot" ? 8_000 : name === "process_logs" ? 6_000 : 16_000;
      const bounded = enforceToolOutputLimit(typeof rawRes.output === "string" ? rawRes.output : fieldValue, callId, ctx.workspaceRoot, {
        maxChars,
        style: name === "process_logs" ? "tail" : "head-tail",
      });
      return {
        ...rawRes,
        output: typeof rawRes.output === "string"
          ? bounded.output
          : { ...(rawRes.output as Record<string, unknown>), [outputField!]: bounded.output },
        truncated: bounded.truncated || rawRes.truncated,
        spillPath: bounded.spillPath,
      };
    }
    return rawRes;
  }

  private async getDaemonAndHeaders(ctx: ToolExecutionContext) {
    let daemon = ctx.sandboxHandleId
      ? getActiveSandboxDaemon(ctx.sandboxHandleId)
      : undefined;
    if (!daemon) {
      const key = JSON.stringify([
        ctx.tenantId,
        ctx.sessionId,
        ctx.runId,
        path.resolve(ctx.workspaceRoot),
      ]);
      let pendingHandle = this.localFallbackHandles.get(key);
      if (!pendingHandle) {
        pendingHandle = this.localFallbackProvider.create({
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          tenantId: ctx.tenantId,
          workspace: {
            type: "bind",
            kind: "local",
            hostPath: ctx.workspaceRoot,
            path: ctx.workspaceRoot,
          },
          policy: compileSandboxPolicy({
            runId: ctx.runId,
            phase: "agent",
            workspacePath: ctx.workspaceRoot,
            networkMode: "open",
          }),
        });
        this.localFallbackHandles.set(key, pendingHandle);
      }
      let handle: Awaited<typeof pendingHandle>;
      try {
        handle = await pendingHandle;
      } catch (error) {
        this.localFallbackHandles.delete(key);
        throw error;
      }
      ctx.sandboxHandleId = handle.id;
      ctx.state.sandboxHandleId = handle.id;
      ctx.state.runtime = "local";
      daemon = getActiveSandboxDaemon(handle.id);
    }
    if (!daemon) {
      throw new Error("could not initialize the in-process workspace daemon");
    }
    return {
      daemon,
      headers: { "x-session-key": daemon.config.sessionKey },
    };
  }

  private buildCatalog(): RegisteredTool[] {
    return [
      {
        name: "load_tools",
        description: "Load an optional tool group: web, mcp, or skills.",
        readOnly: true,
        idempotent: true,
        source: "builtin",
        parameters: {
          type: "object",
          required: ["group"],
          properties: { group: { type: "string", enum: ["web", "mcp", "skills"] } },
        },
        execute: async (input, ctx) => {
          const group = String(input.group ?? "");
          if (!["web", "mcp", "skills"].includes(group)) {
            return { output: null, error: `Unknown tool group: ${group}` };
          }
          if (group === "web") ctx.state.webTools = true;
          else ctx.state.loadedGroups = Array.from(new Set([...(ctx.state.loadedGroups ?? []), group]));
          return { output: { loaded: group } };
        },
      },
      // 1. Legacy & baseline tools (preserved 100% compatible)
      {
        name: "word_count",
        description:
          "Counts words, lines, and characters in a text string or workspace file. Use for quick size checks. Limit: 100 KB input. Example: {\"text\": \"hello world\"}",
        readOnly: true,
        idempotent: true,
        parameters: {
          type: "object",
          properties: {
            text: { type: "string" },
            path: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          let text = typeof input.text === "string" ? input.text : "";
          if (!text && typeof input.path === "string") {
            try {
              const daemon = ctx.sandboxHandleId
                ? getActiveSandboxDaemon(ctx.sandboxHandleId)
                : undefined;
              if (daemon) {
                const res = await daemon.handleRequest(
                  "POST",
                  "/files/view",
                  { "x-session-key": daemon.config.sessionKey },
                  { path: input.path }
                );
                if (res.status !== 200) {
                  return { output: null, error: String(res.body.error ?? "Failed to read file") };
                }
                text = String(res.body.content ?? "");
              } else {
                const p = resolveInside(ctx.workspaceRoot, input.path);
                text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
              }
            } catch (err) {
              return { output: null, error: (err as Error).message };
            }
          }
          const words = text.trim() ? text.trim().split(/\s+/).length : 0;
          const lines = text ? text.split("\n").length : 0;
          return { output: { words, lines, chars: text.length } };
        },
      },

      {
        name: "read_file",
        description:
          "Reads a file or directory from the workspace. Supports optional `offset` (1-indexed line number) and `limit` (max 2,000 lines) for paging large files; returns raw content when offset/limit are omitted for backward compatibility. Example: {\"path\": \"src/App.tsx\", \"offset\": 1, \"limit\": 100}",
        readOnly: true,
        idempotent: true,
        parameters: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" },
            offset: { type: "number" },
            limit: { type: "number" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          const hasPaging = input.offset !== undefined || input.limit !== undefined;
          if (d) {
            const res = await d.daemon.handleRequest("POST", "/files/view", d.headers, input);
            if (res.status !== 200) {
              return { output: null, error: String(res.body.error ?? "Failed to read file") };
            }
            return {
              output: hasPaging ? res.body.numberedContent : res.body.content,
              truncated: Boolean(res.body.truncated),
            };
          }
          let target: string;
          try {
            target = resolveInside(ctx.workspaceRoot, String(input.path ?? "."));
          } catch (err) {
            return { output: null, error: (err as Error).message };
          }
          if (!fs.existsSync(target)) {
            return { output: null, error: `File not found: ${String(input.path)}` };
          }
          const content = fs.readFileSync(target, "utf8");
          if (!hasPaging) {
            return { output: content };
          }
          const lines = content.split("\n");
          const offset = Math.max(1, Number(input.offset ?? 1));
          const limit = Math.min(2000, Math.max(1, Number(input.limit ?? 2000)));
          const slice = lines
            .slice(offset - 1, offset - 1 + limit)
            .map((l, i) => `${String(offset + i).padStart(5, " ")} | ${l}`)
            .join("\n");
          return { output: slice, truncated: offset - 1 + limit < lines.length };
        },
      },

      {
        name: "write_file",
        description:
          "Creates or overwrites a whole file in the workspace. Use for new files or small complete rewrites; prefer `edit` or `apply_patch` for targeted modifications to existing files. Example: {\"path\": \"src/hello.ts\", \"content\": \"export const x = 1;\\n\"}",
        readOnly: false,
        idempotent: true,
        parameters: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (d) {
            const res = await d.daemon.handleRequest("POST", "/files/create", d.headers, input);
            if (res.status !== 200) {
              return { output: null, error: String(res.body.error ?? "write_file failed") };
            }
            return { output: res.body };
          }
          let target: string;
          try {
            target = resolveInside(ctx.workspaceRoot, String(input.path ?? ""));
          } catch (err) {
            return { output: null, error: (err as Error).message };
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, String(input.content ?? ""), "utf8");
          return { output: { path: input.path, written: true } };
        },
      },

      {
        name: "edit",
        description:
          "Performs precision file edits (`str_replace`, `insert`, or `undo_edit`) with uniqueness verification, whitespace-insensitive fuzzy fallback, unified diff output, and post-edit syntax diagnostics. Always prefer `edit` over `write_file` when modifying existing files. Example: {\"command\": \"str_replace\", \"path\": \"src/index.ts\", \"old_str\": \"const a = 1;\", \"new_str\": \"const a = 2;\"}",
        readOnly: false,
        idempotent: false,
        parameters: {
          type: "object",
          required: ["path"],
          properties: {
            command: { type: "string", enum: ["str_replace", "insert", "undo_edit"] },
            path: { type: "string" },
            old_str: { type: "string" },
            new_str: { type: "string" },
            insert_line: { type: "number" },
          },
        },
        execute: async (input, ctx) => {
          const cmd = String(input.command ?? "str_replace");
          const d = await this.getDaemonAndHeaders(ctx);
          if (d) {
            const route =
              cmd === "insert"
                ? "/files/insert"
                : cmd === "undo_edit"
                ? "/files/undo_edit"
                : "/files/str_replace";
            const res = await d.daemon.handleRequest("POST", route, d.headers, input);
            if (res.status !== 200) {
              return { output: null, error: String(res.body.error ?? "edit failed") };
            }
            return { output: res.body };
          }
          // Fallback local edit
          let target: string;
          try {
            target = resolveInside(ctx.workspaceRoot, String(input.path ?? ""));
          } catch (err) {
            return { output: null, error: (err as Error).message };
          }
          if (!fs.existsSync(target)) {
            return { output: null, error: `File not found: ${String(input.path)}` };
          }
          const orig = fs.readFileSync(target, "utf8");
          const oldStr = String(input.old_str ?? "");
          const newStr = String(input.new_str ?? "");
          if (!orig.includes(oldStr)) {
            return { output: null, error: `old_str not found in ${String(input.path)}` };
          }
          const updated = orig.replace(oldStr, () => newStr);
          fs.writeFileSync(target, updated, "utf8");
          return { output: { path: input.path, replaced: true, diagnostics: [] } };
        },
      },

      {
        name: "apply_patch",
        description:
          "Applies a multi-file patch in standard unified diff format or OpenAI `*** Begin Patch` format. Runs post-edit syntax checks on each touched file. Example: {\"patch\": \"*** Begin Patch\\n*** Update File: src/a.ts\\n-old\\n+new\\n*** End Patch\"}",
        readOnly: false,
        idempotent: false,
        parameters: {
          type: "object",
          required: ["patch"],
          properties: {
            patch: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (d) {
            const res = await d.daemon.handleRequest("POST", "/files/apply_patch", d.headers, input);
            if (res.status !== 200) {
              return { output: null, error: String(res.body.error ?? "apply_patch failed") };
            }
            return { output: res.body };
          }
          return { output: null, error: "apply_patch requires an active sandbox daemon" };
        },
      },

      {
        name: "list",
        description:
          "Lists directory contents up to depth 2 inside the workspace. Use to explore repository structure. Example: {\"path\": \".\"}",
        readOnly: true,
        idempotent: true,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (d) {
            const res = await d.daemon.handleRequest("POST", "/files/view", d.headers, {
              path: input.path ?? ".",
            });
            if (res.status !== 200) {
              return { output: null, error: String(res.body.error ?? "list failed") };
            }
            return { output: res.body.entries ?? res.body.content };
          }
          let targetDir: string;
          try {
            targetDir = resolveInside(ctx.workspaceRoot, String(input.path ?? "."));
          } catch (err) {
            return { output: null, error: (err as Error).message };
          }
          const entries = fs.readdirSync(targetDir);
          return { output: entries };
        },
      },

      {
        name: "glob",
        description:
          "Finds files matching a glob pattern in the workspace (up to 500 matches). Example: {\"pattern\": \"src/**/*.ts\"}",
        readOnly: true,
        idempotent: true,
        parameters: {
          type: "object",
          required: ["pattern"],
          properties: {
            pattern: { type: "string" },
            limit: { type: "number" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (d) {
            const res = await d.daemon.handleRequest("POST", "/search/glob", d.headers, input);
            return { output: res.body };
          }
          const pattern = String(input.pattern ?? "**/*");
          const requestedLimit = Number(input.limit ?? 100);
          const limit = Number.isFinite(requestedLimit)
            ? Math.min(500, Math.max(1, Math.floor(requestedLimit)))
            : 100;
          let matcher: RegExp;
          try {
            matcher = globToRegExp(pattern);
          } catch (err) {
            return { output: null, error: `Invalid glob pattern: ${(err as Error).message}` };
          }
          const matches = walkWorkspaceFiles(ctx.workspaceRoot)
            .filter((file) => matcher.test(file))
            .slice(0, limit);
          return { output: { pattern, matches, count: matches.length } };
        },
      },

      {
        name: "search",
        description:
          "Searches workspace files using regular expressions (ripgrep semantics) and returns matching file paths, line numbers, and excerpts. Example: {\"pattern\": \"export function\", \"limit\": 50}",
        readOnly: true,
        idempotent: true,
        parameters: {
          type: "object",
          required: ["pattern"],
          properties: {
            pattern: { type: "string" },
            limit: { type: "number" },
            caseSensitive: { type: "boolean" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (d) {
            const res = await d.daemon.handleRequest("POST", "/search/grep", d.headers, input);
            return { output: res.body };
          }
          const pattern = String(input.pattern ?? input.query ?? "");
          const requestedLimit = Number(input.limit ?? 50);
          const limit = Number.isFinite(requestedLimit)
            ? Math.min(200, Math.max(1, Math.floor(requestedLimit)))
            : 50;
          let matcher: RegExp;
          try {
            matcher = new RegExp(pattern, input.caseSensitive ? "" : "i");
          } catch (err) {
            return { output: null, error: `Invalid search pattern: ${(err as Error).message}` };
          }
          const results: Array<{ file: string; line: number; text: string }> = [];
          for (const file of walkWorkspaceFiles(ctx.workspaceRoot)) {
            if (results.length >= limit) break;
            const fullPath = path.join(ctx.workspaceRoot, file);
            try {
              if (fs.statSync(fullPath).size > 5_000_000) continue;
              const content = fs.readFileSync(fullPath, "utf8");
              if (content.includes("\u0000")) continue;
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (matcher.test(lines[i]!)) {
                  results.push({ file, line: i + 1, text: lines[i]!.slice(0, 240) });
                  if (results.length >= limit) break;
                }
              }
            } catch {
              // Skip unreadable or binary files.
            }
          }
          return { output: { pattern, results, count: results.length } };
        },
      },

      {
        name: "shell",
        description:
          "Legacy direct-process allowlisted command runner (`git`, `bun`, `node`, `python`, `python3`, `rg`, max 120s). Kept for backward compatibility; prefer `bash` when running in a sandbox.",
        readOnly: false,
        idempotent: false,
        parameters: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "array", items: { type: "string" } },
          },
        },
        execute: async (input, ctx) => {
          const argv = Array.isArray(input.command) ? input.command.map(String) : [String(input.command)];
          const bin = argv[0] ?? "";
          if (!["git", "bun", "node", "python", "python3", "rg"].includes(bin)) {
            return { output: null, error: `Command "${bin}" is not in the local shell allowlist` };
          }
          const res = spawnSync(bin, argv.slice(1), {
            cwd: ctx.workspaceRoot,
            encoding: "utf8",
            timeout: 120_000,
          });
          return {
            output: (res.stdout ?? "") + (res.stderr ?? ""),
            error: res.status !== 0 ? `Exited with code ${res.status}` : undefined,
          };
        },
      },

      // 2. Sandbox-backed persistent shell & process tools (§6 Phase D)
      {
        name: "bash",
        description:
          "Executes a command in the persistent sandbox shell session. Preserves working directory (`cwd`) and exported environment variables across calls. Timeout up to `limits.maxCommandSec` (default 1,800s); returns `status: \"still_running\"` on idle timeout so you can inspect partial output, send input with `bash_input`, or stop with `bash_interrupt`. Example: {\"command\": \"npm test\", \"timeoutSec\": 300}",
        readOnly: false,
        idempotent: false,
        requiresSandbox: true,
        parameters: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string" },
            sessionId: { type: "string" },
            timeoutSec: { type: "number" },
            idleTimeoutSec: { type: "number" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "bash requires an active sandbox" };
          const sid = String(input.sessionId ?? "main");
          const maxCmdSec = ctx.state.budgets.maxCommandSec ?? 1800;
          const timeoutSec = Math.min(maxCmdSec, Number(input.timeoutSec ?? 120));
          const res = await d.daemon.handleRequest(
            "POST",
            `/shell/${sid}/exec`,
            d.headers,
            {
              command: input.command,
              timeoutSec,
              idleTimeoutSec: input.idleTimeoutSec ?? timeoutSec,
            }
          );
          if (res.status !== 200) {
            return { output: res.body.output, error: String(res.body.error ?? "bash failed") };
          }
          return {
            output: res.body,
            error:
              typeof res.body.exitCode === "number" && res.body.exitCode !== 0
                ? `Command exited with code ${res.body.exitCode}`
                : undefined,
          };
        },
      },

      {
        name: "bash_input",
        description:
          "Sends standard input (`stdin`) to a command that returned `status: \"still_running\"` in a persistent sandbox shell session. Example: {\"input\": \"y\\n\", \"sessionId\": \"main\"}",
        readOnly: false,
        idempotent: false,
        requiresSandbox: true,
        parameters: {
          type: "object",
          required: ["input"],
          properties: {
            input: { type: "string" },
            sessionId: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "bash_input requires an active sandbox" };
          const sid = String(input.sessionId ?? "main");
          const res = await d.daemon.handleRequest("POST", `/shell/${sid}/input`, d.headers, input);
          return { output: res.body, error: res.status !== 200 ? String(res.body.error) : undefined };
        },
      },

      {
        name: "bash_interrupt",
        description:
          "Sends SIGINT (Ctrl-C) to interrupt a still-running command in a persistent sandbox shell session. Example: {\"sessionId\": \"main\"}",
        readOnly: false,
        idempotent: true,
        requiresSandbox: true,
        parameters: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "bash_interrupt requires an active sandbox" };
          const sid = String(input.sessionId ?? "main");
          const res = await d.daemon.handleRequest("POST", `/shell/${sid}/interrupt`, d.headers, {});
          return { output: res.body };
        },
      },

      {
        name: "process_start",
        description:
          "Starts a long-lived background process (such as a dev server or watcher) inside the sandbox and detects listening ports. Set waitFor to wait until its HTTP endpoint responds before continuing. Example: {\"command\": \"npm run dev -- --host 0.0.0.0\", \"port\": 3000, \"waitFor\": {\"path\": \"/\", \"timeoutSec\": 60}}",
        readOnly: false,
        idempotent: false,
        requiresSandbox: true,
        parameters: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string" },
            cwd: { type: "string" },
            port: { type: "number" },
            waitFor: { type: "object", properties: { port: { type: "number" }, path: { type: "string" }, timeoutSec: { type: "number" } } },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "process_start requires an active sandbox" };
          const { waitFor, ...startInput } = input;
          const res = await d.daemon.handleRequest("POST", "/processes", d.headers, startInput);
          let body = res.body as Record<string, unknown>;
          let readinessError: string | undefined;
          if (res.status === 200 && typeof waitFor === "object" && waitFor !== null && typeof body.id === "string") {
            const ready = await d.daemon.handleRequest("POST", `/processes/${encodeURIComponent(body.id)}/wait`, d.headers, waitFor as Record<string, unknown>);
            body = { ...body, readiness: ready.body };
            if (ready.status !== 200) readinessError = String((ready.body as Record<string, unknown>).error ?? `Server readiness check failed with HTTP ${ready.status}`);
          }
          const port = typeof body.port === "number" ? body.port : Number(input.port);
          const externalUrl = Number.isFinite(port) && ctx.sandboxHandleId
            ? await this.opts.resolvePreviewUrl?.(ctx.sandboxHandleId, port)
            : undefined;
          return {
            output: externalUrl && port > 0
              ? { ...body, previewUrl: externalUrl, internalUrl: `http://127.0.0.1:${port}` }
              : body,
            error: res.status !== 200
              ? (typeof res.body.error === "string" ? res.body.error : `process_start failed with HTTP ${res.status}`)
              : readinessError,
          };
        },
      },

      {
        name: "process_logs",
        description:
          "Reads incremental stdout/stderr logs from a background process started with `process_start`. Example: {\"id\": \"proc_1\", \"since\": 0}",
        readOnly: true,
        idempotent: true,
        requiresSandbox: true,
        parameters: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            since: { type: "number" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "process_logs requires an active sandbox" };
          const since = Number(input.since ?? 0);
          let res = await d.daemon.handleRequest("GET", `/processes/${String(input.id)}/logs?since=${since}`, d.headers);
          const deadline = Date.now() + 3_000;
          while (res.status === 200 && !String((res.body as Record<string, unknown>).logs ?? "").trim() && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            res = await d.daemon.handleRequest("GET", `/processes/${String(input.id)}/logs?since=${since}`, d.headers);
          }
          const body = res.body as Record<string, unknown>;
          if (res.status !== 200) {
            const error = typeof body.error === "string" && body.error ? body.error : `process_logs failed with HTTP ${res.status}`;
            return { output: { error }, error };
          }
          const rawPreviewUrl = typeof body.previewUrl === "string" ? body.previewUrl : undefined;
          const portFromUrl = rawPreviewUrl?.match(/^https?:\/\/127\.0\.0\.1:(\d+)/)?.[1];
          const port = typeof body.port === "number" ? body.port : Number(portFromUrl);
          const externalUrl = rawPreviewUrl && Number.isFinite(port) && port > 0 && ctx.sandboxHandleId
            ? await this.opts.resolvePreviewUrl?.(ctx.sandboxHandleId, port)
            : undefined;
          return {
            output: externalUrl && rawPreviewUrl
              ? { ...body, previewUrl: externalUrl, internalUrl: rawPreviewUrl }
              : body,
            error: undefined,
          };
        },
      },

      {
        name: "process_stop",
        description:
          "Stops a background process by ID. Example: {\"id\": \"proc_1\"}",
        readOnly: false,
        idempotent: true,
        requiresSandbox: true,
        parameters: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "process_stop requires an active sandbox" };
          const res = await d.daemon.handleRequest(
            "DELETE",
            `/processes/${String(input.id)}`,
            d.headers
          );
          return { output: res.body, error: res.status !== 200 ? String(res.body.error) : undefined };
        },
      },

      {
        name: "service_start",
        description: "Start an isolated PostgreSQL, Redis, or SQLite service inside this sandbox and return local connection environment variables. Services bind to localhost and their data stays in the session workspace.",
        readOnly: false,
        idempotent: true,
        requiresSandbox: true,
        parameters: { type: "object", required: ["service"], properties: { service: { type: "string", enum: ["postgres", "redis", "sqlite"] } } },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "service_start requires an active sandbox" };
          const res = await d.daemon.handleRequest("POST", "/services", d.headers, input);
          return { output: res.body, error: res.status === 200 ? undefined : String((res.body as any).error ?? `service_start failed with HTTP ${res.status}`) };
        },
      },

      {
        name: "preview_url",
        description:
          "Returns the host-reachable preview URL for a listening port inside the sandbox. Example: {\"port\": 3000}",
        readOnly: true,
        idempotent: true,
        requiresSandbox: true,
        parameters: {
          type: "object",
          properties: {
            port: { type: "number" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "preview_url requires an active sandbox" };
          const res = await d.daemon.handleRequest("GET", "/ports", d.headers);
          const ports = (res.body.ports as Array<{ port: number; previewUrl: string }>) ?? [];
          const resolvePort = async (entry: { port: number; previewUrl: string }) => {
            const externalUrl = ctx.sandboxHandleId
              ? await this.opts.resolvePreviewUrl?.(ctx.sandboxHandleId, entry.port)
              : undefined;
            return externalUrl
              ? { ...entry, previewUrl: externalUrl, internalUrl: `http://127.0.0.1:${entry.port}` }
              : entry;
          };
          if (typeof input.port === "number") {
            const match = ports.find((p) => p.port === input.port);
            const entry = match ?? { port: input.port, previewUrl: `http://127.0.0.1:${input.port}` };
            return { output: await resolvePort(entry) };
          }
          const resolvedPorts = await Promise.all(ports.map(resolvePort));
          return {
            output: {
              ports: resolvedPorts,
              ...(resolvedPorts[0]
                ? {
                    port: resolvedPorts[0].port,
                    previewUrl: resolvedPorts[0].previewUrl,
                    ...(typeof (resolvedPorts[0] as { internalUrl?: unknown }).internalUrl === "string"
                      ? { internalUrl: (resolvedPorts[0] as { internalUrl: string }).internalUrl }
                      : {}),
                  }
                : {}),
            },
          };
        },
      },

      // 2b. Sandbox lifecycle tools (explicit create/status/stop as tool calls)
      {
        name: "sandbox_create",
        description:
          "Creates or reuses the run's sandbox and returns its `sandboxId` and `workspacePath`. Use before running commands if no sandbox is active. Example: {}",
        readOnly: false,
        idempotent: true,
        parameters: { type: "object", properties: {} },
        execute: async (_input, ctx) => {
          if (!this.opts.ensureSandbox) {
            return {
              output: null,
              error: "sandbox_create is unavailable: no sandbox provider is configured",
            };
          }
          const h = await this.opts.ensureSandbox(ctx.state);
          ctx.sandboxHandleId = h.id;
          ctx.state.sandboxHandleId = h.id;
          return { output: { sandboxId: h.id, workspacePath: h.workspacePath } };
        },
      },

      {
        name: "sandbox_status",
        description:
          "Returns the active sandbox id, whether it is running, and the listening preview ports. Example: {}",
        readOnly: true,
        idempotent: true,
        parameters: { type: "object", properties: {} },
        execute: async (_input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) {
            return { output: { active: false, sandboxId: ctx.sandboxHandleId ?? null } };
          }
          const portsRes = await d.daemon
            .handleRequest("GET", "/ports", d.headers)
            .catch(() => null);
          return {
            output: {
              active: true,
              sandboxId: ctx.sandboxHandleId ?? null,
              ports: portsRes?.body?.ports ?? [],
            },
          };
        },
      },

      {
        name: "sandbox_stop",
        description:
          "Stops and releases the run's sandbox. Use when the task is finished and no more commands, servers, or browser checks are needed. Example: {}",
        readOnly: false,
        idempotent: true,
        parameters: { type: "object", properties: {} },
        execute: async (_input, ctx) => {
          const sandboxId = ctx.sandboxHandleId ?? null;
          if (this.opts.onSandboxStop) {
            return this.opts.onSandboxStop(ctx);
          }
          ctx.state.sandboxHandleId = null;
          ctx.sandboxHandleId = null;
          return { output: { stopped: true, sandboxId } };
        },
      },

      // 3. Browser tools (§6 Phase D)
      {
        name: "browser_navigate",
        description:
          "Navigates the headless Chromium browser inside the sandbox to a URL (such as a local dev server preview URL). Output is marked untrusted. Example: {\"url\": \"http://127.0.0.1:3000\"}",
        readOnly: false,
        idempotent: true,
        requiresSandbox: true,
        parameters: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string" },
            html: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "browser_navigate requires an active sandbox" };
          const res = await d.daemon.handleRequest("POST", "/browser/navigate", d.headers, input);
          return {
            output: res.body,
            error: res.status !== 200 ? String(res.body.error) : undefined,
            untrusted: true,
            provenance: `browser:${String(input.url)}`,
          };
        },
      },

      {
        name: "browser_snapshot",
        description:
          "Returns the current page's accessibility tree with `[ref=eN]` element handles for interaction. Output is marked untrusted. Example: {}",
        readOnly: true,
        idempotent: true,
        requiresSandbox: true,
        parameters: { type: "object", properties: {} },
        execute: async (_input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "browser_snapshot requires an active sandbox" };
          const res = await d.daemon.handleRequest("POST", "/browser/snapshot", d.headers, {});
          return {
            output: res.body,
            untrusted: true,
            provenance: "browser:snapshot",
          };
        },
      },

      {
        name: "browser_click",
        description:
          "Clicks an element in the page using its `[ref=eN]` handle from `browser_snapshot`. Example: {\"ref\": \"e1\"}",
        readOnly: false,
        idempotent: false,
        requiresSandbox: true,
        parameters: {
          type: "object",
          required: ["ref"],
          properties: { ref: { type: "string" } },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "browser_click requires an active sandbox" };
          const res = await d.daemon.handleRequest("POST", "/browser/click", d.headers, input);
          return { output: res.body, error: res.status !== 200 ? String(res.body.error) : undefined };
        },
      },

      {
        name: "browser_type",
        description:
          "Types text into an input element identified by `[ref=eN]`. Example: {\"ref\": \"e2\", \"text\": \"hello\"}",
        readOnly: false,
        idempotent: false,
        requiresSandbox: true,
        parameters: {
          type: "object",
          required: ["ref", "text"],
          properties: {
            ref: { type: "string" },
            text: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "browser_type requires an active sandbox" };
          const res = await d.daemon.handleRequest("POST", "/browser/type", d.headers, input);
          return { output: res.body, error: res.status !== 200 ? String(res.body.error) : undefined };
        },
      },

      {
        name: "browser_press",
        description:
          "Presses a keyboard key (such as `Enter`, `Tab`, `Escape`) in the browser. Example: {\"key\": \"Enter\"}",
        readOnly: false,
        idempotent: false,
        requiresSandbox: true,
        parameters: {
          type: "object",
          required: ["key"],
          properties: { key: { type: "string" } },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "browser_press requires an active sandbox" };
          const res = await d.daemon.handleRequest("POST", "/browser/press", d.headers, input);
          return { output: res.body };
        },
      },

      {
        name: "browser_screenshot",
        description:
          "Captures a PNG screenshot of the current browser viewport for visual UI verification. Example: {}",
        readOnly: true,
        idempotent: true,
        requiresSandbox: true,
        parameters: { type: "object", properties: {} },
        execute: async (_input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "browser_screenshot requires an active sandbox" };
          const res = await d.daemon.handleRequest("POST", "/browser/screenshot", d.headers, {});
          return { output: res.body };
        },
      },

      {
        name: "browser_console",
        description:
          "Returns browser console logs and network errors captured during page load and interaction. Example: {}",
        readOnly: true,
        idempotent: true,
        requiresSandbox: true,
        parameters: { type: "object", properties: {} },
        execute: async (_input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "browser_console requires an active sandbox" };
          const logs = await d.daemon.handleRequest("GET", "/browser/console_logs", d.headers);
          const errs = await d.daemon.handleRequest("GET", "/browser/network_errors", d.headers);
          return {
            output: {
              consoleLogs: logs.body.logs,
              networkErrors: errs.body.errors,
            },
          };
        },
      },

      {
        name: "browser_check_def",
        description: "Define and immediately run a repeatable browser verification flow against this run's local preview. Once defined, do not weaken or replace it.",
        readOnly: false,
        idempotent: false,
        requiresSandbox: true,
        parameters: {
          type: "object",
          required: ["name", "steps"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            port: { type: "integer", minimum: 1024, maximum: 65535 },
            steps: { type: "array", minItems: 1, maxItems: 30, items: { type: "object" } },
            failOnConsoleErrors: { type: "boolean" },
          },
        },
        execute: async (input, ctx) => {
          const name = String(input.name ?? "").trim();
          const steps = Array.isArray(input.steps) ? input.steps as BrowserCheckStep[] : [];
          if (!name || name.length > 80) return { output: null, error: "Browser check name must contain 1 to 80 characters" };
          if (!steps.length || steps.length > 30) return { output: null, error: "A browser check must contain 1 to 30 steps" };
          const attempts = ctx.state.browserCheckAttempts ?? (ctx.state.browserCheckAttempts = {});
          const totalAttempts = (attempts[name] ?? 0) + 1;
          attempts[name] = totalAttempts;
          const maxDefinitions = Math.max(1, Number(process.env.OH_MAX_INPUT_FIXED_COUNT ?? 5));
          const check: BrowserCheck = {
            name,
            ...(Number.isInteger(input.port) ? { port: Number(input.port) } : {}),
            steps,
            failOnConsoleErrors: input.failOnConsoleErrors !== false,
            createdAt: Date.now(),
          };
          for (const step of steps) {
            if (!step || typeof step !== "object" || Array.isArray(step)) return { output: null, error: "Each browser check step must be an object" };
            if ("wait" in step && (!Number.isFinite(Number(step.wait)) || Number(step.wait) < 0 || Number(step.wait) > 5_000)) {
              return { output: null, error: "Browser check waits must be between 0 and 5000 ms" };
            }
            if ("goto" in step && typeof step.goto !== "string") return { output: null, error: "goto must be a URL or path" };
            if ("expectText" in step && ![step.equals, step.contains, step.matches].some((value) => typeof value === "string")) {
              return { output: null, error: "expectText requires equals, contains, or matches" };
            }
            if ("expectVisible" in step && step.timeoutMs !== undefined &&
                (!Number.isFinite(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > 5_000)) {
              return { output: null, error: "expectVisible timeoutMs must be between 1 and 5000" };
            }
            for (const key of ["click", "fill", "expectVisible", "expectText"] as const) {
              if (key in step) {
                const target = step[key as keyof typeof step] as Record<string, unknown>;
                if (!target || typeof target !== "object" || !(
                  (typeof target.role === "string" && typeof target.name === "string") ||
                  typeof target.label === "string" || typeof target.text === "string" || typeof target.css === "string"
                )) return { output: null, error: `${key} target needs role/name, label, text, or css` };
              }
            }
          }
          const existing = ctx.state.browserChecks ?? (ctx.state.browserChecks = []);
          const sameName = existing.find((item) => item.name === name);
          if (sameName) {
            const normalize = (value: BrowserCheck) => JSON.stringify({ port: value.port, steps: value.steps, failOnConsoleErrors: value.failOnConsoleErrors });
            if (normalize(sameName) !== normalize(check)) {
              ctx.state.browserChecksHistory ??= [];
              ctx.state.browserChecksHistory.push(structuredClone(sameName));
              ctx.state.browserCheckTampering ??= [];
              ctx.state.browserCheckTampering.push(name);
              return { output: null, error: `Browser check "${name}" is immutable. The original definition was preserved and this change is flagged for review.` };
            }
          } else {
            if (existing.length >= 10) return { output: null, error: "A run may define at most 10 browser checks" };
            existing.push(check);
          }
          const selected = sameName ?? check;
          const d = await this.getDaemonAndHeaders(ctx);
          const ports = await d.daemon.handleRequest("GET", "/ports", d.headers);
          const knownPorts = Array.isArray(ports.body.ports) ? (ports.body.ports as Array<{ port: number }>).map((entry) => entry.port) : [];
          const port = selected.port ?? (ctx.state.previewUrl ? Number(new URL(ctx.state.previewUrl).port) : undefined) ?? knownPorts[knownPorts.length - 1];
          if (!port || !knownPorts.includes(port)) return { output: null, error: "Browser check requires a port started by this run" };
          const res = await d.daemon.handleRequest("POST", "/browser/run_flow", d.headers, { port, steps: selected.steps, failOnConsoleErrors: selected.failOnConsoleErrors });
          const result = res.body as Record<string, any>;
          const { screenshotJpegBase64: _screenshot, ...safeResult } = result;
          return { output: { check: name, ...safeResult, evidence: formatBrowserEvidence(name, selected.steps.length, result, "") }, error: result.passed ? undefined : String(result.error ?? "Browser check failed") };
        },
      },

      {
        name: "browser_check_run",
        description: "Run one named browser check or all checks defined for this run and return their visible evidence.",
        readOnly: true,
        idempotent: true,
        requiresSandbox: true,
        parameters: { type: "object", properties: { name: { type: "string" } } },
        execute: async (input, ctx) => {
          const checks = ctx.state.browserChecks ?? [];
          const selected = input.name ? checks.filter((check) => check.name === String(input.name)) : checks;
          if (!selected.length) return { output: null, error: input.name ? `Browser check "${String(input.name)}" not found` : "No browser checks are defined" };
          const d = await this.getDaemonAndHeaders(ctx);
          const portsRes = await d.daemon.handleRequest("GET", "/ports", d.headers);
          const ports = Array.isArray(portsRes.body.ports) ? (portsRes.body.ports as Array<{ port: number }>).map((entry) => entry.port) : [];
          const results: Array<Record<string, any>> = [];
          for (const check of selected) {
            const port = check.port ?? (ctx.state.previewUrl ? Number(new URL(ctx.state.previewUrl).port) : undefined) ?? ports[ports.length - 1];
            if (!port || !ports.includes(port)) return { output: results, error: `Browser check "${check.name}" has no active preview port` };
            let response = await d.daemon.handleRequest("POST", "/browser/run_flow", d.headers, { port, steps: check.steps, failOnConsoleErrors: check.failOnConsoleErrors });
            let result = response.body as Record<string, any>;
            if (!result.passed && /timeout|timed out/i.test(String(result.error ?? ""))) {
              response = await d.daemon.handleRequest("POST", "/browser/run_flow", d.headers, { port, steps: check.steps, failOnConsoleErrors: check.failOnConsoleErrors });
              result = response.body as Record<string, any>;
            }
            const { screenshotJpegBase64: _screenshot, ...safeResult } = result;
            results.push({ check: check.name, ...safeResult, evidence: formatBrowserEvidence(check.name, check.steps.length, result, "") });
          }
          return { output: { results, evidence: results.map((result) => result.evidence).join("\n\n") }, error: results.some((result) => !result.passed) ? "One or more browser checks failed" : undefined };
        },
      },

      // 4. Webfetch, Todo, Feature List, Progress Note, Memory, Checkpoint, Handoff (§6 Phase D)
      {
        name: "webfetch",
        description:
          "Fetches an HTTP(S) URL, converts HTML to readable text, paginates with offset and limit, and marks the result as untrusted external data. Example: {\"url\": \"https://nodejs.org/en/docs\"}",
        readOnly: true,
        idempotent: true,
        parameters: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string" },
            offset: { type: "number" },
            limit: { type: "number" },
          },
        },
        execute: async (input, ctx) => {
          const url = String(input.url ?? "");
          if (typeof input.mockContent === "string") {
            const content = `<untrusted_content source="${url}">\n# Fetched from ${url}\n${input.mockContent}\n</untrusted_content>`;
            return {
              output: content,
              untrusted: true,
              provenance: `webfetch:${url}`,
            };
          }

          let parsedUrl: URL;
          try {
            parsedUrl = new URL(url);
            if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
              throw new Error("Only HTTP and HTTPS URLs are supported");
            }
          } catch (err) {
            return { output: null, error: `Invalid webfetch URL: ${(err as Error).message}` };
          }

          let response: Response;
          try {
            response = await fetch(parsedUrl, {
              headers: { "User-Agent": "OpenHarness/1.0" },
              signal: ctx.signal
                ? AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)])
                : AbortSignal.timeout(15_000),
            });
          } catch (err) {
            return { output: null, error: `webfetch failed: ${(err as Error).message}` };
          }
          if (!response.ok) {
            return { output: null, error: `webfetch failed: HTTP ${response.status} ${response.statusText}` };
          }

          const readable = htmlToReadableText(await response.text());
          const requestedOffset = Number(input.offset ?? 0);
          const requestedLimit = Number(input.limit ?? 12_000);
          const offset = Number.isFinite(requestedOffset)
            ? Math.max(0, Math.floor(requestedOffset))
            : 0;
          const limit = Number.isFinite(requestedLimit)
            ? Math.min(50_000, Math.max(1, Math.floor(requestedLimit)))
            : 12_000;
          const sourceUrl = parsedUrl.href
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;");
          const content = `<untrusted_content source="${sourceUrl}">\n# Fetched from ${parsedUrl.href}\n${readable.slice(offset, offset + limit)}\n</untrusted_content>`;
          return {
            output: content,
            untrusted: true,
            provenance: `webfetch:${url}`,
          };
        },
      },

      {
        name: "update_plan",
        description:
          "Publishes or updates the structured execution plan (`title`, `explanation`, `steps`, `acceptance`, `verification`). In `plan` mode all steps are published as `pending`. Example: {\"title\": \"Add feature X\", \"steps\": [{\"id\": \"1\", \"title\": \"Write implementation\", \"status\": \"pending\"}]}",
        readOnly: true,
        idempotent: true,
        parameters: {
          type: "object",
          required: ["title", "steps"],
          properties: {
            title: { type: "string" },
            explanation: { type: "string" },
            steps: {
              type: "array",
              items: {
                type: "object",
                required: ["title"],
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
                  detail: { type: "string" },
                },
              },
            },
            acceptance: { type: "array", items: { type: "string" } },
            verification: { type: "array", items: { type: "string" } },
          },
        },
        execute: async (input, ctx) => {
          const isPlanMode = ctx.state.agent === "plan" || ctx.state.phase === "planning";
          const rawSteps = Array.isArray(input.steps) ? input.steps : [];
          const steps = rawSteps.map((s: Record<string, unknown>, idx: number) => ({
            id: String(s.id ?? idx + 1),
            title: String(s.title ?? s.step ?? s.content ?? s.description ?? `Step ${idx + 1}`),
            status: isPlanMode
              ? ("pending" as const)
              : ((s.status as "pending" | "in_progress" | "completed" | "blocked") ?? "pending"),
            detail: typeof s.detail === "string" ? s.detail : undefined,
          }));
          const plan: PlanData = {
            title: String(input.title ?? "Execution Plan"),
            explanation: typeof input.explanation === "string" ? input.explanation : undefined,
            steps,
            acceptance: Array.isArray(input.acceptance) ? input.acceptance.map(String) : undefined,
            verification: Array.isArray(input.verification) ? input.verification.map(String) : undefined,
          };
          ctx.state.plan = plan;
          return {
            output: plan,
            metadata: { plan },
          };
        },
      },

      {
        name: "todo_write",
        description:
          "Updates the structured sub-step todo list for the current feature or task. Re-rendered automatically every N turns (recitation) to keep your focus sharp. Example: {\"todos\": [{\"id\": \"t1\", \"content\": \"Add unit test\", \"status\": \"in_progress\"}]}",
        readOnly: true,
        idempotent: true,
        parameters: {
          type: "object",
          required: ["todos"],
          properties: {
            todos: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  content: { type: "string" },
                  title: { type: "string" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
                  priority: { type: "string", enum: ["low", "medium", "high"] },
                },
              },
            },
          },
        },
        execute: async (input, ctx) => {
          const raw = Array.isArray(input.todos) ? input.todos : [];
          const todos: TodoItem[] = raw.map((t: Record<string, unknown>, idx: number) => ({
            id: String(t.id ?? idx + 1),
            content: String(t.content ?? t.title ?? ""),
            status:
              (t.status as "pending" | "in_progress" | "completed" | "cancelled") ?? "pending",
            priority: (t.priority as "low" | "medium" | "high") ?? "medium",
          }));
          ctx.state.todos = todos;
          return { output: { todos } };
        },
      },

      {
        name: "todo_read",
        description:
          "Reads the current structured todo list. Example: {}",
        readOnly: true,
        idempotent: true,
        parameters: { type: "object", properties: {} },
        execute: async (_input, ctx) => {
          return { output: { todos: ctx.state.todos } };
        },
      },

      {
        name: "feature_list",
        description:
          "Reads the long-horizon task's `feature_list.json` or marks a feature as `in_progress`. You may NEVER delete features, modify `acceptance`/`verification` criteria, or set `status: \"passing\"` (only the harness sets `passing` after verification and review pass). Example: {\"action\": \"start\", \"featureId\": \"feat-1\"}",
        readOnly: false,
        idempotent: true,
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "start"] },
            featureId: { type: "string" },
            status: { type: "string" },
            taskId: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          const taskId = String(input.taskId ?? "default");
          let file: string;
          try {
            file = resolveInside(ctx.workspaceRoot, path.join(".openharness", "task", taskId, "feature_list.json"));
          } catch (err) {
            return { output: null, error: (err as Error).message };
          }
          const features: FeatureItem[] = fs.existsSync(file)
            ? (JSON.parse(fs.readFileSync(file, "utf8")) as FeatureItem[])
            : ctx.state.features;

          if (input.status && input.status !== "in_progress") {
            return {
              output: null,
              error: `Model may only flip a feature status to "in_progress" (requested: "${String(input.status)}"). Only the harness sets "passing" after verification and review succeed.`,
            };
          }
          if (input.action === "start" || input.featureId) {
            const targetId = String(input.featureId ?? "");
            const item = features.find((f) => f.id === targetId);
            if (!item) {
              return { output: null, error: `Feature "${targetId}" not found` };
            }
            item.status = "in_progress";
            ctx.state.featureId = targetId;
            if (fs.existsSync(file)) {
              fs.writeFileSync(file, JSON.stringify(features, null, 2), "utf8");
            }
          }
          return { output: { features } };
        },
      },

      {
        name: "progress_note",
        description:
          "Appends a timestamped progress note to `.openharness/task/<taskId>/progress.md`. Append-only; survives context resets and handoffs. Example: {\"note\": \"Completed auth middleware; starting token validation tests.\"}",
        readOnly: false,
        idempotent: false,
        parameters: {
          type: "object",
          required: ["note"],
          properties: {
            note: { type: "string" },
            taskId: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          const taskId = String(input.taskId ?? "default");
          let dir: string;
          let file: string;
          try {
            dir = resolveInside(ctx.workspaceRoot, path.join(".openharness", "task", taskId));
            fs.mkdirSync(dir, { recursive: true });
            file = resolveInside(ctx.workspaceRoot, path.join(".openharness", "task", taskId, "progress.md"));
          } catch (err) {
            return { output: null, error: (err as Error).message };
          }
          const entry = `\n### [${new Date().toISOString()}] (run: ${ctx.runId})\n${String(input.note ?? "")}\n`;
          fs.appendFileSync(file, entry, "utf8");
          return { output: { appended: true, path: `.openharness/task/${taskId}/progress.md` } };
        },
      },

      {
        name: "memory",
        description:
          "File-based persistent memory tool (`view`, `create`, `str_replace`, `delete`) stored under `/memories` per project (Anthropic memory-tool semantics). Survives across sessions and compactions. Example: {\"command\": \"create\", \"path\": \"architecture.md\", \"file_text\": \"Key invariants...\"}",
        readOnly: false,
        idempotent: false,
        parameters: {
          type: "object",
          required: ["command", "path"],
          properties: {
            command: { type: "string", enum: ["view", "create", "str_replace", "delete"] },
            path: { type: "string" },
            file_text: { type: "string" },
            old_str: { type: "string" },
            new_str: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          const memDir = path.join(ctx.workspaceRoot, ".openharness", "memories");
          fs.mkdirSync(memDir, { recursive: true });
          const rel = String(input.path ?? "").replace(/^\/?memories\/?/, "");
          let target: string;
          try {
            target = resolveInside(memDir, rel || ".");
          } catch (err) {
            return { output: null, error: "Memory path escapes /memories root" };
          }
          const cmd = String(input.command ?? "view");
          if (cmd === "view") {
            if (!fs.existsSync(target)) return { output: null, error: `Memory not found: ${rel}` };
            if (fs.statSync(target).isDirectory()) {
              return { output: fs.readdirSync(target) };
            }
            return { output: fs.readFileSync(target, "utf8") };
          }
          if (cmd === "create") {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, String(input.file_text ?? ""), "utf8");
            return { output: { created: rel } };
          }
          if (cmd === "str_replace") {
            if (!fs.existsSync(target)) return { output: null, error: `Memory not found: ${rel}` };
            const orig = fs.readFileSync(target, "utf8");
            const oldStr = String(input.old_str ?? "");
            const newStr = String(input.new_str ?? "");
            if (!orig.includes(oldStr)) {
              return { output: null, error: `old_str not found in /memories/${rel}` };
            }
            fs.writeFileSync(target, orig.replace(oldStr, () => newStr), "utf8");
            return { output: { updated: rel } };
          }
          if (cmd === "delete") {
            if (fs.existsSync(target)) fs.unlinkSync(target);
            return { output: { deleted: rel } };
          }
          return { output: null, error: `Unknown memory command: ${cmd}` };
        },
      },

      {
        name: "checkpoint",
        description:
          "Creates a named shadow-git checkpoint of the entire workspace without touching user `.git` history. Example: {\"message\": \"Before refactoring router\"}",
        readOnly: false,
        idempotent: true,
        parameters: {
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (d) {
            const res = await d.daemon.handleRequest("POST", "/checkpoints/create", d.headers, input);
            if (typeof res.body.sha === "string") {
              ctx.state.lastCheckpoint = res.body.sha;
            }
            return { output: res.body };
          }
          return {
            output: {
              sha: `cp_${Date.now()}`,
              message: String(input.message ?? "Checkpoint"),
              createdAt: Date.now(),
            },
          };
        },
      },

      {
        name: "verify",
        description:
          "Runs the verification recipe (`typecheck`, `server-build`, `web-build`, `diff-check`, or configured/auto-detected project checks) inside the sandbox. Example: {\"commands\": [\"typecheck\"]}",
        readOnly: true,
        idempotent: true,
        parameters: {
          type: "object",
          properties: {
            commands: { type: "array", items: { type: "string" } },
          },
        },
        execute: async (input, ctx) => {
          if (this.opts.onVerify) {
            const cmds = Array.isArray(input.commands) ? input.commands.map(String) : undefined;
            return this.opts.onVerify(cmds, ctx);
          }
          return { output: { passed: true, commands: input.commands ?? ["typecheck"] } };
        },
      },

      {
        name: "delegate",
        description:
          "Runs a subagent in the same workspace with its own context and step budget. Read-only agents may run in parallel; write-capable agents run one at a time. Roles: explore, tester, reviewer, general.",
        readOnly: true,
        idempotent: false,
        parameters: {
          type: "object",
          required: ["prompt"],
          properties: {
            agent: { type: "string" },
            prompt: { type: "string" },
            tools: { type: "array", items: { type: "string" } },
            budget: {
              type: "object",
              properties: {
                maxIterations: { type: "integer", minimum: 1, maximum: 25 },
              },
            },
            background: { type: "boolean" },
            worktree: { type: "boolean" },
          },
        },
        execute: async (input, ctx) => {
          if (this.opts.onDelegate) {
            return this.opts.onDelegate(input, ctx);
          }
          return {
            output: {
              taskId: `task_${Date.now()}`,
              agent: String(input.agent ?? "explore"),
              status: "completed",
              report: `Subagent completed exploration for: ${String(input.prompt).slice(0, 120)}`,
            },
          };
        },
      },

      {
        name: "ask_user",
        description:
          "Asks the user a clarifying question and pauses the run until the user answers. Use ONLY when the request is genuinely ambiguous and blocks implementation (max 3 questions per run). Example: {\"question\": \"Which database should I use?\", \"options\": [\"SQLite\", \"Postgres\"]}",
        readOnly: true,
        idempotent: false,
        parameters: {
          type: "object",
          required: ["question"],
          properties: {
            question: { type: "string" },
            options: { type: "array", items: { type: "string" } },
          },
        },
        execute: async (input) => {
          return {
            output: {
              question: String(input.question ?? ""),
              answer: String(input.answer ?? "Proceed with default."),
            },
          };
        },
      },

      {
        name: "request_takeover",
        description: "Pause and ask the user to take browser control for login, CAPTCHA, 2FA, payment, or another blocked page. The run resumes when the user returns control.",
        readOnly: true,
        idempotent: false,
        source: "builtin",
        parameters: {
          type: "object",
          required: ["reason"],
          properties: { reason: { type: "string" }, instructions: { type: "string" } },
        },
        execute: async (input, ctx) => {
          const reason = String(input.reason ?? "Human help needed").trim().slice(0, 1_000);
          const instructions = typeof input.instructions === "string" ? input.instructions.slice(0, 2_000) : undefined;
          ctx.state.takeoverRequested = true;
          ctx.state.takeover = { reason, instructions, requestedBy: "agent", requestedAt: Date.now() };
          return { output: { takeoverRequested: true, reason } };
        },
      },

      {
        name: "handoff",
        description:
          "Ends the current context window cleanly and starts a fresh context seeded with your written brief, the feature list, the tail of `progress.md`, and the shadow git log. Use at feature boundaries or when context gets heavy. Example: {\"brief\": \"Feature 1 is passing; next start Feature 2 in src/api.ts.\"}",
        readOnly: false,
        idempotent: true,
        parameters: {
          type: "object",
          required: ["brief"],
          properties: {
            brief: { type: "string" },
          },
        },
        execute: async (input, ctx) => {
          if (this.opts.onHandoff) {
            return this.opts.onHandoff(String(input.brief ?? ""), ctx);
          }
          return { output: { handoffInitiated: true, brief: input.brief } };
        },
      },

      {
        name: "ipython",
        description:
          "Executes Python code in the sandbox for data inspection and scripting. Example: {\"code\": \"print(2 + 2)\"}",
        readOnly: false,
        idempotent: false,
        requiresSandbox: true,
        parameters: {
          type: "object",
          required: ["code"],
          properties: { code: { type: "string" } },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "ipython requires an active sandbox" };
          const res = await d.daemon.handleRequest("POST", "/ipython/exec", d.headers, input);
          return { output: res.body };
        },
      },
    ];
  }
}

function compactToolDescription(description?: string): string | undefined {
  if (!description) return description;
  const withoutExample = description.replace(/\s*Example:\s*[\s\S]*$/i, "").trim();
  return withoutExample.length > 240 ? `${withoutExample.slice(0, 237).trimEnd()}…` : withoutExample;
}

export const SandboxToolRouter = StandardToolRouter;
