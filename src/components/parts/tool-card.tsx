import { useId, useState } from "react";
import {
  ChevronRight,
  Clock,
  Compass,
  Eye,
  FilePen,
  FilePlus2,
  FileText,
  FolderTree,
  ListTodo,
  Search,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import type { ToolPart } from "@openharness/sdk";
import { client } from "@/lib/client";
import { formatDuration, stringify } from "@/lib/format";
import { CopyButton } from "../copy-button";
import { Badge, Spinner } from "../ui";

function getToolIcon(toolName: string) {
  const lower = toolName.toLowerCase();
  if (lower.includes("read")) return FileText;
  if (lower.includes("write")) return FilePlus2;
  if (lower.includes("edit") || lower.includes("patch")) return FilePen;
  if (lower.includes("list") || lower.includes("ls") || lower.includes("tree"))
    return FolderTree;
  if (lower.includes("glob") || lower.includes("grep") || lower.includes("search"))
    return Search;
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("exec"))
    return TerminalSquare;
  if (lower.includes("web") || lower.includes("fetch") || lower.includes("http"))
    return Compass;
  if (lower.includes("inspect") || lower.includes("view")) return Eye;
  if (lower.includes("plan") || lower.includes("todo") || lower.includes("task"))
    return ListTodo;
  if (lower.includes("wait")) return Clock;
  return Wrench;
}

function formatToolLabel(toolName: string): string {
  if (toolName.includes("__")) {
    const [server, tool] = toolName.split("__");
    if (server && tool) return `${server} · ${tool}`;
  }
  return toolName;
}

function getToolSummary(part: ToolPart): string {
  const input = (part.input ?? {}) as Record<string, unknown>;
  const meta = (part.metadata ?? {}) as Record<string, unknown>;
  if (part.tool === "run_code" && typeof input.description === "string") {
    return input.description;
  }
  if (part.title) return part.title;
  for (const key of [
    "description",
    "path",
    "file_path",
    "command",
    "pattern",
    "query",
    "url",
    "name",
  ]) {
    if (typeof input[key] === "string" && input[key]) {
      return String(input[key]);
    }
  }
  if (typeof meta.url === "string") return meta.url;
  return "";
}

