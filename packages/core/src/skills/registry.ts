import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import type { SkillInfo } from "@openharness/sdk";
import type { RegisteredTool } from "../agent/deps.ts";

export interface LoadedSkill extends SkillInfo {
  id: string;
  source: "builtin" | "workspace" | "user" | "remote";
  directory?: string;
  files?: string[];
}

export interface RecommendedSkillCatalogItem {
  id: string; name: string; category: "document" | "design" | "engineering"; description: string; url: string; repoUrl: string;
}

export const RECOMMENDED_REMOTE_SKILLS: RecommendedSkillCatalogItem[] = [
  { id: "anthropic-docx", name: "Word Document Craft (docx)", category: "document", description: "Word document creation, formatting, tables, and revision workflows.", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/docx/SKILL.md", repoUrl: "https://github.com/anthropics/skills/blob/main/skills/docx/SKILL.md" },
  { id: "anthropic-xlsx", name: "Spreadsheet Modeling (xlsx)", category: "document", description: "Formula-driven spreadsheet modeling, formatting, and error auditing.", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/xlsx/SKILL.md", repoUrl: "https://github.com/anthropics/skills/blob/main/skills/xlsx/SKILL.md" },
  { id: "anthropic-pdf", name: "PDF Processing & Forms", category: "document", description: "PDF generation, table extraction, merging, and form workflows.", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md", repoUrl: "https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md" },
  { id: "anthropic-pptx", name: "Slide Deck Studio", category: "document", description: "Presentation layouts, charts, notes, and visual quality checks.", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/pptx/SKILL.md", repoUrl: "https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md" },
  { id: "anthropic-canvas-design", name: "Canvas Poster & Visual Design", category: "design", description: "Posters, covers, and visual compositions in PNG and PDF.", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/canvas-design/SKILL.md", repoUrl: "https://github.com/anthropics/skills/blob/main/skills/canvas-design/SKILL.md" },
  { id: "anthropic-doc-coauthoring", name: "Collaborative Document Authoring", category: "document", description: "Context gathering, structural refinement, and reader testing.", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/doc-coauthoring/SKILL.md", repoUrl: "https://github.com/anthropics/skills/blob/main/skills/doc-coauthoring/SKILL.md" },
  { id: "superpowers-brainstorming", name: "Architecture Brainstorming", category: "engineering", description: "Design exploration and tradeoff framing before implementation.", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/brainstorming/SKILL.md", repoUrl: "https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md" },
  { id: "superpowers-writing-plans", name: "Implementation Plan Authoring", category: "engineering", description: "File-specific plans with verification steps.", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/writing-plans/SKILL.md", repoUrl: "https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md" },
  { id: "superpowers-tdd", name: "Test-Driven Development", category: "engineering", description: "A red-green-refactor workflow for regression-resistant changes.", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/test-driven-development/SKILL.md", repoUrl: "https://github.com/obra/superpowers/blob/main/skills/test-driven-development/SKILL.md" },
];

export function normalizeSkillImportUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  const match = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i);
  return match ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}` : trimmed;
}

function assertPublicHttps(url: URL): void {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  const privateIpv4 = ipv4 && (ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] === 0 || ipv4[0] === 169 && ipv4[1] === 254 || ipv4[0] === 192 && ipv4[1] === 168 || ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31);
  const privateIpv6 = isIP(host) === 6 && (/^(?:fc|fd|fe[89ab])|^::(?:ffff:)?(?:0?:)?(?:127\.|10\.|192\.168\.|169\.254\.)/i.test(host) || host === "::" || host === "::1");
  if (url.protocol !== "https:" || url.username || url.password || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || privateIpv4 || privateIpv6 || host === "169.254.169.254") {
    throw new Error("Skill import URL must use public HTTPS without credentials.");
  }
}

const studioSkillRows: Array<[string, string, string, string]> = [
  ["word-document-studio", "Word Document Studio", "docx, Word, executive document", "Create polished long-form documents with a clear hierarchy, styles, accessible tables, headers/footers, and visual page review."],
  ["excel-financial-modeler", "Excel Financial Modeler", "excel, xlsx, workbook, financial model", "Build auditable workbooks with live formulas, documented assumptions, consistent number formats, readable sheets, and a formula-error audit."],
  ["pdf-executive-publisher", "PDF Executive Publisher", "pdf, publish, executive report", "Prepare publication-ready PDFs with careful typography, page numbers, stable margins, and rendered-page inspection."],
  ["presentation-deck-designer", "Presentation Deck Designer", "pptx, slides, deck, presentation", "Design concise presentations with assertion-evidence titles, consistent visual rhythm, legible charts, speaker notes, and slide preview review."],
  ["visual-diagram-and-charting", "Visual Diagram and Charting", "chart, diagram, mermaid, infographic", "Create accurate, labeled charts and diagrams with a cohesive palette, direct annotations, and image assets sized for their final medium."],
  ["universal-doc-converter", "Universal Document Converter", "convert document, pandoc, epub, extract pdf", "Extract content from common office and PDF files, preserve tables where possible, convert through suitable local tools, and verify output."],
  ["collaborative-doc-spec", "Collaborative Document Specification", "prd, rfc, technical spec, design doc", "Author specifications with scope and constraints, architecture and contracts, decisions, and a verification matrix."],
];
const studioSkills: LoadedSkill[] = studioSkillRows.map(([id, name, triggers, body]) => ({ id, name, source: "builtin", description: body, triggers: triggers.split(", "), content: `# ${name}\n\n${body}\n\n## Workflow\n1. Inspect the workspace and identify the target audience, purpose, and constraints.\n2. Plan structure, typography, palette, and any needed visual assets before generating the artifact.\n3. Build with the available document tools and preserve editable source files where useful.\n4. Run render_document_preview, inspect every returned page and resolve layout or formula issues before delivery.` }));

export const BUILTIN_SKILLS: LoadedSkill[] = [
  ...studioSkills,
  {
    id: "agent-desktop",
    name: "agent-desktop",
    source: "builtin",
    description:
      "Computer use and semantic UI observation workflow inspired by vercel-labs/agent-desktop: snapshot accessibility trees with snapshot-qualified refs, act deterministically, and re-observe.",
    triggers: ["agent-desktop", "desktop app", "computer use", "accessibility tree", "native ui"],
    content: "# Agent Desktop & Semantic UI Observation Skill (vercel-labs/agent-desktop)\n\n## Core Observation-Action-Verification Loop\n1. **Observe First**: Capture an accessibility snapshot with element refs before acting (browser_snapshot for web apps, or agent-desktop snapshot -i when driving native OS apps).\n2. **Act on Qualified Refs**: Every element ref belongs to the snapshot it was observed in ([ref=eN] in web snapshots or @snapshot_id:eN in agent-desktop). Never guess coordinates when an accessibility ref is available.\n3. **Re-Observe After Every State Change**: After clicking, typing, or navigating, always take a fresh snapshot to verify the UI transition and obtain updated refs before the next action.\n4. **Human Takeover When Blocked**: When login, 2FA, CAPTCHA, or subjective visual inspection is required, call request_takeover with clear instructions so the user can interact directly in the Live Browser dock and return control.",
  },
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
      "Claude/Linear/Stripe-grade UI/UX design system guidelines for modern typography, refined neutral surfaces, accessible forms, and polished interactive components.",
    triggers: ["ui design", "styling", "css", "landing page", "component design", "ux", "checkout", "dashboard", "web app"],
    content: `# Frontend Design & UI Craft Skill (Claude / Linear / Stripe Standard)

## Core Aesthetic & Layout Principles
1. **Refined Neutral Surfaces & Crisp Borders**:
   - Use warm alabaster/off-white (\`#fcfcfa\` / \`#f4f3ee\`) or deep slate/obsidian (\`#111318\` / \`#181b22\`) surfaces with subtle \`1px solid\` borders (\`rgba(0,0,0,0.08)\` or \`rgba(255,255,255,0.08)\`) and soft shadows (\`0 4px 20px rgba(0,0,0,0.06)\`).
   - Avoid harsh neon gradients, clashing primary colors, or raw unstyled HTML boxes.
2. **Typography & Spacing**:
   - Use \`Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif\` with tight heading tracking (\`-0.02em\`), comfortable body line-height (\`1.55\`), and a consistent \`8px\` / \`12px\` / \`16px\` / \`24px\` spacing scale.
3. **Clean User-Facing Surfaces (No Raw Debug Dumps)**:
   - Never dump raw JSON \`<pre>\` debug state onto the primary user interface unless explicitly requested; use clean summary cards, badges, or a collapsible developer drawer.
4. **Testable, Accessible Forms & Controls**:
   - Always pair every \`<input>\`, \`<select>\`, and \`<textarea>\` with a stable \`id\`, \`name\`, \`placeholder\`, and an explicit \`<label for="...">\` so both human users and automated browser checks (\`browser_check_def\`) can target fields reliably.
   - Give primary action buttons clear, unique IDs and descriptive text labels.`,
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

    const targetDir = this.dataDir
      ? path.join(this.dataDir, "skills", rawId)
      : path.join(this.workspaceRoot, ".openharness", "skills", rawId);
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
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "SKILL.md"), md, "utf8");
    const workspaceMirror = path.join(this.workspaceRoot, ".openharness", "skills", rawId);
    if (path.resolve(workspaceMirror) !== path.resolve(targetDir)) {
      try {
        fs.mkdirSync(workspaceMirror, { recursive: true });
        fs.writeFileSync(path.join(workspaceMirror, "SKILL.md"), md, "utf8");
      } catch { /* Persistent dataDir copy remains authoritative. */ }
    }

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
    try { parsedUrl = new URL(normalizeSkillImportUrl(url)); assertPublicHttps(parsedUrl); }
    catch (err) { throw new Error((err as Error).message || "Skill import URL is invalid."); }
    let resp: Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects++) {
      resp = await fetch(parsedUrl, { redirect: "manual", headers: { "User-Agent": "OpenHarness-SkillImporter/1.0" }, signal: AbortSignal.timeout(15_000) });
      if (![301, 302, 303, 307, 308].includes(resp.status)) break;
      if (redirects === 3) throw new Error("Skill import exceeded the redirect limit.");
      const location = resp.headers.get("location");
      if (!location) throw new Error("Skill import redirect did not include a destination.");
      parsedUrl = new URL(location, parsedUrl);
      assertPublicHttps(parsedUrl);
    }
    if (!resp) throw new Error("Skill fetch failed.");
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
        source: "skill",
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
        source: "skill",
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
        source: "skill",
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



