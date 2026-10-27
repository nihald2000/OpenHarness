"use client";

import React, { useId, useState } from "react";
import { CheckCircle2, ChevronDown, Wrench, XCircle } from "lucide-react";
import type { VerifyPart } from "@openharness/sdk";
import { formatDuration } from "@/lib/format";
import { CopyButton } from "../copy-button";
import { Badge } from "../ui";

export function VerifyCard({ part }: { part: VerifyPart }) {
  const [open, setOpen] = useState(!part.passed);
  const outputId = useId();
  const borderCls = part.passed ? "border-success/40" : "border-danger/40";

  return (
    <div
      id={`verify-${part.iteration}`}
      className={`my-2 rounded-xl border ${borderCls} bg-elev p-3 text-xs`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
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
        <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase text-muted">
          <Wrench className="size-3.5" aria-hidden="true" />
          <span>
            ATTEMPT {part.iteration}
            {part.maxIterations ? `/${part.maxIterations}` : ""}
          </span>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-code px-2.5 py-1.5 font-mono text-[11px]">
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
        <div className="mt-2">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls={outputId}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted hover:text-fg"
            >
              <ChevronDown
                className={`size-3.5 transition-transform ${
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
              className="mt-1.5 max-h-72 overflow-auto rounded-lg border border-border bg-code p-2.5 font-mono text-[11px] leading-relaxed text-fg whitespace-pre-wrap"
            >
              {part.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
