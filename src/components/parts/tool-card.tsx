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

          {part.output !== undefined && part.output !== "" && (
            <div className="p-3">
              <div className="mb-2 flex items-center justify-between text-xs text-muted">
                <span className="font-medium">Output</span>
                <CopyButton text={stringify(part.output)} label="Copy" />
              </div>
              <pre className="max-h-80 overflow-auto rounded-lg bg-code p-3 font-mono text-xs text-fg whitespace-pre-wrap">
                {stringify(part.output)}
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
