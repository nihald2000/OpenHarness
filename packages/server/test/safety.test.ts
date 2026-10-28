import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSettings, listSecrets, resolveSecret, runtimeProviderConfig, setSecret, updateSettings } from "../src/config-store.ts";
import { parseEvalSuite } from "../src/cli.ts";
import { attachPlugin, listPlugins, putMcpServer, resetEphemeralPlugins } from "../src/extensions-store.ts";
import { discoverContext } from "../src/agent-context.ts";
import { compactHistory, contextHistoryBudgetChars, toolAllowedByAgent } from "../src/server.ts";
import { redactLogData } from "../src/logger.ts";
import { executeTool } from "../src/tools.ts";

const temporaryPaths: string[] = [];
async function temporaryDirectory() {
  const path = await mkdtemp(join(process.cwd(), ".safety-test-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("safety-sensitive backend behavior", () => {
  test("read_file rejects workspace escapes and reads contained files", async () => {
    const parent = await temporaryDirectory();
    const workspace = join(parent, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "note.txt"), "inside");
    await writeFile(join(parent, "outside.txt"), "outside");

    const inside = await executeTool("read_file", { path: "note.txt" }, workspace);
    expect(inside.output).toMatchObject({ path: "note.txt", content: "inside" });
    await expect(executeTool("read_file", { path: "../outside.txt" }, workspace)).rejects.toThrow("inside the workspace");
  });

  test("update_plan validates steps and marks every step pending", async () => {
    const result = await executeTool("update_plan", {
      title: "Change plan", steps: [{ title: "Inspect" }, { title: "Implement", detail: "Keep it bounded" }],
    }, process.cwd());
    expect(result.output).toMatchObject({ title: "Change plan", steps: [{ id: "1", status: "pending" }, { id: "2", status: "pending", detail: "Keep it bounded" }] });
    await expect(executeTool("update_plan", { title: "Empty", steps: [] }, process.cwd())).rejects.toThrow("from 1 to 30");
  });

  test("secret values are encrypted at rest and excluded from settings/catalog reads", async () => {
    const dataDir = await temporaryDirectory();
    await setSecret(dataDir, "PROVIDER_KEY", "very-secret-value");
    await updateSettings(dataDir, "providers", { example: { apiKey: "{secret:PROVIDER_KEY}" } });

    expect(await resolveSecret(dataDir, "PROVIDER_KEY")).toBe("very-secret-value");
    expect(await listSecrets(dataDir)).toEqual([expect.objectContaining({ name: "PROVIDER_KEY" })]);
    const settings = await getSettings(dataDir);
    expect(JSON.stringify(settings)).not.toContain("very-secret-value");
    expect(await readFile(join(dataDir, "secrets.json"), "utf8")).not.toContain("very-secret-value");
  });

  test("concurrent settings writes preserve both updated sections", async () => {
    const dataDir = await temporaryDirectory();
    await Promise.all([
      updateSettings(dataDir, "limits", { maxConcurrentRuns: 5 }),
      updateSettings(dataDir, "providers", { example: { type: "openai", models: { test: {} } } }),
    ]);
    const settings = await getSettings(dataDir);
    expect(settings.config.limits).toEqual({ maxConcurrentRuns: 5 });
    expect(settings.config.providers).toEqual({ example: { type: "openai", models: { test: {} } } });
  });

  test("verifier accepts only fixed allowlisted check names", async () => {
    await expect(executeTool("verify", { command: "rm -rf" }, process.cwd())).rejects.toThrow("must be typecheck");
  });

  test("eval parser reads JSONL and the documented YAML subset", () => {
    expect(parseEvalSuite('{"id":"json","prompt":"hello"}\n')).toEqual([{ id: "json", prompt: "hello" }]);
    expect(parseEvalSuite('cases:\n  - id: yaml\n    prompt: "hello world"\n    toolsCalled:\n      - read_file\n      - search\n')).toEqual([
      { id: "yaml", prompt: "hello world", toolsCalled: ["read_file", "search"] },
    ]);
  });

  test("eval YAML rejects nested mappings", () => {
    expect(() => parseEvalSuite("- id: unsafe\n  prompt: hello\n  options:\n    nested: value\n")).toThrow("unsupported YAML syntax");
  });

  test("plugin attachment is allowlisted and ephemeral attachments reset", async () => {
    const dataDir = await temporaryDirectory();
    await expect(attachPlugin(dataDir, { name: "untrusted", module: "file:///tmp/plugin.js" })).rejects.toThrow("not in the built-in trust allowlist");
    await attachPlugin(dataDir, { name: "modal-sandbox", persist: false });
    expect((await listPlugins(dataDir)).find((plugin) => plugin.name === "modal-sandbox")?.status).toBe("attached");
    await resetEphemeralPlugins(dataDir);
    expect((await listPlugins(dataDir)).find((plugin) => plugin.name === "modal-sandbox")?.status).toBe("detached");
  });

  test("MCP configuration rejects unsafe names and secret interpolation forms", async () => {
    const dataDir = await temporaryDirectory();
    await expect(putMcpServer(dataDir, "bad__name", { transport: "http", url: "https://example.invalid" })).rejects.toThrow("may not contain '__'");
    await expect(putMcpServer(dataDir, "safe", { transport: "http", url: "https://example.invalid", headers: { Authorization: "{env:OPENAI_API_KEY}" } })).rejects.toThrow("invalid");
  });

  test("configured workspace skills and nested instruction paths are bounded and opt-in", async () => {
    const workspace = await temporaryDirectory();
    await mkdir(join(workspace, "configured-skills", "sample"), { recursive: true });
    await mkdir(join(workspace, "packages", "nested"), { recursive: true });
    await writeFile(join(workspace, "configured-skills", "sample", "SKILL.md"), "---\nname: sample\ndescription: Sample skill\ntriggers: [alpha]\n---\nUse the sample workflow.");
    await writeFile(join(workspace, "packages", "nested", "AGENTS.md"), "Scoped nested instructions.");

    const enabled = await discoverContext(workspace, "assistant", "alpha task", true, true, ["configured-skills"], ["packages/nested/AGENTS.md"]);
    expect(enabled.skills.map((skill) => skill.name)).toEqual(["sample"]);
    expect(enabled.instructions.join("\n")).toContain("Scoped nested instructions.");
    expect(enabled.instructions.join("\n")).toContain("Use the sample workflow.");

    const disabled = await discoverContext(workspace, "assistant", "alpha task", false, true, ["configured-skills"], ["packages/nested/AGENTS.md"]);
    expect(disabled.instructions.join("\n")).not.toContain("Scoped nested instructions.");
    expect(disabled.instructions.join("\n")).toContain("Use the sample workflow.");

    const globbed = await discoverContext(workspace, "assistant", "", true, false, [], [], ["**/AGENTS.md"]);
    expect(globbed.instructions.join("\n")).toContain("Scoped nested instructions.");
  });

  test("agent and skill frontmatter accepts nested YAML mappings and lists", async () => {
    const workspace = await temporaryDirectory();
    await mkdir(join(workspace, ".openharness", "agents"), { recursive: true });
    await mkdir(join(workspace, ".openharness", "skills", "alpha"), { recursive: true });
    await writeFile(join(workspace, ".openharness", "agents", "reviewer.md"), [
      "---", "name: reviewer", "description: Nested metadata agent", "mode: subagent", "tools:", "  - read_file", "  - search", "permissions:", "  allow:", "    - read_file", "  deny: [shell]", "settings:", "  depth: 2", "---", "Review carefully.",
    ].join("\n"));
    await writeFile(join(workspace, ".openharness", "skills", "alpha", "SKILL.md"), [
      "---", "name: alpha", "description: Alpha skill", "triggers:", "  - alpha task", "metadata:", "  source: local", "---", "Skill instructions.",
    ].join("\n"));
    const context = await discoverContext(workspace, "reviewer", "alpha task", false, true);
    expect(context.agent).toMatchObject({ name: "reviewer", mode: "subagent", tools: ["read_file", "search"], permissions: { allow: ["read_file"], deny: ["shell"] } });
    expect(context.skills[0]).toMatchObject({ name: "alpha", triggers: ["alpha task"], metadata: { metadata: { source: "local" } } });
  });

  test("provider pricing is validated and returned for cost reporting", async () => {
    const dataDir = await temporaryDirectory();
    await updateSettings(dataDir, "providers", {
      test: { type: "openai", models: { cheap: { inputCostPerMillion: 0.25, outputCostPerMillion: 1.5 }, invalid: { inputCostPerMillion: -1, outputCostPerMillion: "unknown" } } },
    });
    expect(await runtimeProviderConfig(dataDir, "test/cheap")).toMatchObject({ provider: "openai", model: "cheap", inputCostPerMillion: 0.25, outputCostPerMillion: 1.5 });
    expect(await runtimeProviderConfig(dataDir, "test/invalid")).toMatchObject({ provider: "openai", model: "invalid" });
  });

  test("compaction summarizes decisions while retaining recent and active tool messages", () => {
    const messages = [
      { info: { id: "u1", role: "user" }, createdAt: 1, parts: [{ type: "text", text: "Requirement: keep all paths workspace-scoped.\nQuestion: Should the context limit include skills?" }] },
      { info: { id: "a1", role: "assistant" }, createdAt: 2, parts: [{ type: "text", text: "Decision: use canonical paths and reject escapes." }] },
      { info: { id: "a2", role: "assistant" }, createdAt: 3, parts: [{ type: "tool", tool: "write_file", callId: "pending-1", state: "running", input: { path: "safe.txt" } }] },
      { info: { id: "u2", role: "user" }, createdAt: 4, parts: [{ type: "text", text: "Now implement the change." }] },
    ] as never[];
    const result = compactHistory(messages as never, 1, "tokens");
    expect(result?.messages.map((message) => message.info.id)).toContain("a2");
    expect(result?.messages.map((message) => message.info.id)).toContain("u2");
    const summary = result?.summary.parts[0];
    expect(summary?.type).toBe("compaction");
    if (summary?.type === "compaction") {
      expect(summary.summary).toContain("Requirement: keep all paths workspace-scoped.");
      expect(summary.summary).toContain("Decision: use canonical paths and reject escapes.");
      expect(summary.openQuestions).toContain("Question: Should the context limit include skills?");
      expect(summary.requirements?.[0]).toContain("Question: Should the context limit include skills?");
    }
  });

  test("context history budget subtracts both prompts and the reserved overhead", () => {
    expect(contextHistoryBudgetChars(10_000, "u".repeat(4_000), "s".repeat(2_000))).toBe((10_000 - 1_000 - 500 - 512) * 4);
    expect(contextHistoryBudgetChars(1_000, "u".repeat(4_000), "s".repeat(2_000))).toBe(0);
    expect(contextHistoryBudgetChars(1_000_000, "", "")).toBe(512_000);
  });

  test("agent tool policy applies the tool list, allow list, and deny list together", () => {
    const agent = { name: "limited", description: "", mode: "primary", source: "test", tools: ["read_file", "search"], permissions: { allow: ["read_file", "search"], deny: ["search"] } } as const;
    expect(toolAllowedByAgent(agent, "read_file")).toBe(true);
    expect(toolAllowedByAgent(agent, "search")).toBe(false);
    expect(toolAllowedByAgent(agent, "shell")).toBe(false);
    expect(toolAllowedByAgent({ name: "default", description: "", mode: "primary", source: "test" }, "shell")).toBe(true);
  });

  test("structured log redaction masks secret fields and common credential strings", () => {
    expect(redactLogData({ sessionId: "session-1", apiKey: "sk-1234567890abcdef", detail: "Authorization: Bearer abc.def.ghi" })).toEqual({
      sessionId: "session-1", apiKey: "[REDACTED]", detail: "Authorization: Bearer [REDACTED]",
    });
  });
});
