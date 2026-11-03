import { useId, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  ListChecks,
} from "lucide-react";
import {
  planProgress,
  type PlanData,
  type PlanStep,
  type ToolPart,
} from "@openharness/sdk";
import { Badge, Spinner } from "../ui";

export function extractPlanFromTool(part: ToolPart): PlanData | null {
  const metaPlan = part.metadata?.plan as PlanData | undefined;
  if (metaPlan && Array.isArray(metaPlan.steps)) {
    return metaPlan;
  }
  const input = part.input as Record<string, unknown> | undefined;
  if (input && Array.isArray(input.steps)) {
    return {
      title: typeof input.title === "string" ? input.title : "Plan",
      explanation:
        typeof input.explanation === "string" ? input.explanation : undefined,
      steps: (input.steps as Array<Record<string, unknown>>).map((s, idx) => {
        const rawStatus = String(s.status ?? "pending");
        const status: PlanStep["status"] =
          rawStatus === "cancelled"
            ? "blocked"
            : rawStatus === "completed" ||
                rawStatus === "in_progress" ||
                rawStatus === "blocked"
              ? rawStatus
              : "pending";
        return {
          id: String(s.id ?? idx + 1),
          title: String(s.title ?? s.content ?? `Step ${idx + 1}`),
          status,
          detail:
            typeof s.detail === "string"
              ? s.detail
              : typeof s.reason === "string"
                ? s.reason
                : undefined,
        };
      }),
    };
  }
  return null;
}

export function PlanProgressBar({
  completed,
  total,
  decorative = false,
  className = "",
}: {
  completed: number;
  total: number;
  decorative?: boolean;
  className?: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  return (
    <div
      role={decorative ? undefined : "progressbar"}
      aria-valuenow={decorative ? undefined : completed}
      aria-valuemin={decorative ? undefined : 0}
      aria-valuemax={decorative ? undefined : total}
      aria-label={decorative ? undefined : "Plan progress"}
      className={`h-1 w-full overflow-hidden rounded-full bg-hover ${className}`}
    >
      <div
        className="h-full rounded-full bg-accent transition-all duration-200 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function PlanSteps({
  steps,
  live = false,
}: {
  steps: PlanStep[];
  live?: boolean;
}) {
  return (
    <ol className="space-y-1.5">
      {steps.map((step, i) => {
        const isCompleted = step.status === "completed";
        const isInProgress = step.status === "in_progress";
        const isBlocked = step.status === "blocked";

        return (
          <li key={step.id || i} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 shrink-0">
              {isCompleted ? (
                <CheckCircle2
                  className="size-3.5 text-success"
                  aria-hidden="true"
                />
              ) : isInProgress ? (
                live ? (
                  <Spinner className="size-3.5 text-accent" />
                ) : (
                  <CircleDot
                    className="size-3.5 text-accent"
                    aria-hidden="true"
                  />
                )
              ) : isBlocked ? (
                <AlertTriangle
                  className="size-3.5 text-warning"
                  aria-hidden="true"
                />
              ) : (
                <Circle className="size-3.5 text-muted" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={
                    isCompleted
                      ? "line-through text-muted"
                      : isInProgress
                        ? "font-medium text-fg"
                        : "text-fg"
                  }
                >
                  {step.title}
                </span>
                <span className="sr-only">({step.status})</span>
              </div>
              {step.detail && (
                <p className="mt-0.5 text-xs text-muted">{step.detail}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function PlanCard({
  part,
  live = false,
}: {
  part: ToolPart;
  live?: boolean;
}) {
  const plan = extractPlanFromTool(part);
  const isRunning = part.state === "pending" || part.state === "running";
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  if (!plan) {
    return (
      <div className="my-1.5 flex items-center gap-2 rounded-xl border border-border bg-elev px-3 py-1.5 text-xs text-muted">
        {isRunning ? <Spinner className="size-3.5" /> : <ListChecks className="size-3.5" aria-hidden="true" />}
        <span>{isRunning ? "Updating plan..." : "Plan updated"}</span>
      </div>
    );
  }

  const prog = planProgress(plan);

  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-border bg-elev text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="touch-target flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-hover/60"
      >
        <div className="flex min-w-0 items-center gap-2">
          {isRunning ? (
            <Spinner className="size-3.5 shrink-0 text-accent" />
          ) : (
            <ListChecks className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
          )}
          <span className="truncate font-semibold text-fg">{plan.title || "Plan"}</span>
          {prog.current && !open && (
            <span className="hidden sm:inline truncate text-muted">· {prog.current.title}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={prog.done ? "success" : "accent"}>
            {prog.completed}/{prog.total}
          </Badge>
          <ChevronDown
            className={`size-3.5 text-muted transition-transform duration-150 ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </div>
      </button>

      {open && (
        <div id={bodyId} className="border-t border-border bg-bg px-3.5 py-2.5 space-y-2">
          {plan.explanation && (
            <p className="text-xs text-muted">{plan.explanation}</p>
          )}
          <PlanProgressBar completed={prog.completed} total={prog.total} />
          <PlanSteps steps={plan.steps} live={live || isRunning} />
        </div>
      )}
    </div>
  );
}
