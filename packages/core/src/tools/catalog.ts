import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import type { FeatureItem, PlanData, TodoItem } from "@openharness/sdk";
import type {
  BrowserCheck,
  BrowserCheckTarget,
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
import { assertSafeExternalUrl, fetchSafeExternal } from "../util/safe-url.ts";
import { SkillsRegistry } from "../skills/registry.ts";
import { McpClientManager } from "../mcp/client.ts";

const IGNORED_WORKSPACE_DIRS = new Set(["node_modules", ".git", "dist", ".openharness"]);

const READ_TOOL_NAMES = ["read_file", "list", "glob", "search", "ask_user"] as const;
const BUILD_TOOL_NAMES = ["write_file", "edit", "apply_patch", "bash", "verify", "delegate", "todo_write", "update_plan", "request_takeover", "service_start"] as const;
const WEB_TOOL_NAMES = ["process_start", "process_logs", "process_stop", "preview_url", "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_screenshot", "browser_console", "browser_check_def", "browser_check_run", "visual_segment_audit"] as const;
const WEB_INTENT = /\b(web|ui|page|browser|frontend|react|vue|svelte|vite|next|html|css|preview|dev server|express|api server)\b/i;
const DOC_TOOL_NAMES = ["generate_image", "render_document_preview", "visual_segment_audit"] as const;
const DOC_INTENT = /\b(doc|docx|word|pdf|excel|xlsx|spreadsheet|workbook|csv|ppt|pptx|powerpoint|slide|deck|presentation|report|whitepaper|invoice|resume|cv|brochure|poster|flyer|certificate|chart|diagram|infographic|epub|generate image|cover image)\b/i;

export function selectTools(state: RunState, all: RegisteredTool[]): RegisteredTool[] {
  if (state.mode === "ask" || state.mode === "chat") {
    const allowed = new Set<string>(READ_TOOL_NAMES);
    return all.filter((tool) => allowed.has(tool.name));
  }
  const web = state.webTools === true || WEB_INTENT.test(state.initialPrompt ?? "");
  const docs = state.agent === "document" || state.loadedGroups?.includes("documents") || DOC_INTENT.test(state.initialPrompt ?? "");
  const skillsEnabled = state.agent === "document" || state.loadedGroups?.includes("skills") || docs;
  const allowed = new Set<string>([
    ...READ_TOOL_NAMES,
    ...BUILD_TOOL_NAMES,
    ...(web ? WEB_TOOL_NAMES : []),
    ...(docs ? DOC_TOOL_NAMES : []),
    "load_tools",
  ]);
  return all.filter((tool) => allowed.has(tool.name)
    || (state.loadedGroups?.includes("mcp") && tool.source === "mcp")
    || (skillsEnabled && tool.source === "skill")
    || (docs && tool.name.startsWith("mcp__document_studio__")));
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

const KNOWN_BROWSER_CHECK_ACTIONS = new Set([
  "navigate", "goto", "open",
  "click", "check", "tap",
  "fill", "type", "input", "select",
  "press", "key",
  "wait", "sleep",
  "expecthidden", "asserthidden",
  "expecturl", "asserturl",
  "expectvisible", "assertvisible",
  "asserttext", "expecttext", "assert", "verify",
]);

function normalizeBrowserTarget(
  raw: unknown,
  opts?: { forceCss?: boolean; ignoreText?: boolean }
): BrowserCheckTarget | string | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (opts?.forceCss) return { css: trimmed.replace(/^css=/i, "").trim() };
    return trimmed;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.target === "string" && value.target.trim()) {
    return opts?.forceCss ? { css: value.target.trim() } : value.target.trim();
  }
  const target = value.target && typeof value.target === "object" && !Array.isArray(value.target)
    ? value.target as Record<string, unknown> : value;
  const role = typeof target.role === "string" && target.role.trim() ? target.role.trim() : undefined;
  const name = typeof target.name === "string" ? target.name : undefined;
  const label = typeof target.label === "string" && target.label.trim()
    ? target.label.trim()
    : typeof target.placeholder === "string" && target.placeholder.trim()
    ? target.placeholder.trim()
    : undefined;
  const css = typeof target.css === "string" && target.css.trim()
    ? target.css.trim()
    : typeof target.selector === "string" && target.selector.trim()
    ? target.selector.trim()
    : undefined;
  const text = !opts?.ignoreText && !css && typeof target.text === "string" && target.text.trim()
    ? target.text.trim()
    : undefined;
  if (!role && !label && !text && !css) {
    if (typeof target.name === "string" && target.name.trim()) {
      return { css: `[name="${target.name.trim().replace(/"/g, '\"')}"]` };
    }
    return undefined;
  }
  return {
    ...(role ? { role, name: name ?? (opts?.ignoreText ? undefined : text) ?? label ?? "" } : {}),
    ...(label ? { label } : {}),
    ...(text ? { text } : {}),
    ...(css ? { css } : {}),
    ...(target.exact === true ? { exact: true } : {}),
  };
}

