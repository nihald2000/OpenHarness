import { spawn } from "node:child_process";
import { realpath, stat, writeFile, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type ToolInput = Record<string, unknown>;
export type ToolDefinition = {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  execute(input: ToolInput, workspace: string, signal?: AbortSignal): Promise<unknown>;
};

async function captureProcess(executable: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 15_000) {
  if (signal?.aborted) throw new DOMException("The run was cancelled.", "AbortError");
  const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
  let stdout = ""; let stderr = ""; let truncated = false; let timedOut = false;
  const append = (current: string, chunk: Buffer) => {
    const value = current + chunk.toString("utf8");
    if (value.length > 20_000) truncated = true;
    return value.slice(0, 20_000);
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const abort = () => child.kill(); signal?.addEventListener("abort", abort, { once: true });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject); child.once("close", resolveExit);
  }).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", abort); });
  if (signal?.aborted) throw new DOMException("The run was cancelled.", "AbortError");
  if (timedOut) throw new Error("process exceeded its execution time limit");
  return { exitCode, stdout, stderr, truncated };
}

const stringArg = (input: ToolInput, key: string, maxLength = 100_000): string => {
  const value = input[key];
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${key} must be a string of at most ${maxLength} characters`);
  return value;
};

const MODAL_RUNNER = String.raw`
import contextlib, json, sys
try:
    import modal
except Exception:
    print(json.dumps({"error": "Modal Python SDK is unavailable in the configured Python environment."}))
    raise SystemExit(0)

request = json.load(sys.stdin)
sandbox = None
try:
    app = modal.App.lookup(request.get("app") or "openharness", create_if_missing=True)
    image = modal.Image.from_registry("python:3.13-slim")
    sandbox = modal.Sandbox.create(app=app, image=image, timeout=request["timeoutSeconds"] + 30, block_network=True)
    wrapper = r'''import contextlib, io, json, sys
class Limited(io.StringIO):
    def __init__(self):
        super().__init__()
        self.total = 0
    def write(self, value):
        self.total += len(value)
        remaining = max(0, 20001 - super().tell())
        if remaining:
            super().write(value[:remaining])
        return len(value)
stdout, stderr = Limited(), Limited()
try:
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        exec(compile(sys.stdin.read(), "<openharness-modal>", "exec"), {"__name__": "__main__"})
    exit_code = 0
except BaseException as error:
    stderr.write(type(error).__name__ + ": " + str(error) + "\n")
    exit_code = 1
print(json.dumps({"exitCode": exit_code, "stdout": stdout.getvalue()[:20000], "stderr": stderr.getvalue()[:20000], "truncated": stdout.total > 20000 or stderr.total > 20000}))'''
    process = sandbox.exec("python", "-c", wrapper, timeout=request["timeoutSeconds"])
    process.stdin.write(request["code"].encode())
    process.stdin.write_eof()
    process.stdin.drain()
    process.wait()
    output = process.stdout.read(25000)
    print(output[:25000])
except Exception:
    print(json.dumps({"error": "Modal sandbox execution failed. Check Modal credentials, app access, and server logs."}))
finally:
    if sandbox is not None:
        try:
            sandbox.terminate()
        except Exception:
            pass
`;

async function executeModal(input: ToolInput, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("The run was cancelled.", "AbortError");
  if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) throw new Error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required for the Modal sandbox plugin");
  const code = stringArg(input, "code", 50_000);
  if (!code.trim()) throw new Error("code must not be empty");
  const language = input.language ?? "python";
  if (language !== "python") throw new Error("Modal sandbox currently supports Python only");
  const timeoutSeconds = input.timeoutSeconds ?? 30;
  if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) throw new Error("timeoutSeconds must be an integer from 1 to 120");
  const app = input.app ?? process.env.MODAL_APP_NAME ?? "openharness";
  if (typeof app !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(app)) throw new Error("app must be a simple Modal app name");

  const python = process.env.OPENHARNESS_MODAL_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const child = spawn(python, ["-u", "-c", MODAL_RUNNER], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
  const maxBytes = 64_000;
  let stdout = "";
  const append = (current: string, chunk: Buffer) => current.length >= maxBytes ? current : current + chunk.toString("utf8").slice(0, maxBytes - current.length);
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", () => undefined);
  child.stdin.on("error", () => undefined);
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, (timeoutSeconds + 90) * 1_000);
  const result = await new Promise<{ code: number | null; error?: Error }>((resolveClose) => {
    child.once("error", (error) => resolveClose({ code: null, error }));
    child.once("close", (code) => resolveClose({ code }));
    child.stdin.end(JSON.stringify({ app, code, timeoutSeconds }));
  }).finally(() => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); });
  if (signal?.aborted) throw new DOMException("The run was cancelled.", "AbortError");
  if (timedOut) throw new Error("Modal sandbox runner exceeded its time limit");
  if (result.error) throw new Error(`Could not start Modal's Python runner: ${result.error.message}`);
  if (result.code !== 0) throw new Error(`Modal sandbox runner exited with code ${result.code ?? "unknown"}`);
  let parsed: { error?: string; exitCode?: number; stdout?: string; stderr?: string; truncated?: boolean };
  try { parsed = JSON.parse(stdout.trim()) as typeof parsed; }
  catch { throw new Error("Modal sandbox runner returned invalid output"); }
  if (parsed.error) throw new Error(parsed.error);
  return { exitCode: parsed.exitCode, stdout: parsed.stdout ?? "", stderr: parsed.stderr ?? "", truncated: parsed.truncated === true };
}

