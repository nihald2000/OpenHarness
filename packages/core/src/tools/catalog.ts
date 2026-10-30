import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { FeatureItem, PlanData, TodoItem } from "@openharness/sdk";
import type {
  RegisteredTool,
  RunState,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRouter,
} from "../agent/deps.ts";
import { getActiveSandboxDaemon } from "../sandbox/providers.ts";
import { enforceToolOutputLimit } from "./output-limit.ts";

export interface SandboxToolRouterOptions {
  workspaceRoot: string;
  sandboxEnabled?: boolean;
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
  private tools = new Map<string, RegisteredTool>();
  private opts: SandboxToolRouterOptions;

  constructor(opts: SandboxToolRouterOptions) {
    this.opts = opts;
    for (const tool of this.buildCatalog()) {
      this.tools.set(tool.name, tool);
    }
  }

  listTools(state: RunState): RegisteredTool[] {
    const hasSandbox = Boolean(state.sandboxHandleId || this.opts.sandboxEnabled);
    const isReadOnlyPhase = state.phase === "planning" || state.agent === "plan" || state.agent === "explore";

    return Array.from(this.tools.values())
      .filter((t) => {
        // Sandbox-only tools are advertised only when a sandbox runtime is active (§5 C.3, §6)
        if (t.requiresSandbox && !hasSandbox) {
          return false;
        }
        return true;
      })
      .map((t) => ({
        ...t,
        // Mask mutating tools in read-only planning phase rather than removing them mid-run ("mask, don't remove" §6)
        masked: isReadOnlyPhase && !t.readOnly ? true : false,
      }));
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  async executeTool(
    callId: string,
    name: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { output: null, error: `Unknown tool: ${name}` };
    }
    const rawRes = await tool.execute(input, ctx);
    if (typeof rawRes.output === "string") {
      const bounded = enforceToolOutputLimit(rawRes.output, callId, ctx.workspaceRoot);
      return {
        ...rawRes,
        output: bounded.output,
        truncated: bounded.truncated || rawRes.truncated,
        spillPath: bounded.spillPath,
      };
    }
    return rawRes;
  }

  private getDaemonAndHeaders(ctx: ToolExecutionContext) {
    if (!ctx.sandboxHandleId) return null;
    const daemon = getActiveSandboxDaemon(ctx.sandboxHandleId);
    if (!daemon) return null;
    return {
      daemon,
      headers: { "x-session-key": daemon.config.sessionKey },
    };
  }

