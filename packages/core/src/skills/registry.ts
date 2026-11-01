import fs from "node:fs";
import path from "node:path";
import type { SkillInfo } from "@openharness/sdk";
import type { RegisteredTool } from "../agent/deps.ts";

export interface LoadedSkill extends SkillInfo {
  id: string;
  source: "builtin" | "workspace" | "user" | "remote";
  directory?: string;
  files?: string[];
}

export const BUILTIN_SKILLS: LoadedSkill[] = [
  {
    id: "fullstack-web-app",
    name: "fullstack-web-app",
    source: "builtin",
    description:
      "End-to-end architecture and workflow for building, running, and verifying full-stack web applications (React, Vite, Next.js, Tailwind CSS, Express, FastAPI, SQLite).",
    triggers: ["web app", "react", "vite", "nextjs", "tailwind", "fullstack", "dashboard", "crud"],
    content: `# Full-Stack Web Application Engineering Skill

## When to Use
Load this skill whenever building, scaffolding, or extending a web application, dashboard, API + frontend, or interactive browser tool.

## Workflow
1. **Inspect Workspace First**: Use \`list\`, \`glob\`, and \`read_file\` to check \`package.json\`, existing routes, and build scripts before creating files.
2. **Clean Architecture**:
   - Keep frontend state predictable and co-located; extract reusable UI components cleanly.
   - Always handle loading, empty, and error states explicitly in the UI.
   - Bind dev servers to \`0.0.0.0\` on a known port (e.g. \`--host 0.0.0.0 --port 3000\`) so cloud preview tunnels can reach them.
3. **Compile & Typecheck**:
   - Run \`npm run build\` or \`npx tsc --noEmit\` via \`bash\` and fix all compiler or bundler errors immediately.
4. **Live Dev Server & Browser Verification**:
   - Start the server with \`process_start\` (passing \`port\`) and fetch \`preview_url\`.
   - If the tool returns \`previewUrl\` and \`internalUrl\`, use \`internalUrl\` for the sandbox browser and report the HTTPS \`previewUrl\` to the user.
   - Open the preview URL with \`browser_navigate\`, inspect interactive elements via \`browser_snapshot\`, test user flows (\`browser_click\`, \`browser_type\`), and check \`browser_console\` for zero runtime errors.`,
  },
  {
    id: "webapp-testing",
    name: "webapp-testing",
    source: "builtin",
    description:
      "Automated headless browser verification and E2E testing workflow using browser_navigate, browser_snapshot, browser_click, browser_type, browser_console, and browser_screenshot.",
    triggers: ["test ui", "browser test", "e2e", "playwright", "verify preview", "screenshot"],
    content: `# Web Application Testing & Verification Skill

## Step-by-Step Verification Loop
1. **Start & Locate Server**: Start the app via \`process_start\` and confirm it is listening via \`process_logs\` and \`preview_url\`.
2. **Navigate & Snapshot**: Call \`browser_navigate\` with the preview URL, then call \`browser_snapshot\` to inspect the accessibility tree and \`[ref=eN]\` handles.
3. **Exercise Core Flows**: Use \`browser_click\`, \`browser_type\`, and \`browser_press\` on the \`[ref=eN]\` handles to test primary user actions (forms, buttons, navigation).
4. **Check Console & Network**: Call \`browser_console\` to verify there are no uncaught exceptions or failed API requests, and capture a final \`browser_screenshot\`.`,
  },
  {
    id: "systematic-debugging",
    name: "systematic-debugging",
    source: "builtin",
    description:
      "Four-phase root-cause debugging methodology (Reproduce, Isolate, Fix, Regression Test) for compiler errors, failing tests, and runtime crashes.",
    triggers: ["debug", "fix bug", "failing test", "stack trace", "crash", "error"],
    content: `# Systematic Debugging Skill

## 4-Phase Debugging Loop
1. **Reproduce Deterministically**: Run the failing test or command via \`bash\` and read the exact stack trace and line numbers.
2. **Isolate Root Cause**: Use \`search\`/\`grep\` and \`read_file\` to trace data flow from the call site to the failure point.
3. **Minimal Targeted Fix**: Use \`edit\` (\`str_replace\`) to fix the underlying cause rather than suppressing the symptom.
4. **Verify & Prevent Regression**: Re-run the failing test plus the full test/typecheck suite via \`bash\` or \`verify\`.`,
  },
  {
    id: "mcp-builder",
    name: "mcp-builder",
    source: "builtin",
    description:
      "Guide for using, configuring, and building Model Context Protocol (MCP) servers and tools over stdio and HTTP/SSE JSON-RPC 2.0.",
    triggers: ["mcp", "model context protocol", "mcp server", "mcp tool", "connect mcp"],
    content: `# Model Context Protocol (MCP) Builder & Integration Skill

## Using Connected MCP Tools in OpenHarness
- OpenHarness connects default MCP servers automatically (\`filesystem\`, \`memory\`, \`sequential-thinking\`, \`web-fetch\`).
- Their tools are available directly as \`mcp__<server>__<tool>\` (e.g. \`mcp__memory__create_entities\`, \`mcp__sequential_thinking__sequentialthinking\`, \`mcp__web_fetch__web_search\`).
- List connected MCP servers with \`mcp_list_servers\`, connect a new stdio or HTTP MCP server on the fly with \`mcp_connect_server\`, or invoke any MCP tool dynamically via \`mcp_call_tool\`.`,
  },
  {
    id: "frontend-design",
    name: "frontend-design",
    source: "builtin",
    description:
      "Production UI/UX design system guidelines for clean typography, responsive layouts, accessible contrast, and polished interactive components.",
    triggers: ["ui design", "styling", "css", "landing page", "component design", "ux"],
    content: `# Frontend Design & UI Craft Skill

## Principles
1. **Visual Hierarchy**: Use clear typographic scale, generous whitespace, consistent border radii, and subtle surface elevation.
2. **Interactive Polish**: Every button, input, and card should have distinct hover, focus-visible, active, and disabled states.
3. **Responsive by Default**: Use CSS Grid and Flexbox layouts that adapt cleanly from mobile (375px) to desktop (1440px+).
4. **Accessibility**: Use semantic HTML landmarks, explicit \`aria-label\` attributes on icon buttons, and WCAG AA contrast.`,
  },
  {
    id: "python-data-science",
    name: "python-data-science",
    source: "builtin",
    description:
      "Workflows for Python services (FastAPI, Pydantic), data analysis, scientific computing, and pytest verification.",
    triggers: ["python", "fastapi", "pytest", "pandas", "data analysis", "script"],
    content: `# Python Engineering & Data Science Skill

## Workflow
1. Check available Python packages before importing; use standard library or installed packages cleanly.
2. Use Python type hints and dataclasses/Pydantic models for clear interfaces.
3. Use \`ipython\` for quick data inspection and \`bash\` to run \`python3 -m pytest\` or \`python3 -m unittest\` for verification.`,
  },
  {
    id: "git-workflow",
    name: "git-workflow",
    source: "builtin",
    description:
      "Safe repository exploration, surgical file editing with edit/apply_patch, shadow-git checkpoints, and clean diff verification.",
    triggers: ["git", "commit", "patch", "refactor", "branch", "diff"],
    content: `# Git & Codebase Refactoring Skill

## Best Practices
1. Prefer \`edit\` (\`str_replace\`) or \`apply_patch\` over overwriting entire files with \`write_file\`.
2. Create a \`checkpoint\` before large multi-file refactors so changes can be rewound cleanly if needed.
3. Run \`git status\` and \`git diff\` via \`bash\` before completing a task to ensure no unintended files remain.`,
  },
  {
    id: "skill-creator",
    name: "skill-creator",
    source: "builtin",
    description:
      "Create new reusable Agent Skills (SKILL.md with YAML frontmatter) or import skills from GitHub/URLs into .openharness/skills/.",
    triggers: ["create skill", "new skill", "import skill", "SKILL.md", "agent skill"],
    content: `# Skill Creator & Importer Guide

## SKILL.md Format
Every skill lives in \`.openharness/skills/<skill-id>/SKILL.md\` and begins with YAML frontmatter (\`name\`, \`description\`, \`triggers\`). Use the \`import_skill\` tool to create a new skill from Markdown content or fetch a \`SKILL.md\` directly from a URL.`,
  },
];

