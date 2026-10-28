import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveSecret } from "./config-store.ts";
import { getMcpConfigs, type McpServerConfig } from "./extensions-store.ts";

type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } };
type McpValue = { name: string; description?: string; inputSchema: Record<string, unknown>; readOnly: boolean; server: string };
type RpcPayload = { jsonrpc?: string; id?: number; result?: unknown; error?: { code?: number; message?: string } };

function decodeSecretRefs(value: string, secretValues: Record<string, string>) {
  return value.replace(/\{secret:([A-Z][A-Z0-9_]{0,63})\}/g, (_, key: string) => secretValues[key] ?? "");
}

async function resolvedMap(dataDir: string, values: Record<string, string> | undefined) {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const refs = [...value.matchAll(/\{secret:([A-Z][A-Z0-9_]{0,63})\}/g)].map((match) => match[1]!);
    const secrets: Record<string, string> = {};
    for (const ref of refs) {
      const secret = await resolveSecret(dataDir, ref);
      if (secret === undefined) throw new Error(`required secret ${ref} is not stored`);
      secrets[ref] = secret;
    }
    output[key] = decodeSecretRefs(value, secrets);
  }
  return output;
}

function parseRpc(payload: string): RpcPayload {
  try { return JSON.parse(payload) as RpcPayload; }
  catch { throw new Error("MCP server returned invalid JSON-RPC data"); }
}

function parseEventStream(body: string): RpcPayload {
  const data = body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).find(Boolean);
  if (!data) throw new Error("MCP event stream did not contain a data event");
  return parseRpc(data);
}

function maskSecretRefs(values: Record<string, string> | undefined) {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.replace(/\{secret:[A-Z][A-Z0-9_]{0,63}\}/g, "{secret:stored}")]));
}

