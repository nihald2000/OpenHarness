import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { localLockService } from "../../core/src/infra/index.ts";

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const TRUSTED_PLUGIN_MODULES = new Map([
  ["word-count", "builtin:word-count"], ["builtin:word-count", "builtin:word-count"], ["@openharness/plugin-word-count", "builtin:word-count"],
  ["modal-sandbox", "builtin:modal-sandbox"], ["builtin:modal-sandbox", "builtin:modal-sandbox"],
]);
type PluginRecord = { name: string; module: string; options: Record<string, unknown>; attached: boolean; configured: boolean; attachedAt?: number };
type McpRecord = Record<string, unknown> & { transport: "http" | "sse" | "stdio"; enabled?: boolean; url?: string; command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; headers?: Record<string, string>; readOnly?: boolean; timeoutMs?: number; title?: string };
export type McpServerConfig = McpRecord;

async function load(file: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("stored state must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function save(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
}

const pluginFile = (dataDir: string) => resolve(dataDir, "plugins.json");
const mcpFile = (dataDir: string) => resolve(dataDir, "mcp.json");

export async function listPlugins(dataDir: string) {
  const records = await load(pluginFile(dataDir));
  const wordCount = (records["word-count"] as PluginRecord | undefined) ?? { name: "word-count", module: "builtin:word-count", options: {}, attached: true, configured: false };
  const modal = (records["modal-sandbox"] as PluginRecord | undefined) ?? { name: "modal-sandbox", module: "builtin:modal-sandbox", options: {}, attached: false, configured: false };
  return [{
    name: wordCount.name,
    module: wordCount.module,
    version: "0.1.0",
    status: wordCount.attached ? "attached" : "detached",
    configured: Boolean(wordCount.configured),
    description: "Provides a read-only word, character, and line counting tool.",
    contributions: { tools: wordCount.attached ? 1 : 0 },
    health: { ok: true, detail: "Built-in plugin is healthy." },
  }, {
    name: modal.name,
    module: modal.module,
    version: "0.1.0",
    status: modal.attached ? "attached" : "detached",
    configured: Boolean(modal.configured),
    description: "Runs explicitly approved Python code in isolated Modal sandboxes.",
    contributions: { tools: modal.attached ? 1 : 0 },
    health: { ok: !modal.attached || Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET), detail: modal.attached ? (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET ? "Modal credentials are configured." : "Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET to enable remote execution.") : "Plugin is detached." },
  }];
}

export async function pluginEnabled(dataDir: string, name: string) {
  const records = await load(pluginFile(dataDir));
  const record = records["word-count"] as PluginRecord | undefined;
  if (name === "word_count" || name === "word-count") return record?.attached ?? true;
  if (name === "modal_exec") {
    const modal = records["modal-sandbox"] as PluginRecord | undefined;
    return modal?.attached ?? false;
  }
  return true;
}

export async function resetEphemeralPlugins(dataDir: string) {
  const file = pluginFile(dataDir);
  await localLockService.withLock(file, 30_000, async () => {
    const records = await load(file);
    let changed = false;
    for (const [name, record] of Object.entries(records)) {
      if (record && typeof record === "object" && (record as PluginRecord).configured === false) { delete records[name]; changed = true; }
    }
    if (changed) await save(file, records);
  });
}

