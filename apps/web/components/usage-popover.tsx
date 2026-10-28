"use client";

import React, { useEffect, useRef, useState } from "react";
import { Coins } from "lucide-react";
import type { ContextUsage, Session } from "@openharness/sdk";
import {
  formatCost,
  formatTokens,
  isActive,
  totalTokens,
} from "@/lib/format";
import { Badge } from "./ui";

export function UsagePopover({
  session,
  contextUsage,
  contextError,
  contextLoading,
  onOpen,
  onCompact,
  compacting,
}: {
  session: Session;
  contextUsage: ContextUsage | null;
  contextError: string | null;
  contextLoading: boolean;
  onOpen: () => void;
  onCompact: () => void;
  compacting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const tok = totalTokens(session.usage);
  const active = isActive(session.status) || compacting;

  const estimated = contextUsage?.estimatedTokens ?? 0;
  const windowSize = contextUsage?.contextWindow ?? 0;
  const rawTriggerAt = contextUsage?.triggerAt ?? 0.8;
  // Servers may report the trigger either as a ratio (0.75) or as an
  // absolute token count (e.g. 102400). Normalize to a ratio.
  const triggerAt =
    rawTriggerAt > 1
      ? windowSize > 0
        ? rawTriggerAt / windowSize
        : 0.8
      : rawTriggerAt;
  const warnAt = Math.min(0.8, triggerAt) - 0.15;
  const fillRatio = windowSize > 0 ? estimated / windowSize : 0;
  const fillPct = Math.min(100, Math.round(fillRatio * 100));
  const triggerPct = Math.round(triggerAt * 100);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const handleClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      onOpen();
    }
  };

  const barColor =
    fillRatio >= triggerAt
      ? "bg-danger"
      : fillRatio >= warnAt
        ? "bg-warning"
        : "bg-accent";

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Session token usage and context window"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-elev px-2.5 text-xs font-mono text-fg transition-colors hover:bg-hover"
      >
        <Coins className="size-3.5 text-muted" aria-hidden="true" />
        <span>{formatTokens(tok)} tok</span>
        {session.cost !== undefined && session.cost > 0 && (
          <span className="hidden md:inline text-muted">
            · {formatCost(session.cost)}
          </span>
        )}
        {windowSize > 0 && (
          <Badge
            tone={
              fillRatio >= triggerAt
                ? "danger"
                : fillRatio >= warnAt
                  ? "warning"
                  : "neutral"
            }
            className="md:hidden"
          >
            {fillPct}%
          </Badge>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Usage and context window"
          className="absolute right-0 top-full z-40 mt-1.5 w-72 rounded-xl border border-border bg-elev p-3 text-xs shadow-xl shadow-black/25 animate-fade-in"
        >
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
            Usage
          </div>
          <dl className="space-y-1 text-xs">
            <div className="flex justify-between">
              <dt className="text-muted">Input tokens</dt>
              <dd className="font-mono tabular-nums text-fg">
                {formatTokens(session.usage?.input ?? 0)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Output tokens</dt>
              <dd className="font-mono tabular-nums text-fg">
                {formatTokens(session.usage?.output ?? 0)}
              </dd>
            </div>
            {(session.usage?.reasoning ?? 0) > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">Reasoning</dt>
                <dd className="font-mono tabular-nums text-fg">
                  {formatTokens(session.usage?.reasoning)}
                </dd>
              </div>
            )}
            {(session.usage?.cacheRead ?? 0) > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">Cache read</dt>
                <dd className="font-mono tabular-nums text-fg">
                  {formatTokens(session.usage?.cacheRead)}
                </dd>
              </div>
            )}
            <div className="flex justify-between pt-1 border-t border-border/60">
              <dt className="text-muted">Total cost</dt>
              <dd className="font-mono tabular-nums font-medium text-fg">
                {formatCost(session.cost)}
              </dd>
            </div>
          </dl>

          <div className="my-3 border-t border-border" />

          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
            CONTEXT WINDOW
          </div>

          {contextError ? (
            <p className="text-xs text-danger">
              Could not load context: {contextError}
            </p>
          ) : contextLoading && !contextUsage ? (
            <p className="text-xs text-muted">Loading...</p>
          ) : contextUsage && windowSize > 0 ? (
            <div className="space-y-2">
              <div
                role="progressbar"
                aria-valuenow={fillPct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Context window usage"
                className="relative h-2 w-full overflow-hidden rounded-full bg-subtle"
              >
                <div
                  className={`h-full rounded-full ${barColor} transition-all`}
                  style={{ width: `${Math.max(1, fillPct)}%` }}
                />
                <div
                  title={`Auto-compaction at ${triggerPct}%`}
                  className="absolute top-0 bottom-0 w-px bg-fg/60"
                  style={{ left: `${triggerPct}%` }}
                />
              </div>

              <div className="font-mono text-[11px] text-fg">
                {fillPct}% full · {formatTokens(estimated)} of{" "}
                {formatTokens(windowSize)} tokens
              </div>
              <div className="text-[11px] text-muted">
                {contextUsage.messages ?? 0} messages ·{" "}
                {contextUsage.compactions ?? 0} compactions · auto at{" "}
                {triggerPct}%
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted">No data yet</p>
          )}

          <button
            type="button"
            disabled={active}
            title={active ? "Wait for the agent to finish" : "Compact context"}
            onClick={() => {
              onCompact();
              setOpen(false);
            }}
            className="mt-3 flex h-8 w-full items-center justify-center rounded-lg border border-border bg-subtle px-3 text-xs font-medium text-fg transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-40"
          >
            Compact context
          </button>
        </div>
      )}
    </div>
  );
}