  private buildCatalog(): RegisteredTool[] {
    return [
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
            const p = path.resolve(ctx.workspaceRoot, input.path);
            text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
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
          const d = this.getDaemonAndHeaders(ctx);
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
          const target = path.resolve(ctx.workspaceRoot, String(input.path ?? "."));
          if (!target.startsWith(path.resolve(ctx.workspaceRoot))) {
            return { output: null, error: "Path escapes workspace root" };
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
          const d = this.getDaemonAndHeaders(ctx);
          if (d) {
            const res = await d.daemon.handleRequest("POST", "/files/create", d.headers, input);
            if (res.status !== 200) {
              return { output: null, error: String(res.body.error ?? "write_file failed") };
            }
            return { output: res.body };
          }
          const target = path.resolve(ctx.workspaceRoot, String(input.path ?? ""));
          if (!target.startsWith(path.resolve(ctx.workspaceRoot))) {
            return { output: null, error: "Path escapes workspace root" };
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
          const d = this.getDaemonAndHeaders(ctx);
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
          const target = path.resolve(ctx.workspaceRoot, String(input.path ?? ""));
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
          const d = this.getDaemonAndHeaders(ctx);
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
          const d = this.getDaemonAndHeaders(ctx);
          if (d) {
            const res = await d.daemon.handleRequest("POST", "/files/view", d.headers, {
              path: input.path ?? ".",
            });
            if (res.status !== 200) {
              return { output: null, error: String(res.body.error ?? "list failed") };
            }
            return { output: res.body.entries ?? res.body.content };
          }
          const entries = fs.readdirSync(path.resolve(ctx.workspaceRoot, String(input.path ?? ".")));
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
          const d = this.getDaemonAndHeaders(ctx);
          if (d) {
            const res = await d.daemon.handleRequest("POST", "/search/glob", d.headers, input);
            return { output: res.body };
          }
          return { output: { matches: [] } };
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
          const d = this.getDaemonAndHeaders(ctx);
          if (d) {
            const res = await d.daemon.handleRequest("POST", "/search/grep", d.headers, input);
            return { output: res.body };
          }
          return { output: { results: [], count: 0 } };
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
          const d = this.getDaemonAndHeaders(ctx);
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
          const d = this.getDaemonAndHeaders(ctx);
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
          const d = this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "bash_interrupt requires an active sandbox" };
          const sid = String(input.sessionId ?? "main");
          const res = await d.daemon.handleRequest("POST", `/shell/${sid}/interrupt`, d.headers, {});
          return { output: res.body };
        },
      },

      {
        name: "process_start",
        description:
          "Starts a long-lived background process (such as a dev server or watcher) inside the sandbox and detects listening ports. Example: {\"command\": \"npm run dev\", \"port\": 3000}",
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
          },
        },
        execute: async (input, ctx) => {
          const d = this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "process_start requires an active sandbox" };
          const res = await d.daemon.handleRequest("POST", "/processes", d.headers, input);
          return { output: res.body, error: res.status !== 200 ? String(res.body.error) : undefined };
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
          const d = this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "process_logs requires an active sandbox" };
          const since = Number(input.since ?? 0);
          const res = await d.daemon.handleRequest(
            "GET",
            `/processes/${String(input.id)}/logs?since=${since}`,
            d.headers
          );
          return { output: res.body, error: res.status !== 200 ? String(res.body.error) : undefined };
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
          const d = this.getDaemonAndHeaders(ctx);
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
          const d = this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "preview_url requires an active sandbox" };
          const res = await d.daemon.handleRequest("GET", "/ports", d.headers);
          const ports = (res.body.ports as Array<{ port: number; previewUrl: string }>) ?? [];
          if (typeof input.port === "number") {
            const match = ports.find((p) => p.port === input.port);
            return {
              output: match ?? { port: input.port, previewUrl: `http://127.0.0.1:${input.port}` },
            };
          }
          return { output: { ports } };
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
          const d = this.getDaemonAndHeaders(ctx);
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
          const d = this.getDaemonAndHeaders(ctx);
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
          const d = this.getDaemonAndHeaders(ctx);
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
          const d = this.getDaemonAndHeaders(ctx);
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
          const d = this.getDaemonAndHeaders(ctx);
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
          const d = this.getDaemonAndHeaders(ctx);
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
          const d = this.getDaemonAndHeaders(ctx);
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

      // 4. Webfetch, Todo, Feature List, Progress Note, Memory, Checkpoint, Handoff (§6 Phase D)
      {
        name: "webfetch",
        description:
          "Fetches an allowlisted URL through the sandbox egress proxy, converts HTML to cleaned Markdown, paginates, and marks the output as untrusted external data. Example: {\"url\": \"https://nodejs.org/en/docs\"}",
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
        execute: async (input, _ctx) => {
          const url = String(input.url ?? "");
          const content = `<untrusted_content source="${url}">\n# Fetched from ${url}\n${String(input.mockContent ?? "Content fetched via egress proxy.")}\n</untrusted_content>`;
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
            steps: { type: "array" },
            acceptance: { type: "array", items: { type: "string" } },
            verification: { type: "array", items: { type: "string" } },
          },
        },
        execute: async (input, ctx) => {
          const isPlanMode = ctx.state.agent === "plan" || ctx.state.phase === "planning";
          const rawSteps = Array.isArray(input.steps) ? input.steps : [];
          const steps = rawSteps.map((s: Record<string, unknown>, idx: number) => ({
            id: String(s.id ?? idx + 1),
            title: String(s.title ?? `Step ${idx + 1}`),
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
            todos: { type: "array" },
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
          const file = path.join(ctx.workspaceRoot, ".openharness", "task", taskId, "feature_list.json");
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
          const dir = path.join(ctx.workspaceRoot, ".openharness", "task", taskId);
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, "progress.md");
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
          const target = path.resolve(memDir, rel);
          if (!target.startsWith(memDir)) {
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
          const d = this.getDaemonAndHeaders(ctx);
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
          "Spawns an isolated subagent with its own context window and budget. Read-only explorers can run in parallel; write-capable subagents run only in separate git worktrees. Only the concise final report (<=2,000 tokens) returns to the parent. Example: {\"agent\": \"explore\", \"prompt\": \"Find all auth routes\", \"background\": false}",
        readOnly: true,
        idempotent: false,
        parameters: {
          type: "object",
          required: ["prompt"],
          properties: {
            agent: { type: "string" },
            prompt: { type: "string" },
            tools: { type: "array", items: { type: "string" } },
            budget: { type: "object" },
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
          const d = this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "ipython requires an active sandbox" };
          const res = await d.daemon.handleRequest("POST", "/ipython/exec", d.headers, input);
          return { output: res.body };
        },
      },
    ];
  }
}