function parseSkillMarkdown(raw: string, fallbackId: string): {
  name: string;
  description: string;
  triggers: string[];
  body: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    const firstParagraph = normalized
      .split("\n")
      .find((l) => l.trim() && !l.trim().startsWith("#"))
      ?.trim();
    return {
      name: fallbackId,
      description: firstParagraph?.slice(0, 200) || `Custom skill ${fallbackId}`,
      triggers: [fallbackId],
      body: normalized.trim(),
    };
  }
  const fm = fmMatch[1]!;
  const body = fmMatch[2]!.trim();
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  const trigMatch = fm.match(/^triggers:\s*(\[.*\])\s*$/m);
  const parseString = (value: string | undefined, fallback: string) => {
    const normalized = value?.trim();
    if (!normalized) return fallback;
    if (normalized.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(normalized);
        if (typeof parsed === "string") return parsed;
      } catch {}
    }
    return normalized.replace(/^['"]|['"]$/g, "");
  };
  const name = parseString(nameMatch?.[1], fallbackId);
  const description = parseString(descMatch?.[1], `Skill ${name}`);
  let triggers: string[] = [name];
  if (trigMatch?.[1]) {
    try {
      const parsed: unknown = JSON.parse(trigMatch[1]);
      if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
        triggers = parsed;
      }
    } catch {
      triggers = trigMatch[1]
        .slice(1, -1)
        .split(",")
        .map((value) => parseString(value, ""))
        .filter(Boolean);
    }
  }
  return { name, description, triggers, body };
}

