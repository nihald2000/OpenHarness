import { useId, useState } from "react";
import { CheckCircle2, ChevronDown, Wrench, XCircle } from "lucide-react";
import type { VerifyPart } from "@openharness/sdk";
import { formatDuration } from "@/lib/format";
import { CopyButton } from "../copy-button";
import { Badge } from "../ui";

export function VerifyCard({ part }: { part: VerifyPart }) {
  const [open, setOpen] = useState(!part.passed);
  const outputId = useId();
  const borderCls = part.passed ? "border-success/35" : "border-danger/35";

  return (
    <div
      id={`verify-${part.iteration}`}
      className={`my-2 overflow-hidden rounded-xl border ${borderCls} bg-elev text-xs`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          {part.passed ? (
            <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
          ) : (
            <XCircle className="size-4 text-danger" aria-hidden="true" />
          )}
          <span className="font-semibold text-fg">{part.name || "Verify"}</span>
          <Badge tone={part.passed ? "success" : "danger"}>
            {part.passed ? "Passed" : "Failed"}
          </Badge>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs uppercase text-muted">
          <Wrench className="size-3.5" aria-hidden="true" />
          <span>
            ATTEMPT {part.iteration}
            {part.maxIterations ? `/${part.maxIterations}` : ""}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-code px-3 py-2 font-mono text-xs">
        <span className="truncate text-fg">$ {part.command}</span>
        <div className="flex items-center gap-2 text-muted">
          <span className={part.exitCode === 0 ? "text-success" : "text-danger"}>
            Exit {part.exitCode}
          </span>
          {part.durationMs !== undefined && (
            <>
              <span>·</span>
              <span>{formatDuration(part.durationMs)}</span>
            </>
          )}
        </div>
      </div>

      {part.output && (
        <div className="border-t border-border bg-bg">
          <div className="flex items-center justify-between px-3 py-2">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls={outputId}
              className="touch-target inline-flex items-center gap-1 text-xs font-medium text-muted transition-colors duration-150 ease-out hover:text-fg"
            >
              <ChevronDown
                className={`size-3.5 transition-transform duration-150 ease-out ${
                  open ? "rotate-180" : ""
                }`}
                aria-hidden="true"
              />
              <span>{open ? "Hide output" : "Show output"}</span>
            </button>
            {open && <CopyButton text={part.output} label="Copy" />}
          </div>
          {open && (
            <pre
              id={outputId}
              className="max-h-72 overflow-auto border-t border-border bg-code p-3 font-mono text-xs leading-normal text-fg whitespace-pre-wrap"
            >
              {part.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