export async function attachPlugin(dataDir: string, input: { name: string; module?: string; options?: unknown; persist?: boolean }) {
  if (!NAME.test(input.name)) throw new Error("plugin name must match ^[a-zA-Z0-9-_]+$");
  const trustedModule = TRUSTED_PLUGIN_MODULES.get(input.module ?? input.name);
  if (!trustedModule || !["word-count", "@openharness/plugin-word-count", "modal-sandbox"].includes(input.name)) {
    throw new Error("plugin module is not in the built-in trust allowlist");
  }
  const options = input.options ?? {};
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("plugin options must be a JSON object");
  const optionText = JSON.stringify(options);
  if (Buffer.byteLength(optionText, "utf8") > 64_000 || /\{\s*(?:@?Env|file)\s*:/i.test(optionText)) throw new Error("plugin options are too large or contain forbidden secret interpolation");
  const file = pluginFile(dataDir);
  await localLockService.withLock(file, 30_000, async () => {
    const records = await load(file);
    const name = trustedModule === "builtin:modal-sandbox" ? "modal-sandbox" : "word-count";
    records[name] = { name, module: trustedModule, options: options as Record<string, unknown>, attached: true, configured: Boolean(input.persist), attachedAt: Date.now() } satisfies PluginRecord;
    await save(file, records);
  });
}

export async function detachPlugin(dataDir: string, name: string, persist: boolean) {
  const file = pluginFile(dataDir);
  if (name !== "word-count" && name !== "modal-sandbox") throw new Error("plugin is not installed");
  await localLockService.withLock(file, 30_000, async () => {
    const records = await load(file);
    records[name] = { name, module: name === "word-count" ? "builtin:word-count" : "builtin:modal-sandbox", options: {}, attached: false, configured: persist } satisfies PluginRecord;
    await save(file, records);
  });
}

function validateMcp(name: string, input: unknown): McpRecord {
  if (!NAME.test(name) || name.includes("__")) throw new Error("MCP server name must match ^[a-zA-Z0-9-_]+$ and may not contain '__'");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("MCP server config must be an object");
  const cfg = input as Record<string, unknown>;
  if (!(cfg.transport === "http" || cfg.transport === "sse" || cfg.transport === "stdio")) throw new Error("transport must be http, sse, or stdio");
  const stringMap = (value: unknown, label: string): Record<string, string> | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object of strings`);
    const entries = Object.entries(value);
    if (entries.some(([key, item]) => !key || typeof item !== "string" || /\{\s*(?:@?Env|file)\s*:/i.test(item))) throw new Error(`${label} contains an invalid key or value`);
    return Object.fromEntries(entries);
  };
  const output: McpRecord = { transport: cfg.transport, enabled: cfg.enabled !== false, readOnly: cfg.readOnly === true };
  if (typeof cfg.title === "string") output.title = cfg.title.slice(0, 120);
  if (cfg.timeoutMs !== undefined) {
    if (!Number.isInteger(cfg.timeoutMs) || (cfg.timeoutMs as number) < 100 || (cfg.timeoutMs as number) > 300_000) throw new Error("timeoutMs must be from 100 to 300000");
    output.timeoutMs = cfg.timeoutMs as number;
  }
  if (cfg.transport === "stdio") {
    if (typeof cfg.command !== "string" || !cfg.command.trim()) throw new Error("stdio transport requires a command");
    if (cfg.command.length > 2_000 || /[\r\n\0]/.test(cfg.command)) throw new Error("command is invalid");
    output.command = cfg.command;
    if (Array.isArray(cfg.args)) {
      if (cfg.args.length > 64 || cfg.args.some((arg) => typeof arg !== "string" || arg.length > 2_000 || /[\0]/.test(arg))) throw new Error("args are invalid");
      output.args = cfg.args as string[];
    } else if (cfg.args !== undefined) throw new Error("args must be an array of strings");
    if (typeof cfg.cwd === "string") output.cwd = cfg.cwd.slice(0, 2_000);
    output.env = stringMap(cfg.env, "env");
  } else {
    if (typeof cfg.url !== "string") throw new Error("HTTP transport requires a URL");
    const url = new URL(cfg.url);
    if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password) throw new Error("url must be HTTP(S) and must not embed credentials");
    if ([...url.searchParams.keys()].some((key) => /auth|token|key|secret|password|credential/i.test(key))) throw new Error("sensitive URL query parameters must be stored as headers/secrets");
    output.url = url.toString();
    output.headers = stringMap(cfg.headers, "headers");
  }
  return output;
}

export async function listMcpServers(dataDir: string) {
  const records = await load(mcpFile(dataDir));
  return Object.entries(records).map(([name, raw]) => {
    const cfg = raw as McpRecord;
    return { name, title: cfg.title, transport: cfg.transport, enabled: cfg.enabled !== false, url: cfg.url, headers: maskSecretRefs(cfg.headers), command: cfg.command ? [cfg.command] : undefined, args: cfg.args, cwd: cfg.cwd, env: maskSecretRefs(cfg.env), timeoutMs: cfg.timeoutMs, readOnly: cfg.readOnly, status: cfg.enabled === false ? "disabled" : "failed", tools: [], toolsCount: 0, error: cfg.enabled === false ? undefined : "MCP transport connection is not configured yet." };
  });
}

export async function getMcpConfigs(dataDir: string): Promise<Record<string, McpServerConfig>> {
  const records = await load(mcpFile(dataDir));
  const result: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(records)) result[name] = validateMcp(name, value);
  return result;
}

export function listMcpPresets() {
  return [{
    id: "filesystem",
    name: "Filesystem",
    description: "Access files in one explicitly selected workspace directory. Mutating tools still require approval.",
    transport: "stdio",
    requires: ["Node.js and npm"],
    defaults: { readOnly: false, root: process.env.OPENHARNESS_WORKSPACE ?? process.cwd() },
  }, {
    id: "browser",
    name: "Playwright browser",
    description: "Control a local browser through Microsoft's Playwright MCP server. Browser actions require tool approval.",
    transport: "stdio",
    requires: ["Node.js and npm", "A supported browser"],
    defaults: { readOnly: false },
  }];
}

export async function installMcpPreset(dataDir: string, presetId: string, input: { name?: unknown; root?: unknown }) {
  if (presetId !== "filesystem" && presetId !== "browser") throw new Error("MCP preset not found");
  const name = typeof input.name === "string" && input.name ? input.name : presetId;
  const root = typeof input.root === "string" && input.root ? input.root : (process.env.OPENHARNESS_WORKSPACE ?? process.cwd());
  if (root.length > 2_000 || /[\0\r\n]/.test(root)) throw new Error("workspace root is invalid");
  const packageName = presetId === "filesystem" ? "@modelcontextprotocol/server-filesystem" : "@playwright/mcp@latest";
  const args = presetId === "filesystem" ? ["-y", packageName, root] : ["-y", packageName];
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx", ...args] : args;
  const config = { transport: "stdio", command, args: commandArgs, ...(presetId === "filesystem" ? { cwd: root } : {}), readOnly: false, enabled: true };
  const file = mcpFile(dataDir);
  return await localLockService.withLock(file, 30_000, async () => {
    const records = await load(file);
    if (records[name]) throw new Error(`MCP server ${name} already exists`);
    records[name] = validateMcp(name, config);
    await save(file, records);
    return { name, config };
  });
}

function maskSecretRefs(values: Record<string, string> | undefined) {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, /\{secret:[A-Z][A-Z0-9_]{0,63}\}/.test(value) ? value.replace(/\{secret:[A-Z][A-Z0-9_]{0,63}\}/g, "{secret:stored}") : value]));
}

export async function putMcpServer(dataDir: string, name: string, input: unknown) {
  const validated = validateMcp(name, input);
  const file = mcpFile(dataDir);
  await localLockService.withLock(file, 30_000, async () => {
    const records = await load(file);
    records[name] = validated;
    await save(file, records);
  });
}

export async function setMcpEnabled(dataDir: string, name: string, enabled: boolean) {
  const file = mcpFile(dataDir);
  await localLockService.withLock(file, 30_000, async () => {
    const records = await load(file);
    const current = records[name] as McpRecord | undefined;
    if (!current) throw new Error("MCP server not found");
    current.enabled = enabled;
    records[name] = current;
    await save(file, records);
  });
}

export async function deleteMcpServer(dataDir: string, name: string) {
  const file = mcpFile(dataDir);
  return await localLockService.withLock(file, 30_000, async () => {
    const records = await load(file);
    if (!(name in records)) return false;
    delete records[name];
    await save(file, records);
    return true;
  });
}
