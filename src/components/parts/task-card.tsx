import { useId, useState } from "react";
import { Bot, ChevronDown, ExternalLink } from "lucide-react";
import type { ToolPart } from "@openharness/sdk";
import { Link } from "@/lib/router";
import { useCatalog } from "@/lib/hooks";
import { useSession } from "@/lib/use-session";
import { Markdown } from "../markdown";
import { MessageList } from "../message-row";
import { Badge, Spinner, StatusDot } from "../ui";

function stripTaskMetadata(text: string): string {
  return text.replace(/<task_metadata>[\s\S]*?<\/task_metadata>/gi, "").trim();
}

function SubagentInlineTranscript({
  childSessionId,
  depth,
}: {
  childSessionId: string;
  depth: number;
}) {
  const { session, messages, loading } = useSession(childSessionId);

  return (
    <div className="border-t border-border bg-bg">
      <div className="flex items-center justify-between border-b border-border bg-elev/60 px-3 py-2 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <StatusDot status={session?.status ?? "idle"} />
          <span className="truncate font-medium text-fg">
            {session?.title || "Subagent session"}
          </span>
        </div>
        <span className="font-mono text-xs text-muted">{childSessionId}</span>
      </div>
      <div className="max-h-[32rem] overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted">
            <Spinner />
            <span>Loading subagent session...</span>
          </div>
        ) : messages.length === 0 ? (
          <p className="py-2 text-xs text-muted">No messages yet.</p>
        ) : (
          <MessageList
            messages={messages}
            active={
              session?.status === "running" ||
              session?.status === "queued" ||
              session?.status === "awaiting_permission"
            }
            compact
            depth={depth + 1}
          />
        )}
      </div>
    </div>
  );
}

export function TaskCard({
  part,
  depth = 0,
}: {
  part: ToolPart;
  depth?: number;
}) {
  const [showChild, setShowChild] = useState(false);
  const childPanelId = useId();
  const { agents } = useCatalog();

  const input = (part.input ?? {}) as Record<string, unknown>;
  const meta = (part.metadata ?? {}) as Record<string, unknown>;

  const subagentName =
    (typeof input.subagent_type === "string" && input.subagent_type) ||
    (typeof input.agent === "string" && input.agent) ||
    "subagent";
  const description =
    typeof input.description === "string"
      ? input.description
      : part.title || "Delegated task";
  const promptText =
    typeof input.prompt === "string" ? input.prompt : undefined;
  const childSessionId =
    typeof meta.childSessionId === "string"
      ? meta.childSessionId
      : typeof meta.sessionId === "string"
        ? meta.sessionId
        : undefined;

  const agentInfo = agents.find((a) => a.name === subagentName);
  const dotColor = agentInfo?.color || "var(--accent)";

  const isRunning = part.state === "pending" || part.state === "running";
  const isError = part.state === "error";
  const isDenied = part.state === "denied";

  const cleanOutput =
    typeof part.output === "string" ? stripTaskMetadata(part.output) : "";

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border bg-elev text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-bg px-2 py-0.5 text-xs font-medium text-fg">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: dotColor }}
              aria-hidden="true"
            />
            <Bot className="size-3 text-muted" aria-hidden="true" />
            <span>{subagentName}</span>
          </span>
          <span className="truncate font-medium text-fg">{description}</span>
        </div>

        <div className="flex items-center gap-2">
          {isRunning ? (
            <Badge tone="accent">
              <Spinner className="size-3" />
              <span>Running</span>
            </Badge>
          ) : part.state === "completed" ? (
            <Badge tone="success">Done</Badge>
          ) : isError ? (
            <Badge tone="danger">Error</Badge>
          ) : isDenied ? (
            <Badge tone="warning">Denied</Badge>
          ) : null}
        </div>
      </div>

      {promptText && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted line-clamp-2">
          {promptText}
        </p>
      )}

      {cleanOutput && part.state === "completed" && (
        <div className="border-t border-border bg-bg p-3">
          <Markdown className="text-sm">{cleanOutput}</Markdown>
        </div>
      )}

      {part.error && (
        <div className="border-t border-border bg-danger/10 px-3 py-2 text-xs text-danger">
          {part.error}
        </div>
      )}

      {childSessionId && depth < 3 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={() => setShowChild((s) => !s)}
            aria-expanded={showChild}
            aria-controls={childPanelId}
            className="touch-target inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            {isRunning && <Spinner className="size-3" />}
            <ChevronDown
              className={`size-3.5 transition-transform duration-150 ease-out ${
                showChild ? "rotate-180" : ""
              }`}
              aria-hidden="true"
            />
            <span>
              {showChild ? "Hide subagent session" : "Show subagent session"}
            </span>
          </button>

          <Link
            href={`/c/${encodeURIComponent(childSessionId)}`}
            aria-label="Open subagent session"
            title="Open subagent session"
            className="touch-target inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg"
          >
            <span>Open</span>
            <ExternalLink className="size-3" aria-hidden="true" />
          </Link>
        </div>
      )}

      {childSessionId && depth < 3 && showChild && (
        <div id={childPanelId}>
          <SubagentInlineTranscript
            childSessionId={childSessionId}
            depth={depth}
          />
        </div>
      )}
    </div>
  );
}
