import { useId, useState } from "react";
import { Archive, ChevronDown } from "lucide-react";
import type { CompactionPart } from "@openharness/sdk";
import { formatTokens } from "@/lib/format";
import { Markdown } from "../markdown";
import { Badge } from "../ui";

function reasonLabel(reason?: string): string {
  switch (reason) {
    case "tokens":
      return "auto · context limit";
    case "messages":
      return "auto · message limit";
    case "manual":
      return "manual";
    case "overflow":
      return "context overflow recovery";
    default:
      return reason || "compacted";
  }
}

export function CompactionDivider({ part }: { part: CompactionPart }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const savedTokens =
    part.tokensBefore !== undefined &&
    part.tokensAfter !== undefined &&
    part.tokensBefore > part.tokensAfter
      ? part.tokensBefore - part.tokensAfter
      : null;

  return (
    <div className="my-4">
      <div className="relative flex items-center justify-center">
        <div className="absolute inset-x-0 top-1/2 border-t border-border" />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={panelId}
          className="touch-target relative z-10 inline-flex flex-wrap items-center gap-2 rounded-full border border-border bg-elev px-3 py-1 text-xs text-fg transition-colors duration-150 ease-out hover:bg-hover"
        >
          <Archive className="size-3.5 text-accent" aria-hidden="true" />
          <span>Context compacted: {part.compactedMessages} messages</span>
          <Badge tone="neutral">{reasonLabel(part.reason)}</Badge>
          {savedTokens !== null && (
            <span className="font-mono text-xs font-medium text-success">
              -{formatTokens(savedTokens)} tokens saved
            </span>
          )}
          <ChevronDown
            className={`size-3.5 text-muted transition-transform duration-150 ease-out ${
              open ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          />
        </button>
      </div>

      {open && (
        <div
          id={panelId}
          className="mt-2 rounded-xl border border-border bg-elev p-4 text-xs animate-fade-in"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span className="font-medium">
              Summary the agent sees in place of older messages
            </span>
            {(part.tokensBefore !== undefined ||
              part.keptMessages !== undefined) && (
              <span className="font-mono">
                {part.tokensBefore !== undefined &&
                  part.tokensAfter !== undefined &&
                  `Estimated context: ${formatTokens(part.tokensBefore)} -> ${formatTokens(part.tokensAfter)} tokens`}
                {part.keptMessages !== undefined &&
                  ` · ${part.keptMessages} leading messages kept verbatim`}
              </span>
            )}
          </div>
          {part.summary ? (
            <Markdown className="text-sm">{part.summary}</Markdown>
          ) : (
            <p className="italic text-muted">No summary text recorded.</p>
          )}
        </div>
      )}
    </div>
  );
}
