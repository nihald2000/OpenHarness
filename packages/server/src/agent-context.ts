import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type AgentDefinition = {
  name: string;
  description: string;
  mode: "primary" | "subagent";
  model?: string;
  prompt?: string;
  tools?: string[];
  permissions?: { allow?: string[]; deny?: string[] };
  source: string;
  builtIn?: boolean;
};
export type MarkdownResource = { name: string; description: string; path: string; content: string; triggers?: string[]; metadata?: Record<string, unknown> };
export type ProjectContext = { agent: AgentDefinition; instructions: string[]; skills: MarkdownResource[]; commands: MarkdownResource[] };

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_FILE = 40_000;
const MAX_TOTAL = 120_000;
const MAX_ENTRIES = 80;
const MAX_INSTRUCTION_FILES = 100;

export const BUILTIN_AGENTS: AgentDefinition[] = [
  { name: "assistant", description: "General-purpose OpenHarness assistant.", mode: "primary", source: "builtin", builtIn: true },
  { name: "plan", description: "Create a read-only implementation plan.", mode: "primary", source: "builtin", builtIn: true, tools: ["update_plan"] },
  { name: "general", description: "General-purpose delegated analyst.", mode: "subagent", source: "builtin", tools: [] },
  { name: "explore", description: "Read-only repository exploration agent.", mode: "subagent", source: "builtin", tools: ["read_file", "search"] },
];

function within(root: string, target: string) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && path !== ".." && !isAbsolute(path));
}

function configRoot() {
  if (process.env.OPENHARNESS_CONFIG_DIR) return resolve(process.env.OPENHARNESS_CONFIG_DIR);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  return process.platform === "win32" ? resolve(process.env.APPDATA ?? resolve(home, "AppData", "Roaming"), "openharness") : resolve(home, ".config", "openharness");
}

