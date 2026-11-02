import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { McpServerInfo, McpServerAdminInfo, McpPreset } from "@openharness/sdk";
import type { RegisteredTool, ToolExecutionContext, ToolExecutionResult } from "../agent/deps.ts";
import { getActiveSandboxDaemon } from "../sandbox/providers.ts";
import { resolveInside } from "../util/safe-path.ts";

type JsonObject = Record<string, unknown>;
type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
};

export interface McpServerConfig {
  name: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  title?: string;
  readOnly?: boolean;
  enabled?: boolean;
}

type ManagedServer = {
  name: string;
  status: "connected" | "connecting" | "failed" | "disabled";
  transport: "builtin" | "http" | "sse" | "stdio";
  tools: McpToolDefinition[];
  callTool: (name: string, args: JsonObject, signal?: AbortSignal, ctx?: ToolExecutionContext) => Promise<unknown>;
  disconnect?: () => Promise<void>;
  error?: string;
  config?: McpServerConfig;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

const PROTOCOL_VERSION = "2024-11-05";
const RPC_TIMEOUT_MS = 30_000;
const MAX_RPC_BYTES = 8 * 1024 * 1024;
const BUILTIN_SERVER_NAMES = ["filesystem", "memory", "sequential-thinking", "web-fetch", "document-studio"] as const;

export const BUILTIN_MCP_PRESETS: McpPreset[] = [
  { id: "filesystem", title: "Filesystem", category: "local", description: "Read files and inspect directories inside the active workspace." },
  { id: "memory", title: "Memory", category: "local", description: "Store and search entities and relationships for the current manager." },
  { id: "sequential-thinking", title: "Sequential Thinking", category: "local", description: "Structure a multi-step reasoning plan." },
  { id: "web-fetch", title: "Web Fetch", category: "web", description: "Search the web and fetch pages as readable Markdown." },
  { id: "github", title: "GitHub", category: "developer", description: "Connect a GitHub MCP server. Requires GITHUB_PERSONAL_ACCESS_TOKEN.", homepage: "https://github.com/modelcontextprotocol/servers", requiredSecrets: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN" }] },
  { id: "playwright", title: "Playwright", category: "browser", description: "Connect the Playwright MCP server for browser automation.", homepage: "https://github.com/microsoft/playwright-mcp" },
  { id: "postgres", title: "PostgreSQL", category: "database", description: "Connect a PostgreSQL MCP server. Configure its connection string before installing.", homepage: "https://github.com/modelcontextprotocol/servers" },
  { id: "brave-search", title: "Brave Search", category: "web", description: "Connect Brave Search MCP. Requires BRAVE_API_KEY.", homepage: "https://github.com/modelcontextprotocol/servers", requiredSecrets: [{ name: "BRAVE_API_KEY" }] },
  { id: "document-studio", title: "Document Studio", category: "document", description: "Extract Markdown and tables from office files, convert documents, and render diagrams." },
  { id: "mcp-pandoc", title: "Pandoc Converter", category: "document", description: "Convert across Markdown, HTML, DOCX, PDF, RST, and EPUB.", homepage: "https://github.com/vivekVells/mcp-pandoc" },
  { id: "office-word", title: "Office Word (.docx)", category: "document", description: "Create, style, and edit Word documents via MCP.", homepage: "https://github.com/gongrzhe/office-word-mcp-server" },
  { id: "excel", title: "Excel Workbook (.xlsx)", category: "document", description: "Read and write worksheets, tables, and formulas in workbooks.", homepage: "https://github.com/negokaz/excel-mcp-server" },
  { id: "word-to-pdf", title: "Word to PDF (unoserver)", category: "document", description: "Convert Word documents to PDF via LibreOffice.", homepage: "https://github.com/chfle/word-to-pdf-mcp" },
  { id: "sery-files", title: "Sery Data & Office SQL", category: "database", description: "Inspect tabular and office files with SQL workflows.", homepage: "https://github.com/seryai/sery-mcp" },
];

function tool(name: string, description: string, inputSchema: JsonObject, readOnly = true): McpToolDefinition {
  return { name, description, inputSchema, annotations: { readOnlyHint: readOnly, idempotentHint: readOnly } };
}

function objectSchema(properties: JsonObject, required: string[] = []): JsonObject {
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: true };
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function safeServerName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized.length > 64) throw new Error("MCP server name must be 1–64 letters, digits, hyphens, or underscores.");
  return normalized;
}

function toolSuffix(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
}

function parseRpcResponse(value: unknown, requestId: string | number): unknown {
  const message = value as JsonRpcMessage | null;
  if (!message || message.id !== requestId) throw new Error("MCP server returned an invalid JSON-RPC response.");
  if (message.error) throw new Error(`MCP server returned a JSON-RPC error${message.error.code === undefined ? "." : ` (${message.error.code}).`}`);
  return message.result;
}

async function readLimitedBody(response: Response, limit = MAX_RPC_BYTES): Promise<string> {
  const size = Number(response.headers.get("content-length"));
  if (Number.isFinite(size) && size > limit) throw new Error("MCP response exceeded the configured size limit.");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error("MCP response exceeded the configured size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function parseSsePayload(body: string): unknown {
  const data = body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  return data ? JSON.parse(data) : undefined;
}

function responseTextToRpc(text: string, contentType: string): unknown {
  if (contentType.includes("text/event-stream")) return parseSsePayload(text);
  return text.trim() ? JSON.parse(text) : undefined;
}

function mermaidFallbackSvg(source: string, theme = "default"): string {
  const edges: Array<[string, string]> = [];
  const labels = new Map<string, string>();
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(?:flowchart|graph)\b/i.test(line)) continue;
    const match = line.match(/^([\w-]+)(?:\[([^\]]+)\]|\(([^)]+)\))?\s*(?:-->|---|==>|-.->)\s*([\w-]+)(?:\[([^\]]+)\]|\(([^)]+)\))?/);
    if (match) {
      const [, from, fromLabel, fromRound, to, toLabel, toRound] = match;
      if (from) labels.set(from, fromLabel ?? fromRound ?? from);
      if (to) labels.set(to, toLabel ?? toRound ?? to);
      if (from && to) edges.push([from, to]);
      continue;
    }
    const node = line.match(/^([\w-]+)(?:\[([^\]]+)\]|\(([^)]+)\))$/);
    if (node?.[1]) labels.set(node[1], node[2] ?? node[3] ?? node[1]);
  }
  if (!labels.size) labels.set("source", source.trim().slice(0, 80) || "Diagram");
  const ids = [...labels.keys()].slice(0, 16);
  const dark = theme === "dark";
  const fill = dark ? "#1e293b" : "#ffffff", ink = dark ? "#e2e8f0" : "#0f172a", stroke = dark ? "#475569" : "#cbd5e1";
  const width = 1200, nodeW = 240, nodeH = 84, gapX = 100, gapY = 80, cols = 3;
  const positions = new Map(ids.map((id, index) => [id, { x: 80 + (index % cols) * (nodeW + gapX), y: 90 + Math.floor(index / cols) * (nodeH + gapY) }]));
  const height = Math.max(280, 190 + Math.ceil(ids.length / cols) * (nodeH + gapY));
  const connectors = edges.flatMap(([from, to]) => { const a = positions.get(from), b = positions.get(to); return a && b ? [`<path d="M ${a.x + nodeW / 2} ${a.y + nodeH} C ${a.x + nodeW / 2} ${a.y + nodeH + 35}, ${b.x + nodeW / 2} ${b.y - 35}, ${b.x + nodeW / 2} ${b.y}" fill="none" stroke="#5b8e88" stroke-width="3" marker-end="url(#arrow)"/>`] : []; }).join("");
  const nodes = ids.map((id) => { const p = positions.get(id)!; const label = (labels.get(id) ?? id).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); return `<g><rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${nodeH}" rx="16" fill="${fill}" stroke="${stroke}" stroke-width="2"/><text x="${p.x + nodeW / 2}" y="${p.y + 48}" text-anchor="middle" font-family="sans-serif" font-size="20" fill="${ink}">${label.slice(0, 32)}</text></g>`; }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="#5b8e88"/></marker></defs><rect width="100%" height="100%" fill="${dark ? "#0f172a" : "#f8fafc"}"/>${connectors}${nodes}</svg>`;
}

function assertRemoteUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("MCP server URL is invalid."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("MCP server URL must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("MCP server URLs must not contain credentials.");
  return url;
}

export class McpClientManager {
  private workspaceRoot: string;
  private dataDir?: string;
  private servers = new Map<string, ManagedServer>();
  private memory = new Map<string, Map<string, JsonObject>>();
  private relations = new Map<string, JsonObject[]>();
  private nextRequestId = 1;
  private storeRoot: string;
  private storePath: string;
  private resolveSecret?: (name: string) => string | undefined;

  constructor(opts: { workspaceRoot: string; dataDir?: string; autoConnectDefaults?: boolean; resolveSecret?: (name: string) => string | undefined }) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.dataDir = opts.dataDir ? path.resolve(opts.dataDir) : undefined;
    this.storeRoot = this.dataDir ?? this.workspaceRoot;
    this.storePath = this.dataDir
      ? path.join(this.storeRoot, "mcp-servers.json")
      : path.join(this.storeRoot, ".openharness", "mcp-servers.json");
    this.resolveSecret = opts.resolveSecret;
    if (opts.autoConnectDefaults !== false) this.installBuiltins();
    this.restoreSavedServers();
  }

  private installBuiltins(): void {
    for (const name of BUILTIN_SERVER_NAMES) this.activateBuiltin(name);
  }

  private activateBuiltin(name: typeof BUILTIN_SERVER_NAMES[number]): void {
    if (name === "filesystem") this.registerBuiltin("filesystem", this.filesystemTools(), async (toolName, args, _signal, ctx) => this.callFilesystem(toolName, args, ctx));
    else if (name === "memory") this.registerBuiltin("memory", this.memoryTools(), async (toolName, args, _signal, ctx) => this.callMemory(toolName, args, ctx));
    else if (name === "sequential-thinking") this.registerBuiltin("sequential-thinking", [tool("sequentialthinking", "Record a structured step in a sequential thinking plan.", objectSchema({ thought: { type: "string" }, thoughtNumber: { type: "integer" }, totalThoughts: { type: "integer" }, nextThoughtNeeded: { type: "boolean" }, isRevision: { type: "boolean" }, revisesThought: { type: "integer" } }), false)], async (_toolName, args) => ({ thoughtNumber: args.thoughtNumber, totalThoughts: args.totalThoughts, nextThoughtNeeded: args.nextThoughtNeeded ?? false, thought: asString(args.thought), isRevision: args.isRevision ?? false, revisesThought: args.revisesThought }));
    else if (name === "web-fetch") this.registerBuiltin("web-fetch", [
      tool("web_search", "Search public web pages using DuckDuckGo.", objectSchema({ query: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 10 } })),
      tool("fetch_markdown", "Fetch a public web page and return readable Markdown.", objectSchema({ url: { type: "string" } })),
    ], (toolName, args, signal) => this.callWebFetch(toolName, args, signal));
    else if (name === "document-studio") this.registerBuiltin("document-studio", [
      tool("extract_markdown", "Extract readable Markdown and tables from PDF and Office files.", objectSchema({ path: { type: "string" }, maxChars: { type: "integer" } }, ["path"])),
      tool("convert_document", "Convert a document inside the workspace using local conversion tools.", objectSchema({ inputPath: { type: "string" }, outputPath: { type: "string" } }, ["inputPath", "outputPath"]), false),
      tool("render_mermaid", "Render a Mermaid diagram as an SVG inside the workspace.", objectSchema({ code: { type: "string" }, outputPath: { type: "string" }, theme: { type: "string", enum: ["default", "neutral", "dark", "forest"] } }, ["code", "outputPath"]), false),
    ], (toolName, args, _signal, ctx) => this.callDocumentStudio(toolName, args, ctx));
  }

  private registerBuiltin(name: string, tools: McpToolDefinition[], callTool: ManagedServer["callTool"]): void {
    this.servers.set(name, { name, status: "connected", transport: "builtin", tools, callTool });
  }

  private filesystemTools(): McpToolDefinition[] {
    return [
      tool("read_multiple_files", "Read multiple UTF-8 files within the workspace.", objectSchema({ paths: { type: "array", items: { type: "string" } } }, ["paths"])),
      tool("directory_tree", "List a workspace directory tree without following symbolic links.", objectSchema({ path: { type: "string" }, maxDepth: { type: "integer" } })),
      tool("file_info", "Return file metadata for a workspace path.", objectSchema({ path: { type: "string" } }, ["path"])),
    ];
  }

  private memoryTools(): McpToolDefinition[] {
    return [
      tool("create_entities", "Create or update named memory entities.", objectSchema({ entities: { type: "array", items: { type: "object" } } }, ["entities"]), false),
      tool("create_relations", "Create relations between memory entities.", objectSchema({ relations: { type: "array", items: { type: "object" } } }, ["relations"]), false),
      tool("search_nodes", "Search memory entities by name or observation text.", objectSchema({ query: { type: "string" } })),
      tool("read_graph", "Read the memory graph.", objectSchema({})),
    ];
  }

  private async callFilesystem(name: string, args: JsonObject, ctx?: ToolExecutionContext): Promise<unknown> {
    const workspaceRoot = ctx?.workspaceRoot ?? this.workspaceRoot;
    const daemon = ctx?.sandboxHandleId ? getActiveSandboxDaemon(ctx.sandboxHandleId) : undefined;
    const daemonHeaders = daemon ? { "x-session-key": daemon.config.sessionKey } : undefined;

    if (name === "read_multiple_files") {
      const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [];
      if (paths.length > 100) throw new Error("At most 100 files can be read in one MCP request.");
      let bytesRead = 0;
      const files: Array<{ path: string; content: string }> = [];
      for (const file of paths) {
        let content: string;
        if (daemon && daemonHeaders) {
          const res = await daemon.handleRequest("POST", "/files/view", daemonHeaders, { path: file });
          if (res.status !== 200 || res.body.type === "directory") {
            throw new Error(String(res.body.error ?? `Could not read file: ${file}`));
          }
          content = String(res.body.content ?? "");
        } else {
          const target = resolveInside(workspaceRoot, file);
          content = fs.readFileSync(target, "utf8");
        }
        bytesRead += Buffer.byteLength(content, "utf8");
        if (bytesRead > 1024 * 1024) throw new Error("MCP file read exceeded the 1 MiB response limit.");
        files.push({ path: file, content });
      }
      return files;
    }
    if (name === "file_info") {
      const file = asString(args.path);
      if (daemon && daemonHeaders) {
        return daemon.handleRequest("POST", "/files/view", daemonHeaders, { path: file }).then((res) => {
          if (res.status !== 200) throw new Error(String(res.body.error ?? `Could not inspect file: ${file}`));
          const content = String(res.body.content ?? "");
          return { path: file, name: path.posix.basename(file), type: res.body.type ?? "file", size: Buffer.byteLength(content, "utf8") };
        });
      }
      const target = resolveInside(workspaceRoot, file);
      const stat = fs.statSync(target);
      return { path: file, name: path.basename(target), type: stat.isDirectory() ? "directory" : "file", size: stat.size, modifiedAt: stat.mtime.toISOString() };
    }
    if (name === "directory_tree") {
      if (daemon && daemonHeaders) {
        const rawRoot = asString(args.path, ".").replace(/\\/g, "/");
        const relativeRoot = path.posix.normalize(rawRoot).replace(/^\.\//, "");
        if (path.posix.isAbsolute(relativeRoot) || relativeRoot === ".." || relativeRoot.startsWith("../")) {
          throw new Error("path escapes the workspace");
        }
        const maxDepth = Math.max(0, Math.min(12, Number(args.maxDepth ?? 4) || 0));
        const pattern = !relativeRoot || relativeRoot === "." ? "**/*" : `${relativeRoot}/**/*`;
        const res = await daemon.handleRequest("POST", "/search/glob", daemonHeaders, { pattern, limit: 500 });
        if (res.status !== 200) throw new Error(String(res.body.error ?? "Could not list workspace files"));
        const rootName = relativeRoot && relativeRoot !== "." ? path.posix.basename(relativeRoot) : ".";
        const root: { name: string; type: "directory"; children: Array<Record<string, unknown>> } = {
          name: rootName,
          type: "directory",
          children: [],
        };
        const nodes = new Map<string, { name: string; type: "directory" | "file"; children?: Array<Record<string, unknown>> }>();
        nodes.set("", root);
        for (const rawMatch of Array.isArray(res.body.matches) ? res.body.matches : []) {
          const match = String(rawMatch).replace(/\\/g, "/").replace(/^\.\//, "");
          if (relativeRoot && relativeRoot !== "." && !match.startsWith(`${relativeRoot}/`)) continue;
          const underRoot = relativeRoot && relativeRoot !== "." ? match.slice(relativeRoot.length + 1) : match;
          const segments = underRoot.split("/").filter(Boolean);
          if (!segments.length || segments.length > maxDepth + 1) continue;
          let parentKey = "";
          for (let i = 0; i < segments.length; i++) {
            const segment = segments[i]!;
            const key = parentKey ? `${parentKey}/${segment}` : segment;
            if (!nodes.has(key)) {
              const isDirectory = i < segments.length - 1;
              const node = isDirectory
                ? { name: segment, type: "directory" as const, children: [] as Array<Record<string, unknown>> }
                : { name: segment, type: "file" as const };
              nodes.set(key, node);
              nodes.get(parentKey)!.children!.push(node);
            }
            parentKey = key;
          }
        }
        return { path: relativeRoot || ".", children: root.children };
      }
      const start = resolveInside(workspaceRoot, asString(args.path, "."));
      const maxDepth = Math.max(0, Math.min(12, Number(args.maxDepth ?? 4) || 0));
      let entriesSeen = 0;
      const walk = (dir: string, depth: number): JsonObject[] => {
        if (depth > maxDepth) return [];
        return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 1000).map((entry) => {
          entriesSeen++;
          if (entriesSeen > 5000) throw new Error("MCP directory tree exceeded the 5,000 entry limit.");
          return { name: entry.name, type: entry.isDirectory() ? "directory" : "file", ...(entry.isDirectory() ? { children: walk(path.join(dir, entry.name), depth + 1) } : {}) };
        });
      };
      return { path: path.relative(workspaceRoot, start) || ".", children: walk(start, 0) };
    }
    throw new Error(`Unknown filesystem tool: ${name}`);
  }

  private callMemory(name: string, args: JsonObject, ctx?: ToolExecutionContext): unknown {
    const scope = `${ctx?.tenantId ?? "default"}:${ctx?.sessionId ?? "default"}`;
    let entities = this.memory.get(scope);
    if (!entities) { entities = new Map(); this.memory.set(scope, entities); }
    let relations = this.relations.get(scope);
    if (!relations) { relations = []; this.relations.set(scope, relations); }
    if (name === "create_entities") {
      const newEntities = Array.isArray(args.entities) ? args.entities : [];
      for (const raw of newEntities) {
        if (!raw || typeof raw !== "object") continue;
        const entity = raw as JsonObject;
        const entityName = asString(entity.name).trim();
        if (entityName) entities.set(entityName, { ...entity, name: entityName });
      }
      return { entities: newEntities.length };
    }
    if (name === "create_relations") {
      const newRelations = Array.isArray(args.relations) ? args.relations.filter((value): value is JsonObject => !!value && typeof value === "object") : [];
      relations.push(...newRelations);
      return { relations: newRelations.length };
    }
    if (name === "search_nodes") {
      const query = asString(args.query).toLowerCase();
      return { nodes: [...entities.values()].filter((node) => JSON.stringify(node).toLowerCase().includes(query)) };
    }
    if (name === "read_graph") return { entities: [...entities.values()], relations };
    throw new Error(`Unknown memory tool: ${name}`);
  }

  private async callWebFetch(name: string, args: JsonObject, signal?: AbortSignal): Promise<unknown> {
    if (name === "web_search") {
      const query = asString(args.query).trim();
      if (!query) throw new Error("A search query is required.");
      const url = new URL("https://html.duckduckgo.com/html/");
      url.searchParams.set("q", query);
      const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(15_000), headers: { "User-Agent": "OpenHarness/1.0" }, redirect: "error" });
      if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}.`);
      const html = await readLimitedBody(response, 2 * 1024 * 1024);
      const results: JsonObject[] = [];
      const pattern = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      for (const match of html.matchAll(pattern)) {
        const href = match[1] ?? "";
        const title = stripHtml(match[2] ?? "");
        const decoded = href.startsWith("//") ? `https:${href}` : href;
        try {
          const link = new URL(decoded, "https://duckduckgo.com");
          const redirect = link.searchParams.get("uddg");
          results.push({ title, url: redirect ? decodeURIComponent(redirect) : link.toString() });
        } catch { /* Skip malformed results. */ }
        if (results.length >= Math.max(1, Math.min(10, Number(args.count ?? 5) || 5))) break;
      }
      return { query, results };
    }
    if (name === "fetch_markdown") {
      const url = assertRemoteUrl(asString(args.url));
      const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(15_000), headers: { "User-Agent": "OpenHarness/1.0", Accept: "text/html,text/plain,application/xhtml+xml" }, redirect: "error" });
      if (!response.ok) throw new Error(`Page fetch failed with HTTP ${response.status}.`);
      const body = await readLimitedBody(response, 2 * 1024 * 1024);
      const contentType = response.headers.get("content-type") ?? "";
      const text = contentType.includes("html") ? htmlToText(body) : body;
      return { url: url.toString(), content: text.slice(0, 100_000), contentType };
    }
    throw new Error(`Unknown web-fetch tool: ${name}`);
  }

  private async callDocumentStudio(name: string, args: JsonObject, ctx?: ToolExecutionContext): Promise<unknown> {
    const workspace = ctx?.workspaceRoot ?? this.workspaceRoot;
    const daemon = ctx?.sandboxHandleId ? getActiveSandboxDaemon(ctx.sandboxHandleId) : undefined;
    const runPython = async (source: string, values: JsonObject): Promise<JsonObject> => {
      const code = `import base64;exec(base64.b64decode('${Buffer.from(source).toString("base64")}'))`;
      const argument = Buffer.from(JSON.stringify(values)).toString("base64");
      if (daemon) {
        const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
        const result = await daemon.handleRequest("POST", "/exec", { "x-session-key": daemon.config.sessionKey }, { command: `python3 -c ${quote(code)} ${quote(argument)}`, timeoutSec: 55 });
        if (result.status !== 200 || Number(result.body.exitCode ?? 0) !== 0) throw new Error(String(result.body.stderr ?? result.body.error ?? "Document operation failed"));
        const text = String(result.body.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "{}";
        return JSON.parse(text) as JsonObject;
      }
      const proc = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", `import base64;exec(base64.b64decode('${Buffer.from(source).toString("base64")}'))`, argument], { cwd: workspace, encoding: "utf8", timeout: 55_000, maxBuffer: 8 * 1024 * 1024 });
      if (proc.status !== 0) throw new Error((proc.stderr || proc.error?.message || "Document operation failed").slice(-2000));
      return JSON.parse(proc.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as JsonObject;
    };
    if (name === "extract_markdown") {
      const file = asString(args.path);
      resolveInside(workspace, file);
      const source = `import json,sys,base64\na=json.loads(base64.b64decode(sys.argv[1])); p=a['path']; text=''\ntry:\n from markitdown import MarkItDown; text=MarkItDown().convert(p).text_content\nexcept Exception:\n ext=p.lower().rsplit('.',1)[-1]\n if ext=='pdf':\n  try:\n   import pdfplumber\n   with pdfplumber.open(p) as pdf: text='\\n\\n'.join((page.extract_text() or '') for page in pdf.pages)\n  except Exception:\n   from pypdf import PdfReader; text='\\n\\n'.join(page.extract_text() or '' for page in PdfReader(p).pages)\n elif ext=='docx':\n  from docx import Document; d=Document(p); text='\\n'.join(x.text for x in d.paragraphs)+'\\n'+'\\n'.join(' | '.join(c.text for c in r.cells) for t in d.tables for r in t.rows)\n elif ext in ('xlsx','xlsm'):\n  import openpyxl; w=openpyxl.load_workbook(p,data_only=False,read_only=True); text='\\n\\n'.join('# '+s.title+'\\n'+'\\n'.join('| '+' | '.join('' if c.value is None else str(c.value) for c in row)+' |' for row in s.iter_rows()) for s in w.worksheets)\n elif ext=='pptx':\n  from pptx import Presentation; d=Presentation(p); text='\\n\\n'.join('# Slide '+str(i+1)+'\\n'+'\\n'.join(sh.text for sh in slide.shapes if getattr(sh,'has_text_frame',False)) for i,slide in enumerate(d.slides))\n else: text=open(p,encoding='utf-8',errors='replace').read()\nprint(json.dumps({'path':p,'markdown':text[:max(1,min(100000,int(a.get('maxChars',40000))))]}))`;
      return runPython(source, { path: file, maxChars: args.maxChars ?? 40_000 });
    }
    if (name === "convert_document") {
      const inputPath = asString(args.inputPath); const outputPath = asString(args.outputPath);
      resolveInside(workspace, inputPath); resolveInside(workspace, outputPath);
      const source = `import json,sys,base64,subprocess,os,tempfile,pathlib,shutil\na=json.loads(base64.b64decode(sys.argv[1])); root=pathlib.Path.cwd().resolve(); src=(root/a['inputPath']).resolve(); dst=(root/a['outputPath']).resolve(); src.relative_to(root); dst.relative_to(root)\nif not src.is_file(): raise SystemExit('Input file not found')\ndst.parent.mkdir(parents=True,exist_ok=True); ext=dst.suffix.lower(); tmp=pathlib.Path(tempfile.mkdtemp(prefix='oh_convert_')); profile=pathlib.Path(tempfile.mkdtemp(prefix='lo_prof_'))\ntry:\n if ext=='.pdf' and src.suffix.lower() in ('.docx','.xlsx','.pptx','.odt','.ods','.odp','.rtf'):\n  env=os.environ.copy(); env.update({'HOME':'/tmp','TMPDIR':'/tmp'}); r=subprocess.run(['soffice','-env:UserInstallation=file://'+str(profile),'--headless','--convert-to','pdf','--outdir',str(tmp),str(src)],capture_output=True,text=True,timeout=45,env=env); created=tmp/(src.stem+'.pdf')\n  if r.returncode or not created.exists(): raise RuntimeError((r.stderr or r.stdout or 'LibreOffice conversion failed')[-1200:])\n  shutil.copyfile(created,dst)\n else:\n  r=subprocess.run(['pandoc',str(src),'-o',str(dst)],capture_output=True,text=True,timeout=45)\n  if r.returncode: raise RuntimeError((r.stderr or 'Pandoc conversion failed')[-1200:])\n print(json.dumps({'inputPath':a['inputPath'],'outputPath':a['outputPath'],'size':dst.stat().st_size}))\nfinally: shutil.rmtree(tmp,ignore_errors=True); shutil.rmtree(profile,ignore_errors=True)`;
      return runPython(source, { inputPath, outputPath });
    }
    if (name === "render_mermaid") {
      const outputPath = asString(args.outputPath);
      if (!outputPath || path.isAbsolute(outputPath) || outputPath.includes("..")) throw new Error("outputPath must stay inside the workspace");
      const code = asString(args.code).slice(0, 100_000);
      const requestedTheme = asString(args.theme, "default");
      const theme = ["default", "neutral", "dark", "forest"].includes(requestedTheme) ? requestedTheme : "default";
      let buffer: Buffer | undefined;
      const id = randomUUID().replace(/-/g, "");
      if (daemon) {
        const headers = { "x-session-key": daemon.config.sessionKey };
        const sourcePath = `/tmp/oh_mermaid_${id}.mmd`, resultPath = `/tmp/oh_mermaid_${id}.svg`;
        const sourceWrite = await daemon.handleRequest("POST", "/files/write_bytes", headers, { path: sourcePath, dataBase64: Buffer.from(code).toString("base64"), overwrite: true });
        if (sourceWrite.status === 200) {
          const command = `/opt/oh/node_modules/.bin/mmdc -p /opt/oh/mermaid-puppeteer.json -i ${sourcePath} -o ${resultPath} -t ${theme}`;
          const rendered = await daemon.handleRequest("POST", "/exec", headers, { command, timeoutSec: 45 });
          if (rendered.status === 200 && Number(rendered.body.exitCode ?? 0) === 0) {
            const read = await daemon.handleRequest("POST", "/files/read_bytes", headers, { path: resultPath });
            if (read.status === 200 && typeof read.body.dataBase64 === "string") buffer = Buffer.from(read.body.dataBase64, "base64");
          }
        }
      } else {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), "oh-mermaid-"));
        const sourcePath = path.join(temp, "diagram.mmd"), resultPath = path.join(temp, "diagram.svg");
        try {
          fs.writeFileSync(sourcePath, code, "utf8");
          const executable = process.platform === "win32" ? "npx.cmd" : "npx";
          const args = ["--no-install", "mmdc", "-i", sourcePath, "-o", resultPath, "-t", theme];
          const puppeteerConfig = path.join(process.env.OPENHARNESS_MERMAID_CONFIG ?? "/opt/oh/mermaid-puppeteer.json");
          if (fs.existsSync(puppeteerConfig)) args.push("-p", puppeteerConfig);
          const rendered = spawnSync(executable, args, { cwd: workspace, encoding: "utf8", timeout: 45_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
          if (rendered.status === 0 && fs.existsSync(resultPath)) buffer = fs.readFileSync(resultPath);
        } catch { /* Use the built-in SVG flowchart renderer below. */ }
        finally { fs.rmSync(temp, { recursive: true, force: true }); }
      }
      const renderer = buffer ? "mermaid-cli" : "svg-flowchart-fallback";
      buffer ??= Buffer.from(mermaidFallbackSvg(code, theme));
      if (daemon) {
        const write = await daemon.handleRequest("POST", "/files/write_bytes", { "x-session-key": daemon.config.sessionKey }, { path: outputPath, dataBase64: buffer.toString("base64"), overwrite: true });
        if (write.status !== 200) throw new Error(String(write.body.error ?? "Could not write SVG"));
      } else {
        const target = resolveInside(workspace, outputPath); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, buffer);
      }
      return { outputPath, bytes: buffer.byteLength, mimeType: "image/svg+xml", renderer };
    }
    throw new Error(`Unknown document-studio tool: ${name}`);
  }

  listServers(): McpServerInfo[] {
    return [...this.servers.values()].map((server) => ({ name: server.name, status: server.status, readOnly: server.tools.every((entry) => entry.annotations?.readOnlyHint === true), toolsCount: server.tools.length, ...(server.error ? { error: server.error } : {}) }));
  }

  listPublicServers(): McpServerInfo[] {
    return this.listServers().map(({ name, status, readOnly, toolsCount }) => ({ name, status, readOnly, toolsCount }));
  }

  listAdminServers(): McpServerAdminInfo[] {
    const configs = this.readSavedConfigs();
    const byName = new Map(configs.map((config) => [config.name, config]));
    return [...this.servers.values()].map((server) => {
      const config = server.config ?? byName.get(server.name);
      let safeUrl: string | undefined;
      if (config?.url) {
        try { const parsed = new URL(config.url); parsed.search = ""; parsed.hash = ""; safeUrl = parsed.toString(); } catch { safeUrl = undefined; }
      }
      return {
        name: server.name,
        title: config?.title ?? server.name,
        status: server.status,
        readOnly: server.transport === "builtin" ? server.tools.every((entry) => entry.annotations?.readOnlyHint === true) : config?.readOnly ?? false,
        toolsCount: server.tools.length,
        error: server.error,
        transport: server.transport,
        enabled: server.status !== "disabled",
        url: safeUrl,
        headers: config?.headers ? this.maskConfigMap(server.name, config.headers) : undefined,
        command: config?.command ? this.maskArgs(server.name, [config.command]) : undefined,
        args: config?.args ? this.maskArgs(server.name, config.args) : undefined,
        cwd: config?.cwd,
        env: config?.env ? this.maskConfigMap(server.name, config.env) : undefined,
        timeoutMs: config?.timeoutMs,
        tools: server.tools.map((entry) => entry.name),
      };
    });
  }

  listPresets(): Array<McpPreset & { installed: boolean }> {
    const configuredNames = new Set(this.readSavedConfigs().map((config) => config.name));
    return BUILTIN_MCP_PRESETS.map((preset) => ({
      ...preset,
      installed: configuredNames.has(preset.id) || (BUILTIN_SERVER_NAMES as readonly string[]).includes(preset.id),
      requiredSecrets: preset.requiredSecrets?.map((secret) => ({
        name: secret.name,
        stored: Boolean(this.resolveSecret?.(secret.name) ?? process.env[secret.name]),
      })),
    }));
  }

  private maskConfigMap(serverName: string, values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => {
      const existingSecret = value.match(/\{secret:([^}]+)\}/i)?.[1];
      const sensitive = /auth|token|key|secret|password|credential/i.test(key) || /\bBearer\s+\S+|\bgh[pousr]_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9_-]{20,}|\beyJ[A-Za-z0-9_-]{20,}\./i.test(value);
      return [key, existingSecret ? `{secret:${existingSecret}}` : sensitive ? `{secret:MCP_${serverName}_${key}}` : value];
    }));
  }

  private maskArgs(serverName: string, args: string[]): string[] {
    return args.map((arg, index) => {
      const previous = args[index - 1] ?? "";
      if (/token|key|secret|password|credential|connection[-_ ]?string/i.test(previous) && !arg.startsWith("--")) {
        return `{secret:MCP_${serverName}_ARG${index}}`;
      }
      if (/\bBearer\s+\S+|\bgh[pousr]_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9_-]{20,}|\beyJ[A-Za-z0-9_-]{20,}\./i.test(arg)) {
        return `{secret:MCP_${serverName}_ARG${index}}`;
      }
      return arg;
    });
  }

  listTools(): RegisteredTool[] {
    const tools: RegisteredTool[] = [];
    for (const server of this.servers.values()) {
      if (server.status !== "connected") continue;
      for (const definition of server.tools) {
        const name = `mcp__${toolSuffix(server.name.replace(/-/g, "_"))}__${toolSuffix(definition.name)}`;
        tools.push({
          name,
          description: definition.description ?? `MCP tool ${definition.name} from ${server.name}`,
          source: "mcp",
          // Remote annotations are untrusted; route every remote MCP call through approval policy.
          readOnly: server.transport === "builtin" && definition.annotations?.readOnlyHint === true,
          idempotent: definition.annotations?.idempotentHint === true,
          parameters: definition.inputSchema ?? objectSchema({}),
          execute: async (input, ctx) => this.executeDiscoveredTool(server.name, definition.name, input, ctx),
        });
      }
    }
    return tools;
  }

  private async executeDiscoveredTool(serverName: string, toolName: string, args: JsonObject, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const server = this.servers.get(serverName);
    if (!server || server.status !== "connected") return { output: null, error: `MCP server ${serverName} is not connected.` };
    try { return { output: await server.callTool(toolName, args, ctx.signal, ctx), untrusted: server.transport !== "builtin" || serverName === "web-fetch", provenance: `mcp:${serverName}/${toolName}` }; }
    catch (error) { return { output: null, error: error instanceof Error ? error.message : "MCP tool call failed." }; }
  }

  async connectHttpMcpServer(name: string, url: string, options: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<McpServerInfo> {
    return this.connectRemote({ name, url, transport: "http", ...options });
  }

  async connectStdioMcpServer(name: string, command: string, args: string[] = [], options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<McpServerInfo> {
    return this.connectRemote({ name, command, args, transport: "stdio", ...options });
  }

  async connectSseMcpServer(name: string, url: string, options: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<McpServerInfo> {
    return this.connectRemote({ name, url, transport: "sse", ...options });
  }

  async saveAndConnectServer(configOrName: McpServerConfig | string, updates?: Partial<McpServerConfig> & { enabled?: boolean }): Promise<McpServerInfo> {
    const priorConfig = typeof configOrName === "string"
      ? this.readSavedConfigs().find((entry) => entry.name === configOrName) ?? this.servers.get(configOrName)?.config
      : undefined;
    const config: McpServerConfig = typeof configOrName === "string"
      ? { ...priorConfig, ...updates, name: configOrName } as McpServerConfig
      : configOrName;
    const normalized = { ...config, name: safeServerName(config.name) };
    if (updates?.enabled === false) {
      const existing = this.servers.get(normalized.name);
      await existing?.disconnect?.();
      if ((BUILTIN_SERVER_NAMES as readonly string[]).includes(normalized.name)) {
        if (existing) this.servers.set(normalized.name, { ...existing, status: "disabled" });
      } else {
        const disabledConfig = { ...normalized, enabled: false };
        this.persistConfig(disabledConfig);
        this.servers.set(normalized.name, { name: normalized.name, status: "disabled", transport: normalized.transport ?? "stdio", tools: [], config: disabledConfig, callTool: async () => { throw new Error("MCP server is disabled."); } });
      }
      return { name: normalized.name, status: "disabled", readOnly: false, toolsCount: 0 };
    }
    if ((BUILTIN_SERVER_NAMES as readonly string[]).includes(normalized.name) && !normalized.transport) {
      const builtin = this.servers.get(normalized.name);
      if (!builtin) throw new Error(`Built-in server ${normalized.name} is unavailable.`);
      this.servers.set(normalized.name, { ...builtin, status: "connected" });
      return { name: builtin.name, status: "connected", readOnly: builtin.tools.every((entry) => entry.annotations?.readOnlyHint === true), toolsCount: builtin.tools.length };
    }
    if (!normalized.transport) throw new Error(`No saved MCP connection settings exist for ${normalized.name}.`);
    this.persistConfig(normalized);
    return this.connectRemote(normalized);
  }

  async installPreset(id: string, options: Partial<McpServerConfig> = {}): Promise<McpServerInfo> {
    const preset = BUILTIN_MCP_PRESETS.find((item) => item.id === id);
    if (!preset) throw new Error(`Unknown MCP preset: ${id}`);
    if (BUILTIN_SERVER_NAMES.includes(id as typeof BUILTIN_SERVER_NAMES[number])) {
      this.activateBuiltin(id as typeof BUILTIN_SERVER_NAMES[number]);
      const server = this.servers.get(id)!;
      return { name: server.name, status: server.status, readOnly: server.tools.every((entry) => entry.annotations?.readOnlyHint), toolsCount: server.tools.length };
    }
    const config = this.presetConfig(id, options);
    if (!config) throw new Error(`Preset ${id} requires connection settings. Pass transport, command or URL, and any required environment values.`);
    return this.saveAndConnectServer(config);
  }

  private presetConfig(id: string, options: Partial<McpServerConfig>): McpServerConfig | undefined {
    if (options.transport) return { ...options, name: id, transport: options.transport } as McpServerConfig;
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const uvx = process.platform === "win32" ? "uvx.exe" : "uvx";
    if (id === "playwright") return { name: id, transport: "stdio", command: npx, args: ["-y", "@playwright/mcp@latest"], ...options } as McpServerConfig;
    if (id === "mcp-pandoc") return { name: id, transport: "stdio", command: uvx, args: ["mcp-pandoc"], ...options } as McpServerConfig;
    if (id === "office-word") return { name: id, transport: "stdio", command: uvx, args: ["--from", "office-word-mcp-server", "word_mcp_server"], ...options } as McpServerConfig;
    if (id === "excel") return { name: id, transport: "stdio", command: npx, args: ["-y", "@negokaz/excel-mcp-server"], ...options } as McpServerConfig;
    if (id === "word-to-pdf") return { name: id, transport: "stdio", command: uvx, args: ["word-to-pdf-mcp"], ...options } as McpServerConfig;
    if (id === "sery-files") return { name: id, transport: "stdio", command: uvx, args: ["sery-mcp"], ...options } as McpServerConfig;
    if (id === "github" && (this.resolveSecret?.("GITHUB_PERSONAL_ACCESS_TOKEN") ?? process.env.GITHUB_PERSONAL_ACCESS_TOKEN)) return { name: id, transport: "stdio", command: npx, args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{secret:GITHUB_PERSONAL_ACCESS_TOKEN}" }, ...options } as McpServerConfig;
    if (id === "brave-search" && (this.resolveSecret?.("BRAVE_API_KEY") ?? process.env.BRAVE_API_KEY)) return { name: id, transport: "stdio", command: npx, args: ["-y", "@modelcontextprotocol/server-brave-search"], env: { BRAVE_API_KEY: "{secret:BRAVE_API_KEY}" }, ...options } as McpServerConfig;
    if (id === "postgres" && options.args?.length) return { name: id, transport: "stdio", command: npx, args: ["-y", "@modelcontextprotocol/server-postgres", ...options.args], ...options } as McpServerConfig;
    return undefined;
  }

  async removeServer(name: string): Promise<void> {
    const normalized = safeServerName(name);
    const server = this.servers.get(normalized);
    await server?.disconnect?.();
    if ((BUILTIN_SERVER_NAMES as readonly string[]).includes(normalized)) {
      if (server) this.servers.set(normalized, { ...server, status: "disabled", tools: [] });
    } else {
      this.servers.delete(normalized);
    }
    this.persistConfig(undefined, normalized);
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map(async (server) => {
      try { await server.disconnect?.(); } catch { /* Best-effort process and session cleanup. */ }
    }));
  }

  buildTools(): RegisteredTool[] {
    const adminTools: RegisteredTool[] = [
      { name: "mcp_list_servers", description: "List configured MCP servers and their connection status.", readOnly: true, idempotent: true, parameters: objectSchema({}), execute: async () => ({ output: this.listServers() }) },
      { name: "mcp_call_tool", description: "Call a tool on a connected MCP server by server and tool name.", readOnly: false, idempotent: false, parameters: objectSchema({ server: { type: "string" }, tool: { type: "string" }, arguments: { type: "object" } }, ["server", "tool"]), execute: async (input, ctx) => {
        const serverName = asString(input.server);
        const toolName = asString(input.tool);
        const server = this.servers.get(serverName);
        if (!server || server.status !== "connected") return { output: null, error: `MCP server ${serverName} is not connected.` };
        return this.executeDiscoveredTool(serverName, toolName, (input.arguments && typeof input.arguments === "object" ? input.arguments : {}) as JsonObject, ctx);
      } },
      { name: "mcp_connect_server", description: "Connect an MCP server using HTTP, SSE, or a local stdio command.", readOnly: false, idempotent: true, parameters: objectSchema({ name: { type: "string" }, transport: { type: "string", enum: ["http", "sse", "stdio"] }, url: { type: "string" }, command: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, env: { type: "object" }, headers: { type: "object" } }, ["name", "transport"]), execute: async (input) => {
        try {
          const config: McpServerConfig = { name: asString(input.name), transport: asString(input.transport) as McpServerConfig["transport"], url: asString(input.url) || undefined, command: asString(input.command) || undefined, args: Array.isArray(input.args) ? input.args.map(String) : undefined, cwd: asString(input.cwd) || undefined, headers: input.headers && typeof input.headers === "object" ? input.headers as Record<string, string> : undefined, env: input.env && typeof input.env === "object" ? input.env as Record<string, string> : undefined };
          return { output: await this.saveAndConnectServer(config) };
        } catch (error) { return { output: null, error: error instanceof Error ? error.message : "MCP connection failed." }; }
      } },
    ];
    return [...this.listTools(), ...adminTools];
  }

  private async connectRemote(config: McpServerConfig): Promise<McpServerInfo> {
    const name = safeServerName(config.name);
    if ((BUILTIN_SERVER_NAMES as readonly string[]).includes(name)) throw new Error(`MCP server name ${name} is reserved.`);
    const previous = this.servers.get(name);
    await previous?.disconnect?.();
    const pending: ManagedServer = { name, status: "connecting", transport: config.transport, tools: [], callTool: async () => { throw new Error("MCP server is still connecting."); }, config };
    this.servers.set(name, pending);
    try {
      if (config.enabled === false) {
        const disabled: ManagedServer = { ...pending, status: "disabled", config, callTool: async () => { throw new Error("MCP server is disabled."); } };
        this.servers.set(name, disabled);
        return { name, status: "disabled", toolsCount: 0, readOnly: false };
      }
      const connectionConfig = this.resolveConfigSecrets(config);
      const connection = config.transport === "stdio" ? await this.openStdio(connectionConfig) : await this.openHttp(connectionConfig);
      const server: ManagedServer = { ...pending, status: "connected", tools: connection.tools, callTool: connection.callTool, disconnect: connection.disconnect };
      this.servers.set(name, server);
      return { name, status: server.status, toolsCount: server.tools.length, readOnly: server.tools.every((entry) => entry.annotations?.readOnlyHint === true) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "MCP connection failed.";
      const failed: ManagedServer = { ...pending, status: "failed", error: message };
      this.servers.set(name, failed);
      throw new Error(`Failed to connect MCP server ${name}: ${message}`);
    }
  }

  private resolveConfigSecrets(config: McpServerConfig): McpServerConfig {
    const resolve = (value: string): string => value.replace(/\{secret:([^}]+)\}/gi, (_match, name: string) => {
      const secret = this.resolveSecret?.(name) ?? process.env[name];
      if (!secret) throw new Error("MCP connection is missing a configured secret.");
      return secret;
    });
    return {
      ...config,
      headers: config.headers ? Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, resolve(value)])) : undefined,
      env: config.env ? Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, resolve(value)])) : undefined,
    };
  }

  private async openHttp(config: McpServerConfig): Promise<{ tools: McpToolDefinition[]; callTool: ManagedServer["callTool"]; disconnect: () => Promise<void> }> {
    const url = assertRemoteUrl(config.url ?? "");
    if (config.transport === "sse") return this.openSse(config, url);
    let sessionId: string | undefined;
    const timeout = Math.max(1000, Math.min(120_000, config.timeoutMs ?? RPC_TIMEOUT_MS));
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...config.headers };
    const request = async (method: string, params: JsonObject = {}): Promise<unknown> => {
      const id = this.nextRequestId++;
      const response = await fetch(url, { method: "POST", headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(timeout), redirect: "error" });
      const sid = response.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
      if (!response.ok) throw new Error(`MCP HTTP request failed with status ${response.status}.`);
      const raw = await readLimitedBody(response);
      return parseRpcResponse(responseTextToRpc(raw, response.headers.get("content-type") ?? ""), id);
    };
    await request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "OpenHarness", version: "0.2.0" } });
    const initResponse = await fetch(url, { method: "POST", headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal: AbortSignal.timeout(timeout), redirect: "error" });
    if (!initResponse.ok && initResponse.status !== 202) throw new Error(`MCP initialized notification failed with status ${initResponse.status}.`);
    const listed = await request("tools/list");
    const tools = normalizeTools(listed);
    return { tools, callTool: async (name, args) => request("tools/call", { name, arguments: args }), disconnect: async () => {
      if (sessionId) { try { await fetch(url, { method: "DELETE", headers: { ...headers, "mcp-session-id": sessionId }, signal: AbortSignal.timeout(3000), redirect: "error" }); } catch { /* Best effort session cleanup. */ } }
    } };
  }

  private async openSse(config: McpServerConfig, url: URL): Promise<{ tools: McpToolDefinition[]; callTool: ManagedServer["callTool"]; disconnect: () => Promise<void> }> {
    const controller = new AbortController();
    const headers = { accept: "text/event-stream", ...config.headers };
    const response = await fetch(url, { headers, signal: controller.signal, redirect: "error" });
    if (!response.ok || !response.body) throw new Error(`MCP SSE connection failed with status ${response.status}.`);
    const reader = response.body.getReader();
    let postUrl: URL | undefined;
    const pending = new Map<string | number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let eventBuffer = "";
    const endpointPromise = new Promise<URL>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP SSE server did not announce a message endpoint.")), Math.min(15_000, config.timeoutMs ?? 15_000));
      const endpointResolve = (value: URL) => { clearTimeout(timer); resolve(value); };
      void (async () => {
        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            eventBuffer += new TextDecoder().decode(value, { stream: true });
            let boundary: number;
            while ((boundary = eventBuffer.search(/\r?\n\r?\n/)) >= 0) {
              const event = eventBuffer.slice(0, boundary);
              eventBuffer = eventBuffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
              const eventName = event.match(/^event:\s*(.+)$/m)?.[1]?.trim();
              const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
              if (!data) continue;
              if (eventName === "endpoint") {
                postUrl = new URL(data, url);
                if (postUrl.protocol !== "https:" && postUrl.protocol !== "http:") throw new Error("MCP SSE endpoint must use HTTP or HTTPS.");
                if (postUrl.origin !== url.origin || postUrl.username || postUrl.password) throw new Error("MCP SSE endpoint must stay on the configured server origin.");
                endpointResolve(postUrl);
              } else if (eventName === "message") {
                const message = JSON.parse(data) as JsonRpcMessage;
                if (message.id !== undefined) {
                  const waiter = pending.get(message.id);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    pending.delete(message.id);
                    try { waiter.resolve(parseRpcResponse(message, message.id)); } catch (error) { waiter.reject(error as Error); }
                  }
                }
              }
            }
          }
        } catch (error) {
          for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error as Error); }
        }
      })();
    });
    const endpoint = await endpointPromise;
    const request = async (method: string, params: JsonObject = {}, notification = false): Promise<unknown> => {
      if (!postUrl) postUrl = endpoint;
      const id = this.nextRequestId++;
      const message = { jsonrpc: "2.0", ...(notification ? {} : { id }), method, params };
      if (notification) {
        const sent = await fetch(postUrl, { method: "POST", headers: { "content-type": "application/json", ...config.headers }, body: JSON.stringify(message), signal: AbortSignal.timeout(config.timeoutMs ?? RPC_TIMEOUT_MS), redirect: "error" });
        if (!sent.ok && sent.status !== 202) throw new Error(`MCP SSE post failed with status ${sent.status}.`);
        return undefined;
      }
      const result = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request ${method} timed out.`)); }, config.timeoutMs ?? RPC_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
      });
      const sent = await fetch(postUrl, { method: "POST", headers: { "content-type": "application/json", ...config.headers }, body: JSON.stringify(message), signal: AbortSignal.timeout(config.timeoutMs ?? RPC_TIMEOUT_MS), redirect: "error" });
      if (!sent.ok && sent.status !== 202) { pending.delete(id); throw new Error(`MCP SSE post failed with status ${sent.status}.`); }
      const contentType = sent.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const parsed = JSON.parse(await readLimitedBody(sent)) as JsonRpcMessage;
        const waiter = pending.get(id);
        if (waiter) { clearTimeout(waiter.timer); pending.delete(id); waiter.resolve(parseRpcResponse(parsed, id)); }
      }
      return result;
    };
    await request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "OpenHarness", version: "0.2.0" } });
    await request("notifications/initialized", {}, true);
    const listed = await request("tools/list");
    return { tools: normalizeTools(listed), callTool: async (name, args) => request("tools/call", { name, arguments: args }), disconnect: async () => { controller.abort(); try { await reader.cancel(); } catch { /* Already closed. */ } } };
  }

  private async openStdio(config: McpServerConfig): Promise<{ tools: McpToolDefinition[]; callTool: ManagedServer["callTool"]; disconnect: () => Promise<void> }> {
    const command = config.command?.trim();
    if (!command) throw new Error("An MCP stdio command is required.");
    const cwd = config.cwd ? resolveInside(this.workspaceRoot, config.cwd) : this.workspaceRoot;
    const inheritedEnv: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG"]) {
      const value = process.env[key];
      if (value !== undefined) inheritedEnv[key] = value;
    }
    const child = spawn(command, config.args ?? [], { cwd, env: { ...inheritedEnv, ...config.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    const pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let output = Buffer.alloc(0);
    let closed = false;
    const failPending = (error: Error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
    child.stdout.on("data", (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > MAX_RPC_BYTES * 2) { output = Buffer.alloc(0); failPending(new Error("MCP stdio output exceeded the configured size limit.")); return; }
      while (true) {
        const separator = output.indexOf("\r\n\r\n");
        if (separator < 0) break;
        const header = output.subarray(0, separator).toString("ascii");
        const length = Number(header.match(/content-length:\s*(\d+)/i)?.[1]);
        if (!Number.isInteger(length) || length < 0 || length > MAX_RPC_BYTES) { output = Buffer.alloc(0); failPending(new Error("MCP stdio server sent an invalid frame.")); return; }
        const frameEnd = separator + 4 + length;
        if (output.length < frameEnd) break;
        const payload = output.subarray(separator + 4, frameEnd).toString("utf8");
        output = output.subarray(frameEnd);
        try {
          const message = JSON.parse(payload) as JsonRpcMessage;
          if (message.id === undefined) continue;
          const waiter = pending.get(message.id);
          if (!waiter) continue;
          clearTimeout(waiter.timer);
          pending.delete(message.id);
          try { waiter.resolve(parseRpcResponse(message, message.id)); } catch (error) { waiter.reject(error as Error); }
        } catch { failPending(new Error("MCP stdio server returned invalid JSON.")); }
      }
    });
    child.on("error", () => { closed = true; failPending(new Error("MCP stdio process could not be started.")); });
    child.on("exit", () => { closed = true; failPending(new Error("MCP stdio process exited.")); });
    child.stderr.on("data", () => { /* Deliberately do not retain or expose process logs. */ });
    const timeout = Math.max(1000, Math.min(120_000, config.timeoutMs ?? RPC_TIMEOUT_MS));
    const send = async (method: string, params: JsonObject = {}, notification = false): Promise<unknown> => {
      if (closed || !child.stdin.writable) throw new Error("MCP stdio process is not running.");
      const id = this.nextRequestId++;
      const message = { jsonrpc: "2.0", ...(notification ? {} : { id }), method, params };
      const body = Buffer.from(JSON.stringify(message), "utf8");
      child.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
      child.stdin.write(body);
      if (notification) return undefined;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request ${method} timed out.`)); }, timeout);
        pending.set(id, { resolve, reject, timer });
      });
    };
    await send("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "OpenHarness", version: "0.2.0" } });
    await send("notifications/initialized", {}, true);
    const listed = await send("tools/list")
    return { tools: normalizeTools(listed), callTool: async (name, args) => send("tools/call", { name, arguments: args }), disconnect: async () => { closed = true; failPending(new Error("MCP stdio process stopped.")); child.kill(); } };
  }

  private persistConfig(config?: McpServerConfig, removeName?: string): void {
    const configs = this.readSavedConfigs().filter((item) => item.name !== (config?.name ?? removeName));
    if (config) configs.push(config);
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const safePath = resolveInside(this.storeRoot, path.relative(this.storeRoot, this.storePath));
    fs.writeFileSync(safePath, JSON.stringify(configs, null, 2), "utf8");
  }

  private readSavedConfigs(): McpServerConfig[] {
    try {
      const safePath = resolveInside(this.storeRoot, path.relative(this.storeRoot, this.storePath));
      const parsed: unknown = JSON.parse(fs.readFileSync(safePath, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((value): value is McpServerConfig => !!value && typeof value === "object" && typeof (value as JsonObject).name === "string" && typeof (value as JsonObject).transport === "string") : [];
    } catch { return []; }
  }

  private restoreSavedServers(): void {
    for (const config of this.readSavedConfigs()) {
      if ((BUILTIN_SERVER_NAMES as readonly string[]).includes(config.name)) continue;
      if (config.enabled === false) {
        this.servers.set(config.name, { name: config.name, status: "disabled", transport: config.transport, tools: [], config, callTool: async () => { throw new Error("MCP server is disabled."); } });
        continue;
      }
      void this.connectRemote(config).catch(() => { /* Status is retained in the manager without logging secrets. */ });
    }
  }
}

function normalizeTools(value: unknown): McpToolDefinition[] {
  const result = value as { tools?: unknown } | null;
  if (!result || !Array.isArray(result.tools)) throw new Error("MCP tools/list response did not include a tools array.");
  return result.tools.filter((entry): entry is McpToolDefinition => !!entry && typeof entry === "object" && typeof (entry as JsonObject).name === "string").map((entry) => ({
    name: entry.name,
    description: typeof entry.description === "string" ? entry.description : undefined,
    inputSchema: entry.inputSchema && typeof entry.inputSchema === "object" ? entry.inputSchema : objectSchema({}),
    annotations: entry.annotations && typeof entry.annotations === "object" ? entry.annotations : undefined,
  }));
}

function stripHtml(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

function htmlToText(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ").replace(/<!--([\s\S]*?)-->/g, " ").replace(/<\/(?:p|div|section|article|li|h[1-6]|tr|blockquote)\s*>/gi, "\n").replace(/<br\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