export class SkillsRegistry {
  private workspaceRoot: string;
  private dataDir?: string;
  private customSkills = new Map<string, LoadedSkill>();

  constructor(opts: { workspaceRoot: string; dataDir?: string }) {
    this.workspaceRoot = opts.workspaceRoot;
    this.dataDir = opts.dataDir;
  }

  private scanDiskSkills(): LoadedSkill[] {
    const found: LoadedSkill[] = [];
    const searchRoots = [
      path.join(this.workspaceRoot, ".openharness", "skills"),
      path.join(this.workspaceRoot, ".claude", "skills"),
      path.join(this.workspaceRoot, ".opencode", "skills"),
      path.join(this.workspaceRoot, "skills"),
      ...(this.dataDir ? [path.join(this.dataDir, "skills")] : []),
    ];

    for (const rootDir of searchRoots) {
      if (!fs.existsSync(rootDir)) continue;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = path.join(rootDir, entry.name);
        const skillFile = path.join(skillDir, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        try {
          const raw = fs.readFileSync(skillFile, "utf8");
          const parsed = parseSkillMarkdown(raw, entry.name);
          const files = fs.readdirSync(skillDir).filter((f) => f !== "SKILL.md");
          found.push({
            id: entry.name,
            name: parsed.name,
            description: parsed.description,
            triggers: parsed.triggers,
            content: parsed.body,
            source: "workspace",
            directory: skillDir,
            files,
          });
        } catch {}
      }
    }
    return found;
  }

  listSkills(): LoadedSkill[] {
    const map = new Map<string, LoadedSkill>();
    for (const s of BUILTIN_SKILLS) map.set(s.id, s);
    const diskSkillIds = new Set<string>();
    for (const s of this.scanDiskSkills()) {
      if (!diskSkillIds.has(s.id)) map.set(s.id, s);
      diskSkillIds.add(s.id);
    }
    for (const [id, s] of this.customSkills.entries()) map.set(id, s);
    return Array.from(map.values());
  }

  getSkill(idOrName: string): LoadedSkill | undefined {
    const q = idOrName.trim().toLowerCase();
    const all = this.listSkills();
    return (
      all.find((s) => s.id.toLowerCase() === q || s.name.toLowerCase() === q) ??
      all.find(
        (s) =>
          s.id.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.triggers?.some((t) => t.toLowerCase().includes(q))
      )
    );
  }