function frontmatter(source: string) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(source);
  if (!match) return { metadata: {} as Record<string, unknown>, body: source, valid: !source.startsWith("---") };
  type YamlLine = { indent: number; text: string };
  const lines: YamlLine[] = [];
  for (const rawLine of match[1]!.split(/\r?\n/)) {
    if (/\t/.test(rawLine.match(/^\s*/)?.[0] ?? "")) return { metadata: {} as Record<string, unknown>, body: source.slice(match[0].length), valid: false };
    let quoted = ""; let escaped = false; let end = rawLine.length;
    for (let index = 0; index < rawLine.length; index++) {
      const character = rawLine[index]!;
      if (escaped) { escaped = false; continue; }
      if (character === "\\" && quoted === '"') { escaped = true; continue; }
      if ((character === '"' || character === "'") && (!quoted || quoted === character)) { quoted = quoted ? "" : character; continue; }
      if (character === "#" && !quoted && (index === 0 || /\s/.test(rawLine[index - 1]!))) { end = index; break; }
    }
    const content = rawLine.slice(0, end).trimEnd();
    if (!content.trim()) continue;
    const indent = content.length - content.trimStart().length;
    lines.push({ indent, text: content.trimStart() });
  }
  const parseScalar = (raw: string): unknown => {
    const value = raw.trim();
    if (!value) return undefined;
    if (value.startsWith('"')) { const parsed: unknown = JSON.parse(value); if (typeof parsed !== "string") throw new Error("invalid quoted string"); return parsed; }
    if (value.startsWith("'")) { if (!value.endsWith("'") || value.length < 2) throw new Error("invalid quoted string"); return value.slice(1, -1).replace(/''/g, "'"); }
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null" || value === "~") return null;
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) { const number = Number(value); if (Number.isFinite(number)) return number; }
    if (value.startsWith("[") && value.endsWith("]")) {
      const inside = value.slice(1, -1).trim();
      if (!inside) return [];
      const items: string[] = []; let start = 0; let quote = ""; let depth = 0;
      for (let index = 0; index < inside.length; index++) { const character = inside[index]!; if ((character === '"' || character === "'") && (!quote || quote === character)) quote = quote ? "" : character; else if (!quote && character === "[") depth++; else if (!quote && character === "]") depth--; else if (!quote && depth === 0 && character === ",") { items.push(inside.slice(start, index)); start = index + 1; } }
      if (quote || depth !== 0) throw new Error("invalid inline list");
      items.push(inside.slice(start)); return items.map(parseScalar);
    }
    if (/^[!&*]|^(?:\{|>|\||%|@|`)/.test(value)) throw new Error("unsupported YAML feature");
    return value;
  };
  const parseKeyValue = (text: string) => {
    const colon = text.indexOf(":");
    if (colon < 1 || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(text.slice(0, colon).trim())) throw new Error("invalid YAML mapping key");
    return [text.slice(0, colon).trim(), text.slice(colon + 1).trim()] as const;
  };
  try {
    let index = 0;
    const parseBlock = (indent: number): unknown => {
      const isList = lines[index]?.text === "-" || lines[index]?.text.startsWith("- ");
      const container: unknown[] | Record<string, unknown> = isList ? [] : {};
      while (index < lines.length && lines[index]!.indent === indent) {
        const line = lines[index]!;
        if (isList) {
          if (!(line.text === "-" || line.text.startsWith("- "))) throw new Error("mixed YAML list and mapping");
          const rest = line.text === "-" ? "" : line.text.slice(2).trim(); index++;
          if (!rest) { if (lines[index]?.indent <= indent) throw new Error("empty YAML list item"); (container as unknown[]).push(parseBlock(lines[index]!.indent)); continue; }
          if (/^[a-zA-Z][a-zA-Z0-9_-]{0,63}:/.test(rest)) {
            const [key, value] = parseKeyValue(rest); const item: Record<string, unknown> = {};
            if (value) item[key] = parseScalar(value);
            else { if (lines[index]?.indent <= indent) throw new Error("empty nested YAML value"); item[key] = parseBlock(lines[index]!.indent); }
            if (lines[index]?.indent > indent) { const nestedIndent = lines[index]!.indent; if (lines[index]!.text.startsWith("- ")) throw new Error("invalid YAML list mapping continuation"); const tail = parseBlock(nestedIndent); if (!tail || Array.isArray(tail) || typeof tail !== "object") throw new Error("invalid YAML mapping continuation"); Object.assign(item, tail); }
            (container as unknown[]).push(item);
          } else { (container as unknown[]).push(parseScalar(rest)); if (lines[index]?.indent > indent) throw new Error("scalar YAML item cannot have nested values"); }
        } else {
          if (line.text === "-" || line.text.startsWith("- ")) throw new Error("mixed YAML mapping and list");
          const [key, value] = parseKeyValue(line.text); if (Object.hasOwn(container, key)) throw new Error("duplicate YAML mapping key"); index++;
          if (value) (container as Record<string, unknown>)[key] = parseScalar(value);
          else if (lines[index]?.indent > indent) (container as Record<string, unknown>)[key] = parseBlock(lines[index]!.indent);
          else (container as Record<string, unknown>)[key] = null;
        }
        if (index < lines.length && lines[index]!.indent < indent) break;
        if (index < lines.length && lines[index]!.indent > indent) throw new Error("unexpected YAML indentation");
      }
      return container;
    };
    const parsed = lines.length ? parseBlock(lines[0]!.indent) : {};
    if (index !== lines.length || !parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("frontmatter must be a YAML mapping");
    return { metadata: parsed as Record<string, unknown>, body: source.slice(match[0].length), valid: true };
  } catch {
    return { metadata: {} as Record<string, unknown>, body: source.slice(match[0].length), valid: false };
  }
}

async function entries(directory: string) {
  try { return (await readdir(directory, { withFileTypes: true })).filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules").slice(0, MAX_ENTRIES); }
  catch { return []; }
}

async function readMarkdown(base: string, path: string) {
  try {
    const file = await realpath(resolve(base, path));
    const root = await realpath(base);
    if (!within(root, file) || !(await stat(file)).isFile()) return undefined;
    return (await readFile(file, "utf8")).slice(0, MAX_FILE);
  } catch { return undefined; }
}

async function markdownDirectory(base: string, directory: string, nestedSkills = false): Promise<MarkdownResource[]> {
  const full = resolve(base, directory);
  const root = await realpath(base).catch(() => base);
  const realDirectory = await realpath(full).catch(() => undefined);
  if (!realDirectory || !within(root, realDirectory)) return [];
  const result: MarkdownResource[] = [];
  for (const entry of await entries(realDirectory)) {
    if (nestedSkills && entry.isDirectory() && NAME.test(entry.name)) {
      const skillPath = `${directory}/${entry.name}/SKILL.md`;
      const content = await readMarkdown(base, skillPath);
      if (!content) continue;
      const parsed = frontmatter(content);
      if (!parsed.valid) continue;
      const name = typeof parsed.metadata.name === "string" && NAME.test(parsed.metadata.name) ? parsed.metadata.name : entry.name;
      const description = typeof parsed.metadata.description === "string" ? parsed.metadata.description.slice(0, 500) : parsed.body.trim().split(/\r?\n/)[0]?.slice(0, 500) ?? "";
      const triggers = Array.isArray(parsed.metadata.triggers) ? parsed.metadata.triggers.filter((value): value is string => typeof value === "string").slice(0, 30) : undefined;
      result.push({ name, description, path: skillPath, content: parsed.body.slice(0, MAX_FILE), triggers, metadata: parsed.metadata });
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const path = `${directory}/${entry.name}`;
      const content = await readMarkdown(base, path);
      if (!content) continue;
      const parsed = frontmatter(content);
      if (!parsed.valid) continue;
      const name = typeof parsed.metadata.name === "string" && NAME.test(parsed.metadata.name) ? parsed.metadata.name : entry.name.slice(0, -3);
      if (!NAME.test(name)) continue;
      const description = typeof parsed.metadata.description === "string" ? parsed.metadata.description.slice(0, 500) : parsed.body.trim().split(/\r?\n/)[0]?.slice(0, 500) ?? "";
      result.push({ name, description, path, content: parsed.body.slice(0, MAX_FILE), metadata: parsed.metadata });
    }
  }
  return result;
}

async function configuredSkills(workspace: string, paths: string[]): Promise<MarkdownResource[]> {
  const resources: MarkdownResource[] = [];
  for (const configuredPath of paths.slice(0, 20)) {
    if (typeof configuredPath !== "string" || !configuredPath.trim() || configuredPath.length > 2_000 || isAbsolute(configuredPath)) continue;
    resources.push(...await markdownDirectory(workspace, configuredPath, true));
  }
  return resources;
}

async function nestedInstructionFiles(root: string) {
  const found: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < MAX_INSTRUCTION_FILES) {
    const current = queue.shift()!;
    visited++;
    for (const entry of await entries(current.path)) {
      if (entry.isFile() && entry.name === "AGENTS.md") found.push(resolve(current.path, entry.name));
      else if (entry.isDirectory() && current.depth < 6) queue.push({ path: resolve(current.path, entry.name), depth: current.depth + 1 });
      if (found.length >= MAX_INSTRUCTION_FILES) break;
    }
  }
  return found.sort();
}

function mergeAgent(base: AgentDefinition, incoming: AgentDefinition): AgentDefinition {
  const baseAllow = base.permissions?.allow;
  const newAllow = incoming.permissions?.allow;
  const allow = baseAllow && newAllow ? baseAllow.filter((permission) => newAllow.includes(permission)) : newAllow ?? baseAllow;
  const deny = [...new Set([...(base.permissions?.deny ?? []), ...(incoming.permissions?.deny ?? [])])];
  return { ...base, ...incoming, permissions: { ...(allow ? { allow } : {}), ...(deny.length ? { deny } : {}) } };
}

export function mergeConfiguredAgent(base: AgentDefinition, raw: Record<string, unknown>): AgentDefinition {
  const permissions = raw.permissions && typeof raw.permissions === "object" && !Array.isArray(raw.permissions) ? raw.permissions as Record<string, unknown> : {};
  const incoming = {
    ...raw,
    name: base.name,
    description: typeof raw.description === "string" ? raw.description.slice(0, 500) : base.description,
    mode: raw.mode === "subagent" ? "subagent" as const : "primary" as const,
    source: "config",
    permissions: {
      ...(Array.isArray(permissions.allow) ? { allow: permissions.allow.filter((value): value is string => typeof value === "string") } : {}),
      ...(Array.isArray(permissions.deny) ? { deny: permissions.deny.filter((value): value is string => typeof value === "string") } : {}),
    },
  } as AgentDefinition;
  return mergeAgent(base, incoming);
}

function agentFromResource(resource: MarkdownResource, mode: AgentDefinition["mode"]): AgentDefinition | undefined {
  const metadata = resource.metadata ?? {};
  const rawMode = metadata.mode;
  const agentMode = rawMode === "subagent" || rawMode === "primary" ? rawMode : mode;
  const names = metadata.tools;
  const permissions = metadata.permissions && typeof metadata.permissions === "object" && !Array.isArray(metadata.permissions) ? metadata.permissions as Record<string, unknown> : {};
  const allow = permissions.allow ?? metadata.allow;
  const deny = permissions.deny ?? metadata.deny;
  return {
    name: resource.name,
    description: resource.description,
    mode: agentMode,
    ...(typeof metadata.model === "string" ? { model: metadata.model } : {}),
    prompt: resource.content.slice(0, MAX_FILE),
    ...(Array.isArray(names) ? { tools: names.filter((name): name is string => typeof name === "string") } : {}),
    permissions: {
      ...(Array.isArray(allow) ? { allow: allow.filter((name): name is string => typeof name === "string") } : {}),
      ...(Array.isArray(deny) ? { deny: deny.filter((name): name is string => typeof name === "string") } : {}),
    },
    source: resource.path,
  };
}

export async function discoverContext(workspace: string, requestedAgent: string, userPrompt: string, includeRepositoryInstructions: boolean, includeSkills = true, configuredSkillPaths: string[] = [], instructionPaths: string[] = [], instructionGlobs: string[] = []): Promise<ProjectContext> {
  const root = await realpath(workspace);
  const globalRoot = configRoot();
  const globalAgents = await markdownDirectory(globalRoot, "agents");
  const projectAgents = await markdownDirectory(root, ".openharness/agents");
  const definitions = new Map(BUILTIN_AGENTS.map((agent) => [agent.name, agent]));
  for (const resource of globalAgents) {
    const agent = agentFromResource(resource, "primary");
    if (agent) definitions.set(agent.name, mergeAgent(definitions.get(agent.name) ?? { name: agent.name, description: "", mode: agent.mode, source: "default" }, agent));
  }
  for (const resource of projectAgents) {
    const agent = agentFromResource(resource, "primary");
    if (agent) definitions.set(agent.name, mergeAgent(definitions.get(agent.name) ?? { name: agent.name, description: "", mode: agent.mode, source: "default" }, agent));
  }
  const selected = definitions.get(requestedAgent) ?? definitions.get("assistant")!;
  const globalSkills = await markdownDirectory(globalRoot, ".agents/skills", true);
  const projectSkills = await markdownDirectory(root, ".openharness/skills", true);
  const agentsSkills = await markdownDirectory(root, ".agents/skills", true);
  const configSkills = await markdownDirectory(globalRoot, "skills", true);
  const extraSkills = await configuredSkills(root, configuredSkillPaths);
  const skillMap = new Map<string, MarkdownResource>();
  for (const skill of [...globalSkills, ...configSkills, ...agentsSkills, ...extraSkills, ...projectSkills]) skillMap.set(skill.name, skill);
  const matchingSkills = includeSkills ? [...skillMap.values()].filter((skill) => skill.triggers?.some((trigger) => new RegExp(`\\b${trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(userPrompt))) : [];
  const globalCommands = await markdownDirectory(globalRoot, "commands");
  const projectCommands = await markdownDirectory(root, ".openharness/commands");
  const commandMap = new Map(globalCommands.map((command) => [command.name, command]));
  for (const command of projectCommands) commandMap.set(command.name, command);
  const instructionFiles: Array<[string, string]> = [];
  if (includeRepositoryInstructions) {
    const globalInstructions = await readMarkdown(globalRoot, "AGENTS.md");
    const projectInstructions = await readMarkdown(root, "AGENTS.md");
    if (globalInstructions) instructionFiles.push(["global AGENTS.md", globalInstructions]);
    if (projectInstructions) instructionFiles.push(["workspace AGENTS.md", projectInstructions]);
    const seenInstructions = new Set([resolve(globalRoot, "AGENTS.md"), resolve(root, "AGENTS.md")]);
    for (const configuredPath of instructionPaths.slice(0, MAX_INSTRUCTION_FILES)) {
      if (typeof configuredPath !== "string" || !configuredPath.trim() || configuredPath.length > 2_000 || isAbsolute(configuredPath)) continue;
      const absolute = resolve(root, configuredPath);
      if (seenInstructions.has(absolute)) continue;
      const content = await readMarkdown(root, configuredPath);
      if (content) { seenInstructions.add(absolute); instructionFiles.push([configuredPath, content]); }
    }
    if (instructionGlobs.includes("**/AGENTS.md")) {
      for (const path of await nestedInstructionFiles(root)) {
        if (seenInstructions.has(path)) continue;
        const relativePath = relative(root, path);
        const content = await readMarkdown(root, relativePath);
        if (content) { seenInstructions.add(path); instructionFiles.push([relativePath, content]); }
        if (instructionFiles.length >= MAX_INSTRUCTION_FILES) break;
      }
    }
  }
  const agentContext = [selected.prompt ? `## Agent ${selected.name}\n${selected.prompt}` : "", ...instructionFiles.map(([name, content]) => `## ${name}\n${content}`), ...matchingSkills.map((skill) => `## Skill ${skill.name} (${skill.path})\n${skill.content}`)].filter(Boolean).join("\n\n").slice(0, MAX_TOTAL);
  return { agent: selected, instructions: agentContext ? [agentContext] : [], skills: matchingSkills, commands: [...commandMap.values()] };
}

export async function discoverAgents(workspace: string) {
  const context = await discoverContext(workspace, "assistant", "", false);
  const roots = [configRoot(), await realpath(workspace)];
  const seen = new Map(BUILTIN_AGENTS.map((agent) => [agent.name, agent]));
  for (const [index, root] of roots.entries()) {
    for (const resource of await markdownDirectory(root, index === 0 ? "agents" : ".openharness/agents")) {
      const agent = agentFromResource(resource, "primary");
      if (agent) seen.set(agent.name, mergeAgent(seen.get(agent.name) ?? agent, agent));
    }
  }
  return [...seen.values()].map(({ name, description, mode, model, source, builtIn }) => ({ name, description, mode, model, source, builtIn }));
}

export async function discoverSkillsAndCommands(workspace: string, configuredSkillPaths: string[] = []) {
  const root = await realpath(workspace);
  const globalRoot = configRoot();
  const skillMap = new Map<string, MarkdownResource>();
  for (const skill of [
    ...await markdownDirectory(globalRoot, ".agents/skills", true),
    ...await markdownDirectory(globalRoot, "skills", true),
    ...await markdownDirectory(root, ".agents/skills", true),
    ...await markdownDirectory(root, ".openharness/skills", true),
  ]) skillMap.set(skill.name, skill);
  const commands = new Map((await markdownDirectory(globalRoot, "commands")).map((command) => [command.name, command]));
  for (const skill of await configuredSkills(root, configuredSkillPaths)) skillMap.set(skill.name, skill);
  for (const command of await markdownDirectory(root, ".openharness/commands")) commands.set(command.name, command);
  return {
    skills: [...skillMap.values()].map(({ content: _content, ...skill }) => skill),
    commands: [...commands.values()].map(({ content: _content, ...command }) => command),
  };
}

export function resolveSlashCommand(prompt: string, commands: MarkdownResource[]) {
  const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (!match) return undefined;
  const command = commands.find((entry) => entry.name === match[1]);
  if (!command) return undefined;
  const argsText = match[2] ?? "";
  const args = argsText.split(/\s+/).filter(Boolean);
  const expanded = command.content.replaceAll("$ARGUMENTS", argsText).replace(/\$([1-9])/g, (_, index: string) => args[Number(index) - 1] ?? "");
  return { command, text: `${expanded}\n\nUser request: ${argsText}`.slice(0, MAX_FILE) };
}
