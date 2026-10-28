#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = (process.env.OPENHARNESS_URL ?? "http://127.0.0.1:4096").replace(/\/$/, "");
const workspaceRoot = resolve(import.meta.dir, "../../../");
const serverToken = process.env.OPENHARNESS_SERVER_TOKEN;
const adminToken = process.env.OPENHARNESS_ADMIN_TOKEN;
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const positional = args.filter((arg) => arg !== "--json");

async function api<T>(path: string, init: RequestInit = {}, admin = false): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (serverToken) headers.set("authorization", `Bearer ${serverToken}`);
  if (admin && adminToken) headers.set("x-openharness-admin", adminToken);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function print(value: unknown) {
  if (jsonOutput) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

type PromptRunResult = { sessionId: string; status: string; error?: string; text: string; toolsCalled: string[]; toolsSucceeded: string[]; pendingApprovals: string[] };

async function runPrompt(prompt: string): Promise<PromptRunResult> {
  const session = await api<{ id: string }>("/v1/sessions", { method: "POST", body: JSON.stringify({}) });
  await api(`/v1/sessions/${encodeURIComponent(session.id)}/prompt`, { method: "POST", body: JSON.stringify({ text: prompt }) });
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const state = await api<{ status: string; error?: string }>(`/v1/sessions/${encodeURIComponent(session.id)}`);
    if (["completed", "failed", "cancelled"].includes(state.status)) {
      const result = await api<{ messages: Array<{ info: { role: string; error?: string }; parts: Array<{ type: string; text?: string; tool?: string; state?: string }> }> }>(`/v1/sessions/${encodeURIComponent(session.id)}/messages`);
      const answer = result.messages.filter((message) => message.info.role === "assistant").at(-1);
      const toolParts = result.messages.flatMap((message) => message.parts.filter((part) => part.type === "tool" && part.tool).map((part) => ({ name: part.tool!, state: part.state ?? "unknown" })));
      return { sessionId: session.id, status: state.status, error: state.error ?? answer?.info.error, text: answer?.parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "", toolsCalled: toolParts.map((part) => part.name), toolsSucceeded: toolParts.filter((part) => part.state === "completed").map((part) => part.name), pendingApprovals: [] as string[] };
    }
    if (state.status === "awaiting_permission") {
      const requests = await api<Array<{ permission: string; title?: string }>>(`/v1/permissions?sessionId=${encodeURIComponent(session.id)}`);
      return { sessionId: session.id, status: state.status, error: "Approve or reject the tool request in the web UI.", text: "", toolsCalled: [], toolsSucceeded: [], pendingApprovals: requests.map((request) => request.permission) };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  await api(`/v1/sessions/${encodeURIComponent(session.id)}/abort`, { method: "POST" }).catch(() => undefined);
  return { sessionId: session.id, status: "timeout", error: "Run exceeded 120 seconds.", text: "", toolsCalled: [], toolsSucceeded: [], pendingApprovals: [] };
}

async function runEval(file: string, outputFile?: string) {
  const source = await readFile(resolve(workspaceRoot, file), "utf8");
  const cases = parseEvalSuite(source) as Array<{ id?: string; prompt: string; contains?: string; regex?: string; tool?: string; toolsCalled?: string[]; toolsNotCalled?: string[]; toolsSucceeded?: string[]; approvalPending?: boolean; maxMs?: number }>;
  const results = [];
  for (const [index, testCase] of cases.entries()) {
    if (typeof testCase.prompt !== "string") throw new Error(`case ${index + 1} is missing prompt`);
    const started = Date.now();
    let run: Awaited<ReturnType<typeof runPrompt>>;
    try { run = await runPrompt(testCase.prompt); }
    catch (error) { results.push({ id: testCase.id ?? String(index + 1), passed: false, error: (error as Error).message, latencyMs: Date.now() - started }); continue; }
    const checks: Record<string, boolean> = {};
    if (testCase.contains !== undefined) checks.contains = (run.text ?? "").includes(testCase.contains);
    if (testCase.regex !== undefined) checks.regex = new RegExp(testCase.regex, "i").test(run.text ?? "");
    if (testCase.tool !== undefined) checks.tool = run.toolsCalled.includes(testCase.tool);
    if (testCase.toolsCalled !== undefined) checks.toolsCalled = testCase.toolsCalled.every((tool) => (run.toolsCalled as string[]).includes(tool));
    if (testCase.toolsNotCalled !== undefined) checks.toolsNotCalled = testCase.toolsNotCalled.every((tool) => !(run.toolsCalled as string[]).includes(tool));
    if (testCase.toolsSucceeded !== undefined) checks.toolsSucceeded = testCase.toolsSucceeded.every((tool) => (run.toolsSucceeded as string[]).includes(tool));
    if (testCase.approvalPending !== undefined) checks.approvalPending = (run.pendingApprovals.length > 0) === testCase.approvalPending;
    checks.completed = run.status === "completed";
    if (testCase.maxMs !== undefined) checks.latency = Date.now() - started <= testCase.maxMs;
    results.push({ id: testCase.id ?? String(index + 1), passed: Object.values(checks).every(Boolean), checks, status: run.status, sessionId: run.sessionId, latencyMs: Date.now() - started, output: run.text, error: run.error });
  }
  const report = { total: results.length, passed: results.filter((result) => result.passed).length, failed: results.filter((result) => !result.passed).length, results };
  if (outputFile) await writeFile(resolve(workspaceRoot, outputFile), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  print(report);
  if (report.failed > 0) process.exitCode = 1;
}

async function streamEvents(sessionId?: string) {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const headers = new Headers();
  if (serverToken) headers.set("authorization", `Bearer ${serverToken}`);
  const response = await fetch(`${baseUrl}/v1/events${query}`, { headers });
  if (!response.ok || !response.body) throw new Error(`Could not subscribe to events (HTTP ${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      process.stdout.write(decoder.decode(value, { stream: true }));
    }
  } finally { reader.releaseLock(); }
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  return value.trimEnd();
}

function yamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith('"')) {
    try { return JSON.parse(trimmed); } catch { throw new Error(`unsupported YAML scalar: ${trimmed.slice(0, 80)}`); }
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) throw new Error("unterminated YAML single-quoted string");
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

export function parseEvalSuite(source: string) {
  const lines = source.split(/\r?\n/).map((raw, index) => ({ raw, line: index + 1 }));
  const nonEmpty = lines.filter(({ raw }) => raw.trim() && !raw.trimStart().startsWith("#"));
  if (!nonEmpty.length) throw new Error("suite is empty");
  try {
    const json = nonEmpty.map(({ raw }) => JSON.parse(raw));
    if (Array.isArray(json[0])) return json[0] as Array<Record<string, unknown>>;
    if (json.length === 1 && json[0] && typeof json[0] === "object" && Array.isArray((json[0] as { cases?: unknown }).cases)) return (json[0] as { cases: Array<Record<string, unknown>> }).cases;
    return json as Array<Record<string, unknown>>;
  } catch { /* Try the supported YAML subset below. */ }

  const cases: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | undefined;
  let caseIndent = -1;
  let listKey: string | undefined;
  for (const entry of lines) {
    const raw = entry.raw;
    if (!raw.trim() || raw.trimStart().startsWith("#") || raw.trim() === "---" || raw.trim() === "..." || raw.trim() === "cases:") continue;
    const dash = /^(\s*)-\s*(.*)$/.exec(raw);
    if (dash) {
      const indent = dash[1]!.length;
      if (current && indent > caseIndent && listKey && Array.isArray(current[listKey])) {
        (current[listKey] as unknown[]).push(yamlScalar(dash[2]!));
        continue;
      }
      if (current && indent > caseIndent) throw new Error(`unsupported nested YAML value at line ${entry.line}`);
      if (current) cases.push(current);
      current = {};
      caseIndent = indent;
      listKey = undefined;
      if (dash[2]!.trim()) {
        const field = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(dash[2]!);
        if (!field) throw new Error(`expected a case field at line ${entry.line}`);
        current[field[1]!] = field[2]!.trim() ? yamlScalar(field[2]!) : [];
        if (!field[2]!.trim()) listKey = field[1]!;
      }
      continue;
    }
    const field = /^(\s*)([A-Za-z][A-Za-z0-9_]*):(?:\s*(.*))?$/.exec(raw);
    if (!field || !current || field[1]!.length !== caseIndent + 2) throw new Error(`unsupported YAML syntax at line ${entry.line}`);
    const key = field[2]!;
    if (["__proto__", "constructor", "prototype"].includes(key) || key in current) throw new Error(`unsafe or duplicate YAML field at line ${entry.line}`);
    const value = field[3] ?? "";
    current[key] = value.trim() ? yamlScalar(value) : [];
    listKey = value.trim() ? undefined : key;
  }
  if (current) cases.push(current);
  if (cases.length === 0) throw new Error("YAML suite must contain a list of case mappings");
  return cases;
}

const help = `OpenHarness CLI

Usage: bun run oh <command> [args] [--json]

Commands:
  server                    Start the local server
  migrate                   Apply distributed Postgres schema migrations
  info                      Show server information
  sessions                  List sessions
  tools                     List available tools
  agents                    List agents
  skills                    List skills
  commands                  List slash commands
  events [sessionId]        Stream events
  plugins [list|attach|detach] Manage allowlisted plugins
  mcp [list|presets|install|set|delete|enable|disable|reconnect] Manage MCP servers
  run <prompt>              Run a prompt and print the result
  eval <suite.jsonl|yaml> [out]  Run prompt assertions
  config [set section json] Show or update settings (admin token required)
  secrets [list|set|delete] Manage encrypted secrets (admin token required)
  admin token               Generate a random admin token
  help                      Show this help

Environment: OPENHARNESS_URL, OPENHARNESS_SERVER_TOKEN, OPENHARNESS_ADMIN_TOKEN, OPENHARNESS_DATABASE_URL.`;

async function main() {
  const command = positional[0] ?? "help";
  switch (command) {
    case "help": case "--help": case "-h": console.log(help); return;
    case "server": await import("./main.ts"); return;
    case "migrate": {
      const databaseUrl = process.env.OPENHARNESS_DATABASE_URL;
      if (!databaseUrl) throw new Error("OPENHARNESS_DATABASE_URL is required for migrations");
      const { migratePostgresUrl } = await import("../../core/src/infra/postgres-migrations.ts");
      const result = await migratePostgresUrl(databaseUrl, resolve(workspaceRoot, "packages/core/migrations"));
      print({ migrated: result.applied });
      return;
    }
    case "info": print(await api("/v1/info")); return;
    case "sessions": print(await api("/v1/sessions")); return;
    case "tools": print(await api("/v1/tools")); return;
    case "agents": print(await api("/v1/agents")); return;
    case "skills": print(await api("/v1/skills")); return;
    case "commands": print(await api("/v1/commands")); return;
    case "plugins": {
      const action = positional[1] ?? "list";
      if (action === "list") { print(await api("/v1/plugins")); return; }
      const name = positional[2];
      if (!name) throw new Error(`usage: oh plugins ${action} <name>`);
      if (action === "attach") { await api("/v1/plugins", { method: "POST", body: JSON.stringify({ name, persist: true }) }, true); print({ attached: name }); return; }
      if (action === "detach") { await api(`/v1/plugins/${encodeURIComponent(name)}`, { method: "DELETE", body: JSON.stringify({ persist: true }) }, true); print({ detached: name }); return; }
      throw new Error("usage: oh plugins [list|attach|detach]");
    }
    case "mcp": {
      const action = positional[1] ?? "list";
      if (action === "list") { print(await api("/v1/admin/mcp", {}, true)); return; }
      if (action === "presets") { print(await api("/v1/admin/mcp/presets", {}, true)); return; }
      if (action === "install") {
        const preset = positional[2];
        if (!preset) throw new Error("usage: oh mcp install <preset> [name] [workspace-root]");
        const [name, root] = positional.slice(3);
        print(await api(`/v1/admin/mcp/presets/${encodeURIComponent(preset)}/install`, { method: "POST", body: JSON.stringify({ name, root }) }, true)); return;
      }
      if (action === "set") {
        const name = positional[2];
        const raw = positional.slice(3).join(" ");
        if (!name || !raw) throw new Error("usage: oh mcp set <name> <config-json>");
        let config: unknown;
        try { config = JSON.parse(raw); } catch { throw new Error("MCP config must be valid JSON"); }
        await api(`/v1/admin/mcp/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(config) }, true); print({ saved: name }); return;
      }
      if (action === "delete") {
        const name = positional[2]; if (!name) throw new Error("usage: oh mcp delete <name>");
        await api(`/v1/admin/mcp/${encodeURIComponent(name)}`, { method: "DELETE" }, true); print({ deleted: name }); return;
      }
      if (action === "enable" || action === "disable") {
        const name = positional[2]; if (!name) throw new Error(`usage: oh mcp ${action} <name>`);
        await api(`/v1/admin/mcp/${encodeURIComponent(name)}/enable`, { method: "POST", body: JSON.stringify({ enabled: action === "enable" }) }, true); print({ name, enabled: action === "enable" }); return;
      }
      if (action === "reconnect") {
        const name = positional[2]; if (!name) throw new Error("usage: oh mcp reconnect <name>");
        print(await api(`/v1/admin/mcp/${encodeURIComponent(name)}/reconnect`, { method: "POST" }, true)); return;
      }
      throw new Error("usage: oh mcp [list|presets|install|set|delete|enable|disable|reconnect]");
    }
    case "events": await streamEvents(positional[1]); return;
    case "config": {
      if (positional[1] === "set") {
        const section = positional[2];
        const raw = positional.slice(3).join(" ");
        if (!section || !raw) throw new Error("usage: oh config set <section> <json>");
        let value: unknown;
        try { value = JSON.parse(raw); } catch { throw new Error("config value must be valid JSON"); }
        print(await api(`/v1/admin/settings/${encodeURIComponent(section)}`, { method: "PUT", body: JSON.stringify({ value }) }, true)); return;
      }
      print(await api("/v1/admin/settings", {}, true)); return;
    }
    case "secrets": {
      const subcommand = positional[1] ?? "list";
      if (subcommand === "list") { print(await api("/v1/admin/secrets", {}, true)); return; }
      if (subcommand === "set") {
        const name = positional[2];
        if (!name) throw new Error("usage: printf 'value' | oh secrets set <NAME>");
        const value = await readStdin();
        await api(`/v1/admin/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) }, true);
        print({ saved: name }); return;
      }
      if (subcommand === "delete") {
        const name = positional[2];
        if (!name) throw new Error("usage: oh secrets delete <NAME>");
        await api(`/v1/admin/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }, true);
        print({ deleted: name }); return;
      }
      throw new Error("usage: oh secrets [list|set|delete]");
    }
    case "run": {
      const prompt = positional.slice(1).join(" ");
      if (!prompt) throw new Error("run requires a prompt");
      const result = await runPrompt(prompt); print(result);
      if (result.status !== "completed") process.exitCode = 1;
      return;
    }
    case "eval": {
      const file = positional[1];
      if (!file) throw new Error("eval requires a JSONL suite path");
      await runEval(file, positional[2]); return;
    }
    case "admin":
      if (positional[1] !== "token") throw new Error("usage: oh admin token");
      print(randomBytes(32).toString("base64url")); return;
    default: throw new Error(`unknown command: ${command}\n\n${help}`);
  }
}

if (import.meta.main) main().catch((error) => { console.error(`oh: ${(error as Error).message}`); process.exitCode = 1; });