/** Accept common model-emitted action/type forms and store one canonical flow shape. */
export function normalizeBrowserCheckSteps(rawSteps: unknown[]): BrowserCheckStep[] | undefined {
  const normalized: BrowserCheckStep[] = [];
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const step = raw as Record<string, unknown>;
    if (typeof step.goto === "string" || typeof step.navigate === "string" || typeof step.url === "string") {
      normalized.push({ goto: String(step.goto ?? step.navigate ?? step.url) });
      continue;
    }
    const rawAction = String(step.action ?? step.type ?? "").toLowerCase().replaceAll("_", "");
    const isTypeShorthand =
      step.action === undefined &&
      typeof step.type === "string" &&
      !KNOWN_BROWSER_CHECK_ACTIONS.has(rawAction) &&
      (step.value !== undefined || step.text !== undefined || step.textValue !== undefined || step.input !== undefined);
    const action = isTypeShorthand ? "type" : rawAction;

    if (["navigate", "goto", "open"].includes(action)) {
      normalized.push({ goto: String(step.path ?? step.url ?? step.value ?? step.target ?? "/") });
    } else if (["click", "check", "tap"].includes(action) || "click" in step || "check" in step) {
      const explicitCss = typeof step.css === "string" ? step.css : typeof step.selector === "string" ? step.selector : undefined;
      const target = explicitCss
        ? normalizeBrowserTarget(explicitCss)
        : normalizeBrowserTarget(step.click ?? step.check ?? step.target ?? step);
      if (!target) return undefined;
      normalized.push({ click: target });
    } else if (["fill", "type", "input", "select"].includes(action) || "fill" in step || "select" in step) {
      const fillObj = step.fill && typeof step.fill === "object" && !Array.isArray(step.fill)
        ? (step.fill as Record<string, unknown>)
        : undefined;
      const targetObj = step.target && typeof step.target === "object" && !Array.isArray(step.target)
        ? (step.target as Record<string, unknown>)
        : undefined;
      const fillValue = String(
        step.value ??
        step.textValue ??
        step.input ??
        step.text ??
        fillObj?.value ??
        fillObj?.textValue ??
        fillObj?.input ??
        fillObj?.text ??
        targetObj?.value ??
        ""
      );
      const explicitCss = typeof step.css === "string" ? step.css : typeof step.selector === "string" ? step.selector : undefined;
      const rawTarget = isTypeShorthand
        ? step.type
        : (explicitCss ?? step.fill ?? step.select ?? step.target ?? step);
      const target = explicitCss
        ? normalizeBrowserTarget(explicitCss, { forceCss: true, ignoreText: true })
        : normalizeBrowserTarget(rawTarget, { ignoreText: true });
      if (!target) return undefined;
      normalized.push({ fill: target, value: fillValue });
    } else if (["press", "key"].includes(action) || "press" in step) {
      normalized.push({ press: String(step.press ?? step.key ?? step.value ?? "Enter") });
    } else if (["wait", "sleep"].includes(action) || "wait" in step || "waitMs" in step) {
      normalized.push({ waitMs: Number(step.ms ?? step.timeout ?? step.waitMs ?? step.value ?? step.wait ?? 500) });
    } else if (["expecthidden", "asserthidden"].includes(action) || "expectHidden" in step) {
      const explicitCss = typeof step.css === "string" ? step.css : typeof step.selector === "string" ? step.selector : undefined;
      const target = explicitCss
        ? normalizeBrowserTarget(explicitCss, { forceCss: true })
        : normalizeBrowserTarget(step.expectHidden ?? step.target ?? step.text ?? step.value ?? step);
      if (!target) return undefined;
      normalized.push({ expectHidden: target });
    } else if (["expecturl", "asserturl"].includes(action) || "expectUrl" in step) {
      normalized.push({ expectUrl: String(step.expectUrl ?? step.url ?? step.value ?? step.target ?? "") });
    } else if (["expectvisible", "assertvisible", "asserttext", "expecttext", "assert", "verify"].includes(action) || "expectVisible" in step || "expectText" in step) {
      const textAssert = action === "asserttext" || action === "expecttext" || "expectText" in step;
      const explicitCss = typeof step.css === "string" ? step.css : typeof step.selector === "string" ? step.selector : undefined;
      const expectTextObj = step.expectText && typeof step.expectText === "object" && !Array.isArray(step.expectText)
        ? (step.expectText as Record<string, unknown>)
        : undefined;
      const containsVal =
        typeof step.contains === "string" ? step.contains
        : typeof expectTextObj?.contains === "string" ? expectTextObj.contains
        : typeof step.text === "string" && Boolean(explicitCss || step.target || step.expectText) ? step.text
        : typeof step.value === "string" && Boolean(explicitCss || step.target || step.expectText) ? step.value
        : typeof step.text === "string" ? step.text
        : undefined;
      const equalsVal =
        typeof step.equals === "string" ? step.equals
        : typeof expectTextObj?.equals === "string" ? expectTextObj.equals
        : undefined;
      const matchesVal =
        typeof step.matches === "string" ? step.matches
        : typeof expectTextObj?.matches === "string" ? expectTextObj.matches
        : undefined;
      let target = explicitCss
        ? normalizeBrowserTarget(explicitCss, { forceCss: true, ignoreText: Boolean(containsVal || equalsVal || matchesVal) })
        : normalizeBrowserTarget(step.expectText ?? step.expectVisible ?? step.target ?? step.text ?? step.value ?? step);
      if (textAssert && typeof step.expectText === "string" && !equalsVal && !containsVal && !matchesVal) {
        normalized.push({
          ...(typeof step.selector === "string" ? { selector: step.selector } : {}),
          expectText: step.expectText,
          contains: step.expectText,
        } as unknown as BrowserCheckStep);
        continue;
      }
      if (!target) return undefined;
      if (textAssert) {
        normalized.push({
          expectText: target,
          ...(equalsVal !== undefined ? { equals: equalsVal } : {}),
          ...(containsVal !== undefined ? { contains: containsVal } : {}),
          ...(matchesVal !== undefined ? { matches: matchesVal } : {}),
        });
      } else {
        normalized.push({ expectVisible: target, ...(typeof step.timeoutMs === "number" ? { timeoutMs: step.timeoutMs } : {}) });
      }
    } else if (typeof step.wait === "number") {
      normalized.push({ waitMs: step.wait });
    } else {
      return undefined;
    }
  }
  return normalized;
}

function editorialPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1); raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const t = (x / Math.max(1, width - 1) + y / Math.max(1, height - 1)) / 2;
      const i = row + 1 + x * 4;
      raw[i] = Math.round(19 + 32 * t); raw[i + 1] = Math.round(32 + 29 * t); raw[i + 2] = Math.round(55 + 42 * t); raw[i + 3] = 255;
      const dx = x - width * 0.74, dy = y - height * 0.35;
      if (dx * dx / (width * width * 0.045) + dy * dy / (height * height * 0.11) < 1) {
        raw[i] = 108; raw[i + 1] = 190; raw[i + 2] = 181;
      }
      if (x > width * 0.08 && x < width * 0.48 && y > height * 0.66 && y < height * 0.68) {
        raw[i] = 240; raw[i + 1] = 190; raw[i + 2] = 115;
      }
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
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
  requestSandbox?: (handleId: string, method: string, path: string, body?: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
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
  onVisualSegmentAudit?: (input: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>;
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
    const needsSandbox = !HOST_TOOLS.has(name) && (!name.startsWith("mcp__") || name.startsWith("mcp__document_studio__"));
    if (needsSandbox && !ctx.sandboxHandleId && this.opts.ensureSandbox && ctx.state) {
      try {
        const h = await this.opts.ensureSandbox(ctx.state);
        ctx.sandboxHandleId = h.id;
        ctx.state.sandboxHandleId = h.id;
        if (!ctx.requestSandbox && this.opts.requestSandbox) {
          ctx.requestSandbox = (method, route, body) => this.opts.requestSandbox!(h.id, method, route, body);
        }
      } catch {
        // Workspace tools can still use the local fallback daemon when no selected runtime is available.
      }
    }
    const capturesArtifacts = ["bash", "write_file", "edit", "apply_patch", "generate_image", "render_document_preview"].includes(name) || name.startsWith("mcp__document_studio__");
    const beforeArtifacts = capturesArtifacts ? await this.readArtifactScan(ctx) : [];
    const rawRes = await tool.execute(input, ctx);
    if (capturesArtifacts) {
      const beforeByPath = new Map(beforeArtifacts.map((artifact) => [artifact.path, artifact.mtimeMs]));
      const artifacts = (await this.readArtifactScan(ctx)).filter((artifact) => !beforeByPath.has(artifact.path) || artifact.mtimeMs > (beforeByPath.get(artifact.path) ?? 0))
        .map(({ path: artifactPath, mimeType, size, kind }) => ({ path: artifactPath, mimeType, size, kind }));
      if (artifacts.length) rawRes.metadata = { ...rawRes.metadata, artifacts };
    }
    if (!rawRes.error && name === "process_start") ctx.state.webTools = true;
    const outputField = name === "process_logs" ? "logs" : name === "browser_snapshot" ? "snapshot" : undefined;
    const fieldValue = outputField && rawRes.output && typeof rawRes.output === "object"
      ? (rawRes.output as Record<string, unknown>)[outputField]
      : undefined;
    if (typeof rawRes.output === "string" || typeof fieldValue === "string") {
      const maxChars = name === "bash" ? 12_000 : name === "browser_snapshot" ? 8_000 : name === "process_logs" ? 6_000 : 16_000;
      const rawToSpill = typeof rawRes.output === "string" ? rawRes.output : fieldValue;
      const bounded = enforceToolOutputLimit(rawToSpill, callId, ctx.workspaceRoot, {
        maxChars,
        style: name === "process_logs" ? "tail" : "head-tail",
      });
      if (bounded.truncated && bounded.spillPath) {
        const fullText = typeof rawToSpill === "string" ? rawToSpill : JSON.stringify(rawToSpill, null, 2) ?? "";
        if (this.opts.workspaceRoot && path.resolve(this.opts.workspaceRoot) !== path.resolve(ctx.workspaceRoot)) {
          try {
            const fallbackSpill = resolveInside(this.opts.workspaceRoot, bounded.spillPath);
            fs.mkdirSync(path.dirname(fallbackSpill), { recursive: true });
            fs.writeFileSync(fallbackSpill, fullText, "utf8");
          } catch {}
        }
        const activeDaemon = ctx.sandboxHandleId ? getActiveSandboxDaemon(ctx.sandboxHandleId) : undefined;
        if (activeDaemon) {
          void activeDaemon.handleRequest(
            "POST",
            "/files/create",
            { "x-session-key": activeDaemon.config.sessionKey },
            { path: bounded.spillPath, content: fullText }
          ).catch(() => {});
        }
      }
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

  private async readArtifactScan(ctx: ToolExecutionContext): Promise<Array<{ path: string; mimeType: string; size: number; kind: string; mtimeMs: number }>> {
    try {
      const response = ctx.requestSandbox
        ? await ctx.requestSandbox("GET", "/artifacts/scan")
        : await (async () => {
            const d = await this.getDaemonAndHeaders(ctx);
            return d.daemon.handleRequest("GET", "/artifacts/scan", d.headers);
          })();
      return Array.isArray(response.body.artifacts) ? response.body.artifacts as Array<{ path: string; mimeType: string; size: number; kind: string; mtimeMs: number }> : [];
    } catch { return []; }
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
        description: "Load an optional tool group: web, mcp, skills, or documents.",
        readOnly: true,
        idempotent: true,
        source: "builtin",
        parameters: {
          type: "object",
          required: ["group"],
          properties: { group: { type: "string", enum: ["web", "mcp", "skills", "documents"] } },
        },
        execute: async (input, ctx) => {
          const group = String(input.group ?? "");
          if (!["web", "mcp", "skills", "documents"].includes(group)) {
            return { output: null, error: `Unknown tool group: ${group}` };
          }
          if (group === "web") ctx.state.webTools = true;
          else ctx.state.loadedGroups = Array.from(new Set([...(ctx.state.loadedGroups ?? []), group]));
          return { output: { loaded: group } };
        },
      },
      {
        name: "generate_image",
        description: "Generate a high-craft visual asset and save it as a PNG in the workspace. Works offline with a deterministic editorial fallback.",
        readOnly: false,
        idempotent: false,
        parameters: { type: "object", required: ["prompt", "output_path"], properties: { prompt: { type: "string" }, output_path: { type: "string" }, aspect_ratio: { type: "string", enum: ["1:1", "16:9", "4:3", "3:4", "9:16"] } } },
        execute: async (input, ctx) => {
          const outputPath = String(input.output_path ?? "");
          if (!outputPath || outputPath.includes("..") || path.isAbsolute(outputPath)) return { output: null, error: "output_path must stay inside the workspace" };
          const ratios: Record<string, [number, number]> = { "16:9": [1280, 720], "4:3": [1200, 900], "3:4": [900, 1200], "9:16": [720, 1280], "1:1": [1024, 1024] };
          const [width, height] = ratios[String(input.aspect_ratio ?? "1:1")] ?? ratios["1:1"]!;
          const enhancedPrompt = `${String(input.prompt ?? "").slice(0, 4000)}; clean visual composition, high craft, no watermarks, no garbled text`;
          let png: Buffer | undefined;
          let generatedBy = "offline-editorial-fallback";
          const apiKey = process.env.MODEL_API_KEY ?? process.env.META_API_KEY ?? process.env.OPENAI_API_KEY;
          if (apiKey && !ctx.state.model.startsWith("mock/")) {
            const base = process.env.MODEL_API_BASE_URL ?? (process.env.OPENAI_API_KEY && !process.env.MODEL_API_KEY && !process.env.META_API_KEY ? "https://api.openai.com/v1" : "https://api.meta.ai/v1");
            try {
              const response = await fetch(`${base.replace(/\/$/, "")}/images/generations`, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: process.env.OH_IMAGE_MODEL ?? (process.env.OPENAI_API_KEY ? "gpt-image-1" : "muse-image-1.0"), prompt: enhancedPrompt, size: `${width}x${height}`, response_format: "b64_json" }), signal: AbortSignal.timeout(45_000) });
              if (response.ok) {
                const payload = await response.json() as { data?: Array<{ b64_json?: string; url?: string }> };
                const first = payload.data?.[0];
                if (first?.b64_json) png = Buffer.from(first.b64_json, "base64");
                else if (first?.url) { const image = await fetch(first.url, { signal: AbortSignal.timeout(20_000) }); if (image.ok) png = Buffer.from(await image.arrayBuffer()); }
                if (png) generatedBy = "configured-image-api";
              }
            } catch { /* Offline/mock fallback is a supported path. */ }
          }
          png ??= editorialPng(width, height);
          const daemon = ctx.sandboxHandleId ? getActiveSandboxDaemon(ctx.sandboxHandleId) : undefined;
          if (daemon) {
            const written = await daemon.handleRequest("POST", "/files/write_bytes", { "x-session-key": daemon.config.sessionKey }, { path: outputPath, dataBase64: png.toString("base64"), overwrite: true });
            if (written.status !== 200) return { output: null, error: String(written.body.error ?? "Failed to write generated image") };
          } else {
            const target = resolveInside(ctx.workspaceRoot, outputPath);
            fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, png);
          }
          ctx.state.changedFiles = Array.from(new Set([...(ctx.state.changedFiles ?? []), outputPath]));
          return {
            output: { path: outputPath, mimeType: "image/png", width, height, bytes: png.byteLength, generatedBy },
            metadata: generatedBy === "configured-image-api"
              ? { model: process.env.OH_IMAGE_MODEL ?? "muse-image-1.0", providerLabel: "Meta Model API · Muse Image 1.0", outputPath, artifacts: [{ path: outputPath, mimeType: "image/png", kind: "image" }] }
              : { outputPath, artifacts: [{ path: outputPath, mimeType: "image/png", kind: "image" }] },
          };
        },
      },
      {
        name: "render_document_preview",
        description: "Render a PDF or Office document into up to four JPEG page previews and audit spreadsheet formula errors. Inspect the visual pages before finishing.",
        readOnly: true,
        idempotent: true,
        parameters: { type: "object", required: ["path"], properties: { path: { type: "string" }, max_pages: { type: "integer", minimum: 1, maximum: 4, default: 3 } } },
        execute: async (input, ctx) => {
          const filePath = String(input.path ?? "");
          if (!filePath || filePath.includes("..") || path.isAbsolute(filePath)) return { output: null, error: "path must stay inside the workspace" };
          const activeDaemon = ctx.sandboxHandleId ? getActiveSandboxDaemon(ctx.sandboxHandleId) : undefined;
          if (activeDaemon || ctx.requestSandbox) {
            const response = ctx.requestSandbox
              ? await ctx.requestSandbox("POST", "/files/preview_document", { path: filePath, maxPages: input.max_pages ?? 3 })
              : await activeDaemon!.handleRequest("POST", "/files/preview_document", { "x-session-key": activeDaemon!.config.sessionKey }, { path: filePath, maxPages: input.max_pages ?? 3 });
            if (response.status !== 200) return { output: null, error: String(response.body.error ?? "Document preview failed") };
            const output = response.body;
            const formulaErrors = Array.isArray(output.formulaErrors) ? output.formulaErrors : [];
            return { output, error: formulaErrors.length ? `Spreadsheet contains formula errors: ${formulaErrors.join(", ")}` : undefined };
          }
          const script = `import sys,json,os,tempfile,subprocess,base64,shutil,pathlib,re\nfrom pathlib import Path\na=json.loads(base64.b64decode(sys.argv[1])); root=Path.cwd().resolve(); src=(root/a['path']).resolve(); src.relative_to(root)\nif not src.is_file(): raise SystemExit('Document not found')\nlimit=max(1,min(4,int(a.get('max_pages',3)))); errors=[]; sheets=[]\nif src.suffix.lower() in ('.xlsx','.xlsm'):\n import openpyxl\n wb=openpyxl.load_workbook(src,data_only=False,read_only=True); cached=openpyxl.load_workbook(src,data_only=True,read_only=True)\n for ws in wb.worksheets:\n  cws=cached[ws.title]; sheets.append({'name':ws.title,'rows':ws.max_row,'columns':ws.max_column})\n  for row in ws.iter_rows():\n   for cell in row:\n    val=cws[cell.coordinate].value\n    if isinstance(cell.value,str) and cell.value.startswith('=') and isinstance(val,str) and val in ('#REF!','#DIV/0!','#VALUE!','#NAME?','#N/A','#NUM!'): errors.append(ws.title+'!'+cell.coordinate+' '+val)\n wb.close(); cached.close()\ntmp=Path(tempfile.mkdtemp(prefix='oh_preview_')); profile=Path(tempfile.mkdtemp(prefix='lo_prof_')); pdf=src if src.suffix.lower()=='.pdf' else tmp/(src.stem+'.pdf')\ntry:\n if src.suffix.lower()!='.pdf':\n  env=os.environ.copy(); env.update({'HOME':'/tmp','TMPDIR':'/tmp'}); p=subprocess.run(['soffice','-env:UserInstallation=file://'+str(profile),'--headless','--convert-to','pdf','--outdir',str(tmp),str(src)],capture_output=True,text=True,timeout=45,env=env)\n  if p.returncode or not pdf.exists(): raise RuntimeError((p.stderr or p.stdout or 'LibreOffice conversion failed')[-1200:])\n pages=[]; total=1\n try:\n  from pypdf import PdfReader; total=len(PdfReader(str(pdf)).pages)\n except Exception: pass\n indexes=sorted(set([0,(total-1)//2,total-1]))[:limit]\n for idx in indexes:\n  out=tmp/('p'+str(idx+1)); proc=subprocess.run(['pdftoppm','-f',str(idx+1),'-l',str(idx+1),'-jpeg','-jpegopt','quality=78','-r','144','-scale-to','1280',str(pdf),str(out)],capture_output=True,timeout=45)\n  jpg=Path(str(out)+'-'+str(idx+1)+'.jpg')\n  if proc.returncode or not jpg.exists(): raise RuntimeError('pdftoppm failed: '+proc.stderr.decode(errors='replace')[-500:])\n  pages.append({'page':idx+1,'mimeType':'image/jpeg','dataBase64':base64.b64encode(jpg.read_bytes()).decode()})\n print(json.dumps({'pageCount':total,'sheets':sheets,'formulaErrors':errors,'pages':pages}))\nfinally: shutil.rmtree(tmp,ignore_errors=True); shutil.rmtree(profile,ignore_errors=True)`;
          const arg = Buffer.from(JSON.stringify({ path: filePath, max_pages: input.max_pages ?? 3 })).toString("base64");
          const daemon = ctx.sandboxHandleId ? getActiveSandboxDaemon(ctx.sandboxHandleId) : undefined;
          const command = `python3 -c ${JSON.stringify(`import base64;exec(base64.b64decode('${Buffer.from(script).toString("base64")}'))`)} ${arg}`;
          let stdout: string;
          if (daemon) {
            const res = await daemon.handleRequest("POST", "/exec", { "x-session-key": daemon.config.sessionKey }, { command, timeoutSec: 55 });
            if (res.status !== 200 || Number(res.body.exitCode ?? 0) !== 0) return { output: null, error: String(res.body.stderr ?? res.body.error ?? "Document preview failed") };
            stdout = String(res.body.stdout ?? "");
          } else {
            const target = resolveInside(ctx.workspaceRoot, filePath);
            if (!fs.existsSync(target)) return { output: null, error: "Document not found" };
            const proc = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", script, arg], { cwd: ctx.workspaceRoot, encoding: "utf8", timeout: 55_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, HOME: "/tmp", TMPDIR: "/tmp" } });
            if (proc.status !== 0) return { output: null, error: (proc.stderr || proc.error?.message || "Document preview failed").slice(-2000) };
            stdout = proc.stdout;
          }
          try {
            const output = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
            const formulaErrors = Array.isArray(output.formulaErrors) ? output.formulaErrors : [];
            return { output, error: formulaErrors.length ? `Spreadsheet contains formula errors: ${formulaErrors.join(", ")}` : undefined };
          } catch { return { output: null, error: `Could not parse document preview output: ${stdout.slice(-1000)}` }; }
        },
      },

      {
        name: "visual_segment_audit",
        description: "Audit a live browser frame or workspace visual with SAM 3.1, annotate key visual regions and overlaps, and save an inline-ready PNG proof. Use source=browser for the current preview, or source=file with a workspace image/document path.",
        readOnly: false,
        idempotent: false,
        requiresSandbox: true,
        parameters: {
          type: "object",
          properties: {
            source: { type: "string", enum: ["browser", "file"], default: "browser" },
            path: { type: "string" },
            output_path: { type: "string", default: "deliverables/sam_visual_audit.png" },
          },
        },
        execute: async (input, ctx) => this.opts.onVisualSegmentAudit
          ? this.opts.onVisualSegmentAudit(input, ctx)
          : { output: null, error: "Visual audit is unavailable in this server configuration." },
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
          const requestedPath = String(input.path ?? "");
          if (requestedPath.replace(/\\/g, "/").startsWith(".openharness/outputs/")) {
            try {
              const candidateRoots = [ctx.workspaceRoot, this.opts.workspaceRoot].filter(Boolean);
              let content: string | undefined;
              for (const root of candidateRoots) {
                try {
                  const target = resolveInside(root, requestedPath);
                  if (fs.existsSync(target)) {
                    content = fs.readFileSync(target, "utf8");
                    break;
                  }
                } catch {}
              }
              if (content === undefined) {
                const activeDaemon = ctx.sandboxHandleId ? getActiveSandboxDaemon(ctx.sandboxHandleId) : undefined;
                if (activeDaemon) {
                  const res = await activeDaemon.handleRequest("POST", "/files/view", { "x-session-key": activeDaemon.config.sessionKey }, { path: requestedPath });
                  if (res.status === 200 && typeof res.body.content === "string") {
                    content = res.body.content;
                  }
                }
              }
              if (content === undefined) return { output: null, error: `File not found: ${requestedPath}` };
              const hasPaging = input.offset !== undefined || input.limit !== undefined;
              if (!hasPaging) return { output: content };
              const lines = content.split("\n");
              const offset = Math.max(1, Number(input.offset ?? 1));
              const limit = Math.min(2000, Math.max(1, Number(input.limit ?? 2000)));
              return { output: lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${String(offset + i).padStart(5, " ")} | ${line}`).join("\n"), truncated: offset - 1 + limit < lines.length };
            } catch (err) { return { output: null, error: (err as Error).message }; }
          }
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
          const requestedPath = String(input.path ?? "").replace(/\\/g, "/");
          if (requestedPath === ".openharness" || requestedPath === ".openharness/outputs" || requestedPath.startsWith(".openharness/outputs/")) {
            try {
              const seen = new Map<string, { name: string; type: "directory" | "file" }>();
              for (const root of [ctx.workspaceRoot, this.opts.workspaceRoot].filter(Boolean)) {
                try {
                  const target = resolveInside(root, requestedPath);
                  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
                    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
                      seen.set(entry.name, { name: entry.name, type: entry.isDirectory() ? "directory" : "file" });
                    }
                  }
                } catch {}
              }
              return { output: Array.from(seen.values()) };
            } catch (err) { return { output: null, error: (err as Error).message }; }
          }
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
          if (process.env.OH_ENABLE_LEGACY_HOST_SHELL !== "1") {
            return { output: null, error: "Legacy direct-host shell execution is disabled by security policy; use bash inside the sandbox." };
          }
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
          if (String(input.command ?? "").includes(".openharness")) {
            for (const root of [ctx.workspaceRoot, this.opts.workspaceRoot].filter(Boolean)) {
              try {
                const outDir = path.join(root, ".openharness", "outputs");
                if (fs.existsSync(outDir)) {
                  for (const name of fs.readdirSync(outDir)) {
                    const full = path.join(outDir, name);
                    if (fs.statSync(full).isFile()) {
                      await d.daemon.handleRequest(
                        "POST",
                        "/files/create",
                        d.headers,
                        { path: `.openharness/outputs/${name}`, content: fs.readFileSync(full, "utf8") }
                      ).catch(() => {});
                    }
                  }
                }
              } catch {}
            }
          }
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
          "Navigates the headless Chromium browser inside the sandbox to a URL (such as a local dev server preview URL) and returns the initial accessibility snapshot with `[ref=eN]` handles and `(x,y)` coordinates. Output is marked untrusted. Example: {\"url\": \"http://127.0.0.1:3000\"}",
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
          const { screenshotJpegBase64, ...restBody } = (res.body ?? {}) as Record<string, unknown>;
          return {
            output: restBody,
            error: res.status !== 200 ? String(res.body.error) : undefined,
            untrusted: true,
            provenance: `browser:${String(input.url)}`,
            metadata: {
              url: restBody.url,
              title: restBody.title,
              cursor: restBody.cursor,
              
            },
          };
        },
      },

      {
        name: "browser_snapshot",
        description:
          "Returns the current page's accessibility tree with `[ref=eN]` element handles and `(x,y)` cursor coordinates for interaction. Output is marked untrusted. Example: {}",
        readOnly: true,
        idempotent: true,
        requiresSandbox: true,
        parameters: { type: "object", properties: {} },
        execute: async (_input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "browser_snapshot requires an active sandbox" };
          const res = await d.daemon.handleRequest("POST", "/browser/snapshot", d.headers, {});
          const { screenshotJpegBase64, ...restBody } = (res.body ?? {}) as Record<string, unknown>;
          return {
            output: restBody,
            untrusted: true,
            provenance: "browser:snapshot",
            metadata: {
              url: restBody.url,
              title: restBody.title,
              cursor: restBody.cursor,
              
            },
          };
        },
      },

      {
        name: "browser_click",
        description:
          "Moves the live AI cursor and clicks an element in the page using its `[ref=eN]` handle from `browser_snapshot`, visible text/CSS selector, or `(x, y)` viewport coordinates, and returns the updated page snapshot. Examples: {\"ref\": \"e1\"} or {\"x\": 640, \"y\": 420}",
        readOnly: false,
        idempotent: false,
        requiresSandbox: true,
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Element ref (e.g. 'e1') or button text" },
            selector: { type: "string", description: "Optional CSS selector" },
            x: { type: "number", description: "Optional viewport X coordinate (0..1280)" },
            y: { type: "number", description: "Optional viewport Y coordinate (0..800)" },
            doubleClick: { type: "boolean" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "browser_click requires an active sandbox" };
          const res = await d.daemon.handleRequest("POST", "/browser/click", d.headers, input);
          const { screenshotJpegBase64, ...restBody } = (res.body ?? {}) as Record<string, unknown>;
          return {
            output: restBody,
            error: res.status !== 200 ? String(res.body.error) : undefined,
            metadata: {
              url: restBody.url,
              title: restBody.title,
              cursor: restBody.cursor,
              
            },
          };
        },
      },

      {
        name: "browser_type",
        description:
          "Moves the live AI cursor and types text into an input element identified by `[ref=eN]`, CSS selector, or `(x, y)` coordinates, and returns the updated page snapshot. Example: {\"ref\": \"e2\", \"text\": \"hello\"}",
        readOnly: false,
        idempotent: false,
        requiresSandbox: true,
        parameters: {
          type: "object",
          required: ["text"],
          properties: {
            ref: { type: "string", description: "Element ref (e.g. 'e2') or placeholder/label" },
            selector: { type: "string", description: "Optional CSS selector" },
            x: { type: "number", description: "Optional viewport X coordinate" },
            y: { type: "number", description: "Optional viewport Y coordinate" },
            text: { type: "string" },
            pressEnter: { type: "boolean" },
          },
        },
        execute: async (input, ctx) => {
          const d = await this.getDaemonAndHeaders(ctx);
          if (!d) return { output: null, error: "browser_type requires an active sandbox" };
          const res = await d.daemon.handleRequest("POST", "/browser/type", d.headers, input);
          const { screenshotJpegBase64, ...restBody } = (res.body ?? {}) as Record<string, unknown>;
          return {
            output: restBody,
            error: res.status !== 200 ? String(res.body.error) : undefined,
            metadata: {
              url: restBody.url,
              title: restBody.title,
              cursor: restBody.cursor,
              
            },
          };
        },
      },

      {
        name: "browser_press",
        description:
          "Presses a keyboard key (such as `Enter`, `Tab`, `Escape`) in the browser and returns the updated page snapshot. Example: {\"key\": \"Enter\"}",
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
          const { screenshotJpegBase64, ...restBody } = (res.body ?? {}) as Record<string, unknown>;
          return {
            output: restBody,
            metadata: {
              url: restBody.url,
              title: restBody.title,
              cursor: restBody.cursor,
              
            },
          };
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
        description: "Define and run a repeatable browser check flow. Steps: {goto:'/'}, {click:'#btn'}, {fill:'#input',value:'hi'}, {expectVisible:'Done'}, or {expectText:'#out',contains:'ok'}. Once passing, do not weaken it.",
        readOnly: false,
        idempotent: false,
        requiresSandbox: true,
        parameters: {
          type: "object",
          required: ["name", "steps"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            port: { type: "integer", minimum: 1024, maximum: 65535 },
            steps: { type: "array", minItems: 1, maxItems: 30, items: { type: "object", properties: {
              goto: { type: "string" }, navigate: { type: "string" }, url: { type: "string" }, action: { type: "string" }, type: { type: "string" },
              path: { type: "string" }, target: { type: ["string", "object"] }, selector: { type: "string" }, css: { type: "string" }, text: { type: "string" }, label: { type: "string" }, role: { type: "string" }, name: { type: "string" },
              value: { type: ["string", "number"] }, textValue: { type: "string" }, key: { type: "string" }, ms: { type: "number" }, timeout: { type: "number" }, wait: { type: "number" }, waitMs: { type: "number" },
              click: { type: ["string", "object"] }, fill: { type: ["string", "object"] }, press: { type: "string" }, expectVisible: { type: ["string", "object"] }, expectHidden: { type: ["string", "object"] }, expectUrl: { type: "string" }, expectText: { type: ["string", "object"] }, contains: { type: "string" }, equals: { type: "string" }, matches: { type: "string" },
            } } },
            failOnConsoleErrors: { type: "boolean" },
          },
        },
        execute: async (input, ctx) => {
          const name = String(input.name ?? "").trim();
          const rawSteps = Array.isArray(input.steps) ? input.steps : [];
          const steps = normalizeBrowserCheckSteps(rawSteps);
          if (!name || name.length > 80) return { output: null, error: "Browser check name must contain 1 to 80 characters" };
          if (!steps?.length || steps.length > 30) return { output: null, error: "A browser check must contain 1 to 30 supported steps (goto, click, fill, press, waitMs, expectVisible, expectHidden, expectUrl, or a supported action/type form)" };
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
            if ("waitMs" in step && (!Number.isFinite(step.waitMs) || step.waitMs < 0 || step.waitMs > 5_000)) {
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
            for (const key of ["click", "fill", "expectVisible", "expectHidden", "expectText"] as const) {
              if (key in step) {
                const target: unknown = step[key as keyof typeof step];
                if (typeof target === "string") {
                  if (!target.trim()) return { output: null, error: `${key} selector cannot be empty` };
                  continue;
                }
                const targetObject = target as Record<string, unknown> | null;
                if (!targetObject || typeof targetObject !== "object" || !(
                  (typeof targetObject.role === "string" && typeof targetObject.name === "string") ||
                  typeof targetObject.label === "string" || typeof targetObject.text === "string" || typeof targetObject.css === "string"
                )) return { output: null, error: `${key} target needs role/name, label, text, or css` };
              }
            }
          }
          const existing = ctx.state.browserChecks ?? (ctx.state.browserChecks = []);
          const sameIndex = existing.findIndex((item) => item.name === name);
          const sameName = sameIndex >= 0 ? existing[sameIndex] : undefined;
          const filesCount = (ctx.state.changedFiles ?? []).length;
          (check as BrowserCheck & { filesCountAtDef?: number }).filesCountAtDef = filesCount;
          let selected = check;
          if (sameName) {
            const normalize = (value: BrowserCheck) => JSON.stringify({ port: value.port, steps: value.steps, failOnConsoleErrors: value.failOnConsoleErrors });
            const prevMeta = sameName as BrowserCheck & { locked?: boolean; filesCountAtDef?: number };
            const filesChangedSinceDef = typeof prevMeta.filesCountAtDef === "number" && prevMeta.filesCountAtDef !== filesCount;
            const isExpandingSteps = check.steps.length > sameName.steps.length;
            const wasLocked = prevMeta.locked === true && !filesChangedSinceDef && !isExpandingSteps && !/repro|bug|probe|smoke/i.test(name);
            if (normalize(sameName) !== normalize(check)) {
              if (wasLocked) {
                ctx.state.browserChecksHistory ??= [];
                ctx.state.browserChecksHistory.push(structuredClone(sameName));
                ctx.state.browserCheckTampering ??= [];
                ctx.state.browserCheckTampering.push(name);
                return { output: null, error: `Browser check "${name}" is immutable. The original definition was preserved and this change is flagged for review.` };
              }
              existing[sameIndex] = check;
              selected = check;
            } else {
              selected = sameName;
            }
          } else {
            if (existing.length >= 10) return { output: null, error: "A run may define at most 10 browser checks" };
            existing.push(check);
          }
          const d = await this.getDaemonAndHeaders(ctx);
          const ports = await d.daemon.handleRequest("GET", "/ports", d.headers);
          const knownPorts = Array.isArray(ports.body.ports) ? (ports.body.ports as Array<{ port: number }>).map((entry) => entry.port) : [];
          const port = selected.port ?? (ctx.state.previewUrl ? Number(new URL(ctx.state.previewUrl).port) : undefined) ?? knownPorts[knownPorts.length - 1];
          if (!port || !knownPorts.includes(port)) return { output: null, error: "Browser check requires a port started by this run" };
          const res = await d.daemon.handleRequest("POST", "/browser/run_flow", d.headers, { port, steps: selected.steps, failOnConsoleErrors: selected.failOnConsoleErrors });
          const result = res.body as Record<string, any>;
          (selected as BrowserCheck & { locked?: boolean }).locked = Boolean(result.passed);
          const { screenshotJpegBase64, ...safeResult } = result;
          return {
            output: { check: name, ...safeResult, evidence: formatBrowserEvidence(name, selected.steps.length, result, "") },
            error: result.passed ? undefined : String(result.error ?? "Browser check failed"),
            metadata: {
              url: safeResult.url,
              cursor: safeResult.cursor,
              
            },
          };
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
            const response = await d.daemon.handleRequest("POST", "/browser/run_flow", d.headers, { port, steps: check.steps, failOnConsoleErrors: check.failOnConsoleErrors });
            const result = response.body as Record<string, any>;
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
            parsedUrl = assertSafeExternalUrl(url);
          } catch (err) {
            return { output: null, error: `Invalid webfetch URL: ${(err as Error).message}` };
          }

          let response: Response;
          try {
            response = await fetchSafeExternal(parsedUrl, {
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