export function ToolCard({
  part,
  needsApproval = false,
}: {
  part: ToolPart;
  needsApproval?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const Icon = getToolIcon(part.tool);
  const label = formatToolLabel(part.tool);
  const summary = getToolSummary(part);

  const meta = (part.metadata ?? {}) as Record<string, unknown>;
  const modelBadge = typeof meta.model === "string"
    ? meta.model === "sam-3.1" ? "SAM 3.1" : meta.model === "muse-image-1.0" ? "Muse Image 1.0" : meta.model
    : undefined;
  const providerLabel = typeof meta.providerLabel === "string" ? meta.providerLabel : undefined;
  const artifacts = Array.isArray(meta.artifacts) ? meta.artifacts as Array<{ path: string; mimeType?: string; size?: number; kind?: string }> : [];
  const input = (part.input ?? {}) as Record<string, unknown>;

  const durationMs =
    typeof part.startedAt === "number" && typeof part.endedAt === "number"
      ? part.endedAt - part.startedAt
      : typeof meta.durationMs === "number"
        ? meta.durationMs
        : undefined;

  const exitCode =
    typeof meta.exitCode === "number" ? meta.exitCode : undefined;

  const isRunning = part.state === "pending" || part.state === "running";
  const isError = part.state === "error";
  const isDenied = part.state === "denied";

  const borderCls = isError
    ? "border-danger/35"
    : isDenied || needsApproval
      ? "border-warning/35"
      : "border-border";

  const diffBefore =
    typeof meta.diff_before === "string" ? meta.diff_before : undefined;
  const diffAfter =
    typeof meta.diff_after === "string" ? meta.diff_after : undefined;
  const preview =
    typeof meta.preview === "string" ? meta.preview : undefined;
  const savedPath =
    typeof meta.outputPath === "string" ? meta.outputPath : undefined;
  const calls = Array.isArray(meta.calls)
    ? (meta.calls as Array<{ tool?: string; state?: string; error?: string }>)
    : [];
  const rawCode =
    part.tool === "run_code" && typeof input.code === "string"
      ? input.code
      : undefined;
  const safeUrl =
    typeof meta.url === "string" && /^https?:\/\//i.test(meta.url)
      ? meta.url
      : typeof input.url === "string" && /^https?:\/\//i.test(input.url)
        ? input.url
        : undefined;
  const output = part.output && typeof part.output === "object" && !Array.isArray(part.output) ? part.output as Record<string, unknown> : {};
  const candidatePath = [input.path, input.output_path, input.outputPath, output.path, output.outputPath].find((value): value is string => typeof value === "string" && /\.(pdf|docx|xlsx|pptx|epub|csv|png|jpe?g|svg)$/i.test(value));
  const sessionId = typeof window !== "undefined" ? decodeURIComponent(window.location.pathname.match(/^\/c\/([^/]+)/)?.[1] ?? "") : "";
  const previewPages = part.tool === "render_document_preview" && Array.isArray(output.pages) ? output.pages.filter((page): page is Record<string, unknown> => Boolean(page && typeof page === "object" && !Array.isArray(page))).slice(0, 4) : [];
  const displayOutput = part.tool === "render_document_preview" && Array.isArray(output.pages)
    ? { ...output, pages: previewPages.map(({ page, mimeType }) => ({ page, mimeType, screenshotAttached: true })) }
    : part.output;

  return (
    <div
      className={`my-2 overflow-hidden rounded-xl border ${borderCls} bg-elev text-xs transition-colors duration-150 ease-out`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="touch-target flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-150 ease-out hover:bg-hover/60"
      >
        <ChevronRight
          className={`size-3.5 shrink-0 text-muted transition-transform duration-150 ease-out ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden="true"
        />
        <Icon className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
        <span className="font-medium text-fg shrink-0">{label}</span>
        {(modelBadge || providerLabel) && <span className="shrink-0 rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-accent" title={providerLabel}>{modelBadge ?? providerLabel}</span>}
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
            {summary}
          </span>
        )}
        {!summary && <span className="flex-1" />}

        {exitCode !== undefined && exitCode !== 0 && (
          <Badge tone="danger">exit {exitCode}</Badge>
        )}

        {durationMs !== undefined && durationMs >= 10 && (
          <span className="font-mono text-xs text-muted">
            {formatDuration(durationMs)}
          </span>
        )}

        {needsApproval ? (
          <Badge tone="warning">Needs approval</Badge>
        ) : isRunning ? (
          <Badge tone="accent">
            <Spinner className="size-3" />
            <span>{part.state === "pending" ? "Pending" : "Running"}</span>
          </Badge>
        ) : part.state === "completed" ? (
          <Badge tone="success">Done</Badge>
        ) : isError ? (
          <Badge tone="danger">Error</Badge>
        ) : isDenied ? (
          <Badge tone="warning">Denied</Badge>
        ) : null}
      </button>

      {part.state === "completed" && candidatePath && sessionId && (
        <div className="flex flex-wrap gap-2 border-t border-border bg-bg/50 px-3 py-2"><button type="button" onClick={() => window.dispatchEvent(new CustomEvent("oh:open-artifact", { detail: { path: candidatePath } }))} className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-code px-3 py-1.5 font-mono text-[11px] text-accent hover:bg-hover">Open in Studio · {candidatePath.split(/[\\/]/).at(-1)}</button><a href={client.session.fileRawUrl(sessionId, candidatePath, { download: true })} download className="inline-flex items-center gap-2 rounded-full border border-border bg-code px-3 py-1.5 font-mono text-[11px] text-muted hover:bg-hover">Download</a></div>
      )}

      {part.state === "completed" && artifacts.length > 0 && sessionId && <div className="flex flex-wrap gap-2 border-t border-border bg-bg/50 p-3">{artifacts.map((artifact) => <div key={artifact.path} className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-elev px-2 py-1.5 text-[11px] text-accent">{artifact.mimeType?.startsWith("image/") && <img src={client.session.fileRawUrl(sessionId, artifact.path)} alt="" className="size-10 rounded object-cover" />}<button type="button" onClick={() => window.dispatchEvent(new CustomEvent("oh:open-artifact", { detail: { path: artifact.path } }))} className="max-w-56 truncate text-left" title={artifact.path}>{artifact.path}</button><span className="text-muted">Open in Studio</span><a href={client.session.fileRawUrl(sessionId, artifact.path, { download: true })} download aria-label={`Download ${artifact.path}`} title="Download" className="rounded p-1 text-muted hover:bg-hover hover:text-accent">↓</a></div>)}</div>}

      {isError && <div className="border-t border-border bg-bg/50 px-3 py-2"><button type="button" onClick={() => window.dispatchEvent(new CustomEvent("oh:try-fix", { detail: { prompt: `The tool ${part.tool} failed. Diagnose and fix the underlying issue.\nError: ${part.error ?? "unknown error"}\nInput: ${stringify(part.input)}` } }))} className="rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-accent hover:bg-hover">Try fixing</button></div>}

      {previewPages.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-t border-border bg-bg/50 p-3">{previewPages.map((page, index) => typeof page.dataBase64 === "string" && typeof page.mimeType === "string" ? <img key={String(page.page ?? index)} src={`data:${page.mimeType};base64,${page.dataBase64}`} alt={`Document page ${page.page ?? index + 1}`} className="h-28 rounded border border-border object-contain" /> : null)}</div>
      )}

      {!open && isRunning && preview && (
        <div className="border-t border-border bg-bg/50 px-3 py-2 font-mono text-xs text-muted truncate">
          {preview}
        </div>
      )}

      {!open && isRunning && part.tool === "run_code" && calls.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-t border-border bg-bg/50 px-3 py-2">
          {calls.slice(-4).map((c, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-1 rounded border border-border bg-code px-2 py-0.5 font-mono text-xs"
            >
              <span>{c.tool || "call"}</span>
              {c.state === "error" && (
                <span className="text-danger">failed</span>
              )}
            </span>
          ))}
          {calls.length > 4 && (
            <span className="text-xs text-muted">
              +{calls.length - 4} earlier
            </span>
          )}
        </div>
      )}

      {!open && (isError || isDenied) && part.error && (
        <div
          className={`border-t border-border bg-bg/50 px-3 py-2 text-xs line-clamp-2 ${
            isError ? "text-danger" : "text-warning"
          }`}
        >
          {part.error}
        </div>
      )}

      {open && (
        <div
          id={bodyId}
          className="divide-y divide-border border-t border-border bg-bg text-xs"
        >
          {safeUrl && (
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="text-muted">URL:</span>
              <a
                href={safeUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="truncate font-mono text-accent underline"
              >
                {safeUrl}
              </a>
            </div>
          )}

          {rawCode && (
            <div className="p-3">
              <div className="mb-2 flex items-center justify-between text-xs text-muted">
                <span className="font-medium">Code (TypeScript)</span>
                <CopyButton text={rawCode} label="Copy code" />
              </div>
              <pre className="max-h-80 overflow-auto rounded-lg bg-code p-3 font-mono text-xs text-fg">
                {rawCode}
              </pre>
            </div>
          )}

          {calls.length > 0 && (
            <div className="p-3">
              <div className="mb-2 text-xs font-medium text-muted">
                Tool calls ({calls.length})
                {calls.filter((c) => c.state === "error").length > 0 &&
                  ` · ${calls.filter((c) => c.state === "error").length} failed`}
              </div>
              <div className="flex flex-wrap gap-2">
                {calls.slice(-4).map((c, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 rounded border border-border bg-code px-2 py-0.5 font-mono text-xs"
                  >
                    <span>{c.tool || "call"}</span>
                    {c.state === "error" && (
                      <span className="text-danger">failed</span>
                    )}
                  </span>
                ))}
                {calls.length > 4 && (
                  <span className="text-xs text-muted">
                    +{calls.length - 4} earlier
                  </span>
                )}
              </div>
            </div>
          )}

          {diffBefore !== undefined && diffAfter !== undefined ? (
            <div className="p-3">
              <div className="mb-2 text-xs font-medium text-muted">Changes</div>
              <div className="max-h-80 overflow-auto rounded-lg bg-code p-3 font-mono text-xs">
                {diffBefore
                  .split("\n")
                  .map((line, i) => (
                    <div key={`b-${i}`} className="bg-danger/10 px-1 text-danger">
                      - {line}
                    </div>
                  ))}
                {diffAfter
                  .split("\n")
                  .map((line, i) => (
                    <div key={`a-${i}`} className="bg-success/10 px-1 text-success">
                      + {line}
                    </div>
                  ))}
              </div>
            </div>
          ) : (
            !rawCode &&
            part.input !== undefined && (
              <div className="p-3">
                <div className="mb-2 flex items-center justify-between text-xs text-muted">
                  <span className="font-medium">Input</span>
                  <CopyButton text={stringify(part.input)} label="Copy" />
                </div>
                <pre className="max-h-80 overflow-auto rounded-lg bg-code p-3 font-mono text-xs text-fg whitespace-pre-wrap">
                  {stringify(part.input)}
                </pre>
              </div>
            )
          )}

          {displayOutput !== undefined && displayOutput !== "" && (
            <div className="p-3">
              <div className="mb-2 flex items-center justify-between text-xs text-muted">
                <span className="font-medium">Output</span>
                  {part.tool !== "render_document_preview" && <CopyButton text={stringify(displayOutput)} label="Copy" />}
              </div>
              <pre className="max-h-80 overflow-auto rounded-lg bg-code p-3 font-mono text-xs text-fg whitespace-pre-wrap">
                {stringify(displayOutput)}
              </pre>
            </div>
          )}

          {part.error && (
            <div className="p-3">
              <div className="mb-2 flex items-center justify-between text-xs text-danger">
                <span className="font-medium">
                  {isDenied ? "Denied" : "Error"}
                </span>
                <CopyButton text={part.error} label="Copy" />
              </div>
              <pre className="max-h-80 overflow-auto rounded-lg bg-danger/10 p-3 font-mono text-xs text-danger whitespace-pre-wrap">
                {part.error}
              </pre>
            </div>
          )}

          {savedPath && (
            <p className="px-3 py-2 font-mono text-xs text-muted">
              Full output saved to {savedPath}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