class Connection {
  status: "connecting" | "connected" | "failed" | "disabled" = "connecting";
  error?: string;
  tools: McpTool[] = [];
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: RpcPayload): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private stdoutBuffer = "";
  private messageUrl?: string;
  private sessionId?: string;
  private sseController?: AbortController;
  private headers: Record<string, string> = {};

  constructor(
    readonly name: string,
    readonly cfg: McpServerConfig,
    private readonly dataDir: string,
    private readonly onFailure: () => void,
  ) {}

  async connect() {
    this.status = "connecting";
    this.error = undefined;
    try {
      if (this.cfg.enabled === false) { this.status = "disabled"; return; }
      if (this.cfg.transport === "stdio") await this.startStdio();
      else await this.startHttp();
      const initialized = await this.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openharness", version: "0.1.0" } });
      if (!initialized.result) throw new Error("MCP initialize response is missing result");
      await this.notify("notifications/initialized", {});
      const listed = await this.rpc("tools/list", {});
      const result = listed.result as { tools?: unknown } | undefined;
      if (!Array.isArray(result?.tools)) throw new Error("MCP tools/list response is invalid");
      this.tools = result.tools.filter((tool): tool is McpTool => Boolean(tool && typeof tool === "object" && typeof (tool as McpTool).name === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test((tool as McpTool).name)));
      this.status = "connected";
    } catch (error) {
      this.status = "failed";
      this.error = (error as Error).message || "MCP connection failed";
      await this.stopProcess();
      this.onFailure();
    }
  }

  async call(toolName: string, input: Record<string, unknown>, signal?: AbortSignal) {
    if (this.status !== "connected") throw new Error(`MCP server ${this.name} is not connected`);
    const definition = this.tools.find((tool) => tool.name === toolName);
    if (!definition) throw new Error(`MCP tool ${toolName} was not advertised by ${this.name}`);
    validateInput(definition.inputSchema ?? { type: "object" }, input);
    const reply = await this.rpc("tools/call", { name: toolName, arguments: input }, signal);
    if (reply.error) throw new Error(reply.error.message ?? "MCP tool call failed");
    const serialized = JSON.stringify(reply.result ?? null);
    if (serialized.length > 20_000) return { truncated: true, preview: serialized.slice(0, 20_000), originalChars: serialized.length };
    return reply.result;
  }

  async disconnect() {
    this.status = "disabled";
    this.tools = [];
    this.sseController?.abort();
    this.sseController = undefined;
    this.failPending(new Error("MCP server disconnected"));
    await this.stopProcess();
  }

  private async startStdio() {
    if (!this.cfg.command) throw new Error("stdio MCP server has no command");
    const env = await resolvedMap(this.dataDir, this.cfg.env);
    const child = spawn(this.cfg.command, this.cfg.args ?? [], { cwd: this.cfg.cwd || process.cwd(), env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      if (this.stdoutBuffer.length > 1_000_000) { this.failPending(new Error("MCP stdio response exceeded 1 MB")); void this.stopProcess(); return; }
      const lines = this.stdoutBuffer.split(/\r?\n/);
      this.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: RpcPayload;
        try { message = parseRpc(line); } catch { continue; }
        if (typeof message.id !== "number") continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.resolve(message);
      }
    });
    child.stderr.on("data", () => { /* MCP stderr is intentionally not forwarded or logged. */ });
    child.on("error", (error) => this.failPending(new Error(`Could not start MCP server: ${error.message}`)));
    child.on("exit", (code) => {
      if (this.status === "connected") this.status = "failed";
      this.failPending(new Error(`MCP stdio server exited (${code ?? "signal"})`));
      this.onFailure();
    });
  }

  private async startHttp() {
    if (!this.cfg.url) throw new Error("MCP HTTP server has no URL");
    this.headers = await resolvedMap(this.dataDir, this.cfg.headers);
    this.messageUrl = this.cfg.url;
    if (this.cfg.transport === "sse") await this.discoverSseEndpoint();
  }

  private async discoverSseEndpoint() {
    const controller = new AbortController();
    this.sseController = controller;
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 10_000);
    const response = await fetch(this.cfg.url!, { headers: { ...this.headers, accept: "text/event-stream" }, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`MCP SSE endpoint returned HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!;
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:") && eventName === "endpoint") {
            this.messageUrl = new URL(line.slice(5).trim(), this.cfg.url).toString();
            const remainder = [...lines.slice(index + 1), buffer].filter(Boolean).join("\n");
            clearTimeout(timeout);
            void this.consumeSse(reader, decoder, remainder);
            return;
          } else if (!line) eventName = "message";
        }
        if (done) break;
      }
    } catch (error) { clearTimeout(timeout); controller.abort(); throw error; }
    finally { if (!this.messageUrl) reader.releaseLock(); }
    clearTimeout(timeout);
    throw new Error("MCP SSE endpoint did not publish a message endpoint");
  }

  private async consumeSse(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder, initial: string) {
    let buffer = initial;
    let data: string[] = [];
    try {
      while (true) {
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          else if (!line) {
            if (data.length) {
              const message = parseRpc(data.join("\n"));
              if (typeof message.id === "number") {
                const pending = this.pending.get(message.id);
                if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); pending.resolve(message); }
              }
              data = [];
            }
          }
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      if (this.status === "connected") this.status = "failed";
      this.failPending(new Error("MCP SSE connection closed"));
      this.onFailure();
    } catch (error) {
      if (this.status === "connected") this.status = "failed";
      this.failPending(error as Error);
      this.onFailure();
    } finally { reader.releaseLock(); }
  }

  private async rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<RpcPayload> {
    const requestId = this.nextId++;
    const request = { jsonrpc: "2.0", id: requestId, method, params };
    if (this.cfg.transport === "stdio") {
      if (!this.child || !this.child.stdin.writable) throw new Error("MCP stdio process is unavailable");
      if (signal?.aborted) throw new DOMException("The MCP call was cancelled.", "AbortError");
      const timeoutMs = this.cfg.timeoutMs ?? 30_000;
      return await new Promise<RpcPayload>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(requestId); };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`MCP ${method} timed out`)); }, timeoutMs);
        const abort = () => { cleanup(); reject(new DOMException("The MCP call was cancelled.", "AbortError")); };
        const wrappedResolve = (value: RpcPayload) => { cleanup(); resolve(value); };
        const wrappedReject = (error: Error) => { cleanup(); reject(error); };
        this.pending.set(requestId, { resolve: wrappedResolve, reject: wrappedReject, timer });
        signal?.addEventListener("abort", abort, { once: true });
        this.child!.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (error) { cleanup(); reject(new Error("Could not write to MCP stdio process")); }
        });
      });
    }
    if (this.cfg.transport === "sse") {
      if (signal?.aborted) throw new DOMException("The MCP call was cancelled.", "AbortError");
      return await new Promise<RpcPayload>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); this.pending.delete(requestId); };
        const timeout = setTimeout(() => { cleanup(); reject(new Error(`MCP ${method} timed out`)); }, this.cfg.timeoutMs ?? 30_000);
        const abort = () => { cleanup(); reject(new DOMException("The MCP call was cancelled.", "AbortError")); };
        const wrappedResolve = (value: RpcPayload) => { cleanup(); resolve(value); };
        const wrappedReject = (error: Error) => { cleanup(); reject(error); };
        this.pending.set(requestId, { resolve: wrappedResolve, reject: wrappedReject, timer: timeout });
        signal?.addEventListener("abort", abort, { once: true });
        void fetch(this.messageUrl ?? this.cfg.url!, { method: "POST", headers: { ...this.headers, "content-type": "application/json" }, body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000)]) : AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000) })
          .then(async (response) => {
            if (!response.ok) throw new Error(`MCP ${method} returned HTTP ${response.status}`);
            await response.body?.cancel();
          })
          .catch((error) => {
            const pending = this.pending.get(requestId);
            if (pending) { cleanup(); reject(error as Error); }
          });
      });
    }
    const response = await fetch(this.messageUrl ?? this.cfg.url!, {
      method: "POST",
      headers: { ...this.headers, accept: "application/json, text/event-stream", "content-type": "application/json", ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}) },
      body: JSON.stringify(request),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000)]) : AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    });
    if (!response.ok) throw new Error(`MCP ${method} returned HTTP ${response.status}`);
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const body = await response.text();
    const payload = response.headers.get("content-type")?.includes("text/event-stream") ? parseEventStream(body) : parseRpc(body);
    if (payload.error) throw new Error(payload.error.message ?? `MCP ${method} failed`);
    return payload;
  }

  private async notify(method: string, params: Record<string, unknown>) {
    const notification = { jsonrpc: "2.0", method, params };
    if (this.cfg.transport === "stdio") {
      this.child?.stdin.write(`${JSON.stringify(notification)}\n`);
      return;
    }
    const response = await fetch(this.messageUrl ?? this.cfg.url!, { method: "POST", headers: { ...this.headers, "content-type": "application/json", ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}) }, body: JSON.stringify(notification), signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000) });
    if (!response.ok) throw new Error(`MCP notification returned HTTP ${response.status}`);
    await response.body?.cancel();
  }

  private failPending(error: Error) {
    for (const [, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  private async stopProcess() {
    if (!this.child) return;
    const child = this.child;
    this.child = undefined;
    this.failPending(new Error("MCP server disconnected"));
    child.kill();
  }
}
export class McpClientManager {
  private readonly connections = new Map<string, Connection>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reconnectAttempts = new Map<string, number>();
  private shuttingDown = false;
  constructor(private readonly dataDir: string) {}

  async start() {
    const configs = await getMcpConfigs(this.dataDir);
    await Promise.all(Object.entries(configs).map(([name, config]) => this.connect(name, config)));
  }

  async connect(name: string, override?: McpServerConfig) {
    const timer = this.reconnectTimers.get(name);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(name);
    const config = override ?? (await getMcpConfigs(this.dataDir))[name];
    if (!config) throw new Error("MCP server not found");
    const old = this.connections.get(name);
    if (old) await old.disconnect();
    let connection!: Connection;
    connection = new Connection(name, config, this.dataDir, () => {
      if (connection.status === "failed" && this.connections.get(name) === connection) this.scheduleReconnect(name);
    });
    this.connections.set(name, connection);
    await connection.connect();
    if (connection.status === "connected") this.reconnectAttempts.delete(name);
    return connection;
  }

  private scheduleReconnect(name: string) {
    if (this.shuttingDown || this.reconnectTimers.has(name)) return;
    void getMcpConfigs(this.dataDir).then((configs) => {
      if (this.shuttingDown || configs[name]?.enabled === false || !configs[name]) return;
      const attempt = (this.reconnectAttempts.get(name) ?? 0) + 1;
      this.reconnectAttempts.set(name, attempt);
      const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempt - 1, 6));
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(name);
        if (this.shuttingDown) return;
        void this.connect(name).then((connection) => {
          if (connection.status === "failed") console.warn(`OpenHarness will retry MCP server ${name} after a connection failure.`);
        }).catch(() => this.scheduleReconnect(name));
      }, delay);
      timer.unref?.();
      this.reconnectTimers.set(name, timer);
    }).catch(() => undefined);
  }

  async disconnect(name: string) {
    const timer = this.reconnectTimers.get(name);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(name);
    this.reconnectAttempts.delete(name);
    const connection = this.connections.get(name);
    if (connection) await connection.disconnect();
    this.connections.delete(name);
  }

  async list() {
    const configs = await getMcpConfigs(this.dataDir);
    return Object.entries(configs).map(([name, config]) => {
      const connection = this.connections.get(name);
      const tools = connection?.tools ?? [];
      return { name, title: config.title, transport: config.transport, enabled: config.enabled !== false, url: config.url, headers: maskSecretRefs(config.headers), command: config.command ? [config.command] : undefined, args: config.args, cwd: config.cwd, env: maskSecretRefs(config.env), timeoutMs: config.timeoutMs, readOnly: config.readOnly, status: config.enabled === false ? "disabled" : connection?.status ?? "connecting", tools: tools.map((tool) => tool.name), toolsCount: tools.length, error: connection?.error };
    });
  }

  async listTools(): Promise<McpValue[]> {
    const rows: McpValue[] = [];
    for (const [server, connection] of this.connections) {
      if (connection.status !== "connected") continue;
      for (const tool of connection.tools) rows.push({ name: `${server}__${tool.name}`, description: tool.description, inputSchema: tool.inputSchema ?? { type: "object" }, readOnly: connection.cfg.readOnly === true, server });
    }
    return rows;
  }

  async getTool(name: string) { return (await this.listTools()).find((tool) => tool.name === name); }

  async call(name: string, input: Record<string, unknown>, signal?: AbortSignal) {
    const separator = name.indexOf("__");
    if (separator < 1) throw new Error("invalid MCP tool name");
    const server = name.slice(0, separator);
    const toolName = name.slice(separator + 2);
    const connection = this.connections.get(server);
    if (!connection) throw new Error(`MCP server ${server} is not connected`);
    return await connection.call(toolName, input, signal);
  }

  async setEnabled(name: string, enabled: boolean) {
    const configs = await getMcpConfigs(this.dataDir);
    const config = configs[name];
    if (!config) throw new Error("MCP server not found");
    if (enabled) await this.connect(name, { ...config, enabled: true });
    else await this.disconnect(name);
  }

  async remove(name: string) { await this.disconnect(name); }

  async shutdown() {
    this.shuttingDown = true;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    await Promise.all([...this.connections.values()].map((connection) => connection.disconnect()));
    this.connections.clear();
  }
}

function validateInput(schema: Record<string, unknown>, input: unknown, field = "input") {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${field} must be a JSON object`);
  const object = input as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  for (const key of required) if (!(key in object)) throw new Error(`${field}.${key} is required`);
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties as Record<string, Record<string, unknown>> : {};
  if (schema.additionalProperties === false) for (const key of Object.keys(object)) if (!(key in properties)) throw new Error(`${field}.${key} is not allowed`);
  for (const [key, value] of Object.entries(object)) {
    const property = properties[key];
    if (!property) continue;
    const expected = property.type;
    if (expected === "string" && typeof value !== "string") throw new Error(`${field}.${key} must be a string`);
    if (expected === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${field}.${key} must be a finite number`);
    if (expected === "integer" && (typeof value !== "number" || !Number.isInteger(value))) throw new Error(`${field}.${key} must be an integer`);
    if (expected === "boolean" && typeof value !== "boolean") throw new Error(`${field}.${key} must be a boolean`);
    if (expected === "object") validateInput(property, value, `${field}.${key}`);
    if (expected === "array" && !Array.isArray(value)) throw new Error(`${field}.${key} must be an array`);
    if (Array.isArray(property.enum) && !property.enum.includes(value)) throw new Error(`${field}.${key} is not an allowed value`);
  }
}