async function executeVerification(input: ToolInput, workspace: string, signal?: AbortSignal) {
  const command = input.command;
  const commands: Record<string, { executable: string; args: string[] }> = {
    typecheck: { executable: "bun", args: ["run", "typecheck"] },
    "server-build": { executable: "bun", args: ["run", "build:server"] },
    "web-build": { executable: "bun", args: ["run", "build"] },
    "diff-check": { executable: "git", args: ["diff", "--check"] },
  };
  if (typeof command !== "string" || !(command in commands)) throw new Error("command must be typecheck, server-build, web-build, or diff-check");
  const timeoutSeconds = input.timeoutSeconds ?? 120;
  if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error("timeoutSeconds must be an integer from 1 to 300");
  if (signal?.aborted) throw new DOMException("The run was cancelled.", "AbortError");
  const spec = commands[command]!;
  const envNames = ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];
  const env = Object.fromEntries(envNames.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  const child = spawn(spec.executable, spec.args, { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const append = (current: string, chunk: Buffer) => {
    if (current.length >= 20_000) { truncated = true; return current; }
    const value = current + chunk.toString("utf8");
    if (value.length > 20_000) truncated = true;
    return value.slice(0, 20_000);
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutSeconds * 1_000);
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  const result = await new Promise<{ code: number | null; error?: Error }>((resolveClose) => {
    child.once("error", (error) => resolveClose({ code: null, error }));
    child.once("close", (code) => resolveClose({ code }));
  }).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", abort); });
  if (signal?.aborted) throw new DOMException("The run was cancelled.", "AbortError");
  if (result.error) throw new Error(`Could not start verification command ${command}: ${result.error.message}`);
  return { command, exitCode: result.code, passed: !timedOut && result.code === 0, timedOut, stdout, stderr, truncated };
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && path !== ".." && !isAbsolute(path));
}

async function safeExistingFile(workspace: string, inputPath: string): Promise<string> {
  const root = await realpath(workspace);
  const candidate = resolve(root, inputPath);
  if (!within(root, candidate)) throw new Error("path must stay inside the workspace");
  const file = await realpath(candidate);
  if (!within(root, file)) throw new Error("path must stay inside the workspace");
  return file;
}

async function safeNewFile(workspace: string, inputPath: string): Promise<string> {
  const root = await realpath(workspace);
  const candidate = resolve(root, inputPath);
  if (!within(root, candidate)) throw new Error("path must stay inside the workspace");
  const parent = await realpath(dirname(candidate));
  if (!within(root, parent)) throw new Error("path must stay inside the workspace");
  const target = resolve(parent, candidate.slice(dirname(candidate).length + 1));
  try {
    const existing = await realpath(target);
    if (!within(root, existing)) throw new Error("path must stay inside the workspace");
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return target;
  }
}

export const TOOL_REGISTRY: readonly ToolDefinition[] = [
  {
    name: "word_count",
    description: "Count words, characters, and lines in text.",
    readOnly: true,
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    async execute(input) {
      const value = stringArg(input, "text");
      return {
        words: value.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length ?? 0,
        characters: Array.from(value).length,
        lines: value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length,
      };
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from inside the workspace (maximum 100 KB).",
    readOnly: true,
    inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    async execute(input, workspace) {
      const file = await safeExistingFile(workspace, stringArg(input, "path", 2_000));
      const details = await stat(file);
      if (!details.isFile()) throw new Error("path is not a regular file");
      if (details.size > 100_000) throw new Error("file exceeds the 100 KB read limit");
      return { path: relative(await realpath(workspace), file), content: await readFile(file, "utf8") };
    },
  },
  {
    name: "search",
    description: "Search text in workspace files with ripgrep. Results and duration are bounded.",
    readOnly: true,
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, path: { type: "string" }, maxResults: { type: "integer" } } },
    async execute(input, workspace, signal) {
      const query = stringArg(input, "query", 2_000);
      if (!query) throw new Error("query must not be empty");
      const root = await realpath(workspace);
      const target = input.path === undefined ? root : await safeExistingFile(workspace, stringArg(input, "path", 2_000));
      const maxResults = input.maxResults ?? 100;
      if (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) throw new Error("maxResults must be an integer from 1 to 500");
      const executable = process.platform === "win32" ? "rg.exe" : "rg";
      const result = await captureProcess(executable, ["--line-number", "--no-heading", "--color", "never", "--max-count", String(maxResults), "--", query, target], root, signal, 15_000);
      return { ...result, matches: result.stdout.split(/\r?\n/).filter(Boolean).slice(0, maxResults) };
    },
  },
  {
    name: "shell",
    description: "Run an allowlisted executable directly in the workspace. No shell expansion is used; requires approval.",
    readOnly: false,
    inputSchema: { type: "object", required: ["command", "args"], properties: { command: { type: "string", enum: ["git", "bun", "node", "python", "python3", "rg"] }, args: { type: "array", items: { type: "string" } }, timeoutSeconds: { type: "integer" } } },
    async execute(input, workspace, signal) {
      const command = stringArg(input, "command", 20);
      if (!["git", "bun", "node", "python", "python3", "rg"].includes(command)) throw new Error("command is not in the shell allowlist");
      if (!Array.isArray(input.args) || input.args.length > 100 || input.args.some((arg) => typeof arg !== "string" || arg.length > 4_000)) throw new Error("args must be an array of at most 100 strings");
      const timeoutSeconds = input.timeoutSeconds ?? 30;
      if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) throw new Error("timeoutSeconds must be from 1 to 120");
      const root = await realpath(workspace);
      return await captureProcess(command, input.args as string[], root, signal, timeoutSeconds * 1_000);
    },
  },
  {
    name: "write_file",
    description: "Write UTF-8 text to a file inside the workspace. Requires approval for each path.",
    readOnly: false,
    inputSchema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
    async execute(input, workspace) {
      const filePath = stringArg(input, "path", 2_000);
      if (!filePath || isAbsolute(filePath)) throw new Error("path must be a non-empty workspace-relative path");
      const content = stringArg(input, "content", 1_000_000);
      const file = await safeNewFile(workspace, filePath);
      await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
      return { path: relative(await realpath(workspace), file), bytesWritten: Buffer.byteLength(content, "utf8") };
    },
  },
  {
    name: "modal_exec",
    description: "Run approved Python code in a temporary isolated Modal sandbox. Requires the Modal sandbox plugin and credentials.",
    readOnly: false,
    inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" }, language: { type: "string", enum: ["python"] }, app: { type: "string" }, timeoutSeconds: { type: "integer" } } },
    async execute(input, _workspace, signal) { return await executeModal(input, signal); },
  },
  {
    name: "delegate",
    description: "Ask an isolated read-only subagent for analysis. It cannot call tools or modify files.",
    readOnly: true,
    inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" } } },
    async execute() { throw new Error("Subagents are executed by the OpenHarness agent runner."); },
  },
  {
    name: "verify",
    description: "Run one fixed repository verification check. Requires approval because checks may execute project scripts.",
    readOnly: false,
    inputSchema: { type: "object", required: ["command"], properties: { command: { type: "string", enum: ["typecheck", "server-build", "web-build", "diff-check"] }, timeoutSeconds: { type: "integer" } } },
    async execute(input, workspace, signal) { return await executeVerification(input, workspace, signal); },
  },
  {
    name: "update_plan",
    description: "Publish an ordered implementation plan with every step pending. Used in read-only plan mode.",
    readOnly: true,
    inputSchema: {
      type: "object", required: ["title", "steps"],
      properties: {
        title: { type: "string" }, explanation: { type: "string" },
        steps: { type: "array", items: { type: "object", required: ["title"], properties: { title: { type: "string" }, detail: { type: "string" } } } },
      },
    },
    async execute(input) {
      const title = stringArg(input, "title", 300);
      const steps = input.steps;
      if (!Array.isArray(steps) || steps.length === 0 || steps.length > 30) throw new Error("steps must contain from 1 to 30 plan items");
      return {
        title,
        explanation: typeof input.explanation === "string" ? input.explanation.slice(0, 4_000) : undefined,
        steps: steps.map((step, index) => {
          if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`steps[${index}] must be an object`);
          const row = step as Record<string, unknown>;
          if (typeof row.title !== "string" || !row.title.trim() || row.title.length > 500) throw new Error(`steps[${index}].title must be a non-empty string`);
          return { id: String(index + 1), title: row.title.trim(), status: "pending" as const, ...(typeof row.detail === "string" ? { detail: row.detail.slice(0, 2_000) } : {}) };
        }),
      };
    },
  },
];

export function getTool(name: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.find((tool) => tool.name === name);
}

export function listTools() {
  return TOOL_REGISTRY.map(({ name, description, readOnly }) => ({ name, description, readOnly, source: "builtin" }));
}

export async function executeTool(name: string, input: unknown, workspace: string, signal?: AbortSignal): Promise<{ tool: ToolDefinition; output: unknown }> {
  const tool = getTool(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("tool input must be a JSON object");
  const value = input as ToolInput;
  for (const key of Object.keys(value)) {
    if (!(key in ((tool.inputSchema.properties as Record<string, unknown>) ?? {}))) throw new Error(`unexpected tool input: ${key}`);
  }
  for (const key of (tool.inputSchema.required as string[] | undefined) ?? []) {
    if (!(key in value)) throw new Error(`missing required tool input: ${key}`);
  }
  return { tool, output: await tool.execute(value, workspace, signal) };
}
