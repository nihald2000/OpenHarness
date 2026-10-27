"use client";

import React, { useId, useState } from "react";
import {
  ChevronDown,
  ClipboardCheck,
  ListChecks,
  PencilLine,
  Play,
} from "lucide-react";
import { planProgress, type PlanData } from "@openharness/sdk";
import { PlanProgressBar, PlanSteps } from "./parts/plan-card";
import { Spinner } from "./ui";

export function PlanDock({
  plan,
  mode,
  busy = false,
  onApprove,
  onRevise,
}: {
  plan: PlanData;
  mode: "approval" | "progress";
  busy?: boolean;
  onApprove?: () => void;
  onRevise?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const prog = planProgress(plan);

  if (mode === "approval") {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 pb-2 animate-fade-in">
        <div className="overflow-hidden rounded-xl border border-accent/40 bg-elev shadow-lg shadow-black/20">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls={panelId}
              className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
            >
              <ClipboardCheck
                className="size-4 shrink-0 text-accent"
                aria-hidden="true"
              />
              <span className="font-semibold text-fg">
                Plan ready · {prog.total} {prog.total === 1 ? "step" : "steps"}
              </span>
              {plan.title && (
                <span className="truncate text-muted">— {plan.title}</span>
              )}
              <ChevronDown
                className={`ml-auto size-3.5 shrink-0 text-muted transition-transform ${
                  open ? "rotate-180" : ""
                }`}
                aria-hidden="true"
              />
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={onRevise}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-subtle px-2.5 text-xs font-medium text-fg transition-colors hover:bg-hover disabled:opacity-40"
              >
                <PencilLine className="size-3.5" aria-hidden="true" />
                <span>Revise</span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onApprove}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-strong disabled:opacity-40"
              >
                {busy ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <Play className="size-3.5 fill-current" aria-hidden="true" />
                )}
                <span>Approve &amp; build</span>
              </button>
            </div>
          </div>

          {open && (
            <div
              id={panelId}
              className="max-h-44 overflow-y-auto border-t border-border px-3.5 py-2.5"
            >
              <PlanSteps steps={plan.steps} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2 animate-fade-in">
      <div className="overflow-hidden rounded-xl border border-border bg-elev">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-xs hover:bg-hover/60"
        >
          <ListChecks
            className="size-4 shrink-0 text-accent"
            aria-hidden="true"
          />
          <span className="font-medium text-fg truncate">
            {prog.current ? prog.current.title : plan.title || "Plan"}
          </span>
          <span className="ml-auto font-mono text-[11px] text-muted shrink-0">
            {prog.completed}/{prog.total}
          </span>
          <div className="hidden sm:block w-16 shrink-0">
            <PlanProgressBar
              completed={prog.completed}
              total={prog.total}
              decorative
            />
          </div>
          <ChevronDown
            className={`size-3.5 shrink-0 text-muted transition-transform ${
              open ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          />
        </button>

        {!open && (
          <div className="sm:hidden">
            <PlanProgressBar
              completed={prog.completed}
              total={prog.total}
              decorative
              className="h-0.5 rounded-none"
            />
          </div>
        )}

        {open && (
          <div
            id={panelId}
            className="max-h-44 overflow-y-auto border-t border-border px-3.5 py-2.5"
          >
            <PlanSteps steps={plan.steps} live />
          </div>
        )}
      </div>
    </div>
  );
}