  saveSkill(input: {
    id?: string;
    name: string;
    description?: string;
    triggers?: string[];
    content: string;
    source?: "workspace" | "user" | "remote";
  }): LoadedSkill {
    const rawId =
      (input.id ?? input.name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || `skill-${Date.now()}`;
    const parsed = parseSkillMarkdown(input.content, rawId);
    const name = input.name?.trim() || parsed.name;
    const description = input.description?.trim() || parsed.description;
    const triggers = input.triggers?.length ? input.triggers : parsed.triggers;
    const body = parsed.body;

    const targetDir = path.join(this.workspaceRoot, ".openharness", "skills", rawId);
    fs.mkdirSync(targetDir, { recursive: true });
    const md = [
      "---",
      `name: ${JSON.stringify(name)}`,
      `description: ${JSON.stringify(description)}`,
      `triggers: ${JSON.stringify(triggers)}`,
      "---",
      "",
      body,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(targetDir, "SKILL.md"), md, "utf8");

    const skill: LoadedSkill = {
      id: rawId,
      name,
      description,
      triggers,
      content: body,
      source: input.source ?? "workspace",
      directory: targetDir,
      files: [],
    };
    this.customSkills.set(rawId, skill);
    return skill;
  }

  async importSkillFromUrl(url: string, customId?: string): Promise<LoadedSkill> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error("Skill import URL is invalid.");
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) {
      throw new Error("Skill import URLs must use HTTPS and must not contain credentials.");
    }
    const resp = await fetch(parsedUrl, {
      redirect: "error",
      headers: { "User-Agent": "OpenHarness-SkillImporter/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      throw new Error(`Failed to fetch skill: HTTP ${resp.status}`);
    }
    const maxBytes = 1024 * 1024;
    const declaredLength = Number(resp.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error("Skill file is too large to import (maximum 1 MiB).");
    }
    const reader = resp.body?.getReader();
    if (!reader) throw new Error("Skill response had no body.");
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error("Skill file is too large to import (maximum 1 MiB).");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const urlPath = parsedUrl.pathname.split("/").filter(Boolean);
    const parentFolder =
      urlPath.at(-1)?.toLowerCase() === "skill.md"
        ? urlPath.at(-2) ?? "imported-skill"
        : urlPath.at(-1)?.replace(/\.md$/i, "") ?? "imported-skill";
    const id = customId?.trim() || parentFolder;
    const parsed = parseSkillMarkdown(text, id);
    return this.saveSkill({
      id,
      name: parsed.name,
      description: parsed.description,
      triggers: parsed.triggers,
      content: text,
      source: "remote",
    });
  }

  buildTools(): RegisteredTool[] {
    return [
      {
        name: "skill",
        description:
          "Loads a specialized skill's instructions and workflow into the conversation by skill ID or name (`fullstack-web-app`, `webapp-testing`, `systematic-debugging`, `mcp-builder`, `frontend-design`, `python-data-science`, `git-workflow`, `skill-creator`). Example: {\"id\": \"fullstack-web-app\"}",
        readOnly: true,
        idempotent: true,
        parameters: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", description: "The ID or name of the skill to load" },
          },
        },
        execute: async (input) => {
          const id = String(input.id ?? input.name ?? "").trim();
          if (!id) {
            return {
              output: null,
              error: "skill requires an `id` parameter. Call `list_skills` to see available skills.",
            };
          }
          const found = this.getSkill(id);
          if (!found) {
            const available = this.listSkills().map((s) => s.id).join(", ");
            return {
              output: null,
              error: `Skill "${id}" not found. Available skills: ${available}`,
            };
          }
          return {
            output: {
              id: found.id,
              name: found.name,
              description: found.description,
              source: found.source,
              directory: found.directory ?? `builtin://${found.id}`,
              files: found.files ?? [],
              instructions: found.content,
            },
          };
        },
      },
      {
        name: "list_skills",
        description:
          "Lists all available built-in and workspace Agent Skills (`id`, `name`, `description`, `triggers`, `source`). Example: {}",
        readOnly: true,
        idempotent: true,
        parameters: { type: "object", properties: {} },
        execute: async () => {
          const skills = this.listSkills().map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            triggers: s.triggers,
            source: s.source,
          }));
          return { output: { count: skills.length, skills } };
        },
      },
      {
        name: "import_skill",
        description:
          "Creates a new Agent Skill (`SKILL.md`) in `.openharness/skills/<id>/SKILL.md` or imports one directly from a remote URL (such as a GitHub raw `SKILL.md` URL).",
        readOnly: false,
        idempotent: true,
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            url: { type: "string" },
            content: { type: "string" },
            triggers: { type: "array", items: { type: "string" } },
          },
        },
        execute: async (input) => {
          if (typeof input.url === "string" && input.url.trim()) {
            try {
              const imported = await this.importSkillFromUrl(
                input.url.trim(),
                typeof input.id === "string" ? input.id : undefined
              );
              return {
                output: {
                  imported: true,
                  id: imported.id,
                  name: imported.name,
                  description: imported.description,
                  directory: imported.directory,
                },
              };
            } catch (err) {
              return { output: null, error: (err as Error).message };
            }
          }
          const name = String(input.name ?? input.id ?? "").trim();
          const content = String(input.content ?? "").trim();
          if (!name || !content) {
            return {
              output: null,
              error: "Provide either `url` or both `name` and `content` to create/import a skill.",
            };
          }
          const saved = this.saveSkill({
            id: typeof input.id === "string" ? input.id : name,
            name,
            description: typeof input.description === "string" ? input.description : undefined,
            triggers: Array.isArray(input.triggers) ? input.triggers.map(String) : undefined,
            content,
          });
          return {
            output: {
              created: true,
              id: saved.id,
              name: saved.name,
              description: saved.description,
              directory: saved.directory,
            },
          };
        },
      },
    ];
  }
}



