import React from "react";
import {
  Bot,
  ClipboardList,
  FilePlus2,
  Sparkles,
  Telescope,
  Wrench,
} from "lucide-react";
import { useCatalog } from "@/lib/hooks";

export interface SuggestionItem {
  title: string;
  prompt: string;
  agent?: string;
  hint?: string;
  monoSubtitle?: string;
  fixCommand?: string;
  icon: React.ComponentType<{ className?: string }>;
}

const SUGGESTIONS: SuggestionItem[] = [
  {
    title: "Give me a tour of this workspace",
    prompt: "Give me a tour of this workspace",
    icon: Telescope,
  },
  {
    title: "Write a hello file",
    prompt: "Write a hello file",
    icon: FilePlus2,
  },
  {
    title: "Plan a user greeting feature",
    prompt: "Plan a user greeting feature",
    agent: "plan",
    hint: "Plan mode",
    icon: ClipboardList,
  },
  {
    title: "Fix bun script/demo-check.ts",
    prompt: "Fix bun script/demo-check.ts",
    hint: "Run the fix loop",
    monoSubtitle: "bun script/demo-check.ts",
    fixCommand: "bun script/demo-check.ts",
    icon: Wrench,
  },
  {
    title: "Delegate exploration to a subagent",
    prompt: "Delegate exploration to a subagent",
    icon: Bot,
  },
];

export function EmptyState({
  selectedModel,
  onSelectModel,
  onPickSuggestion,
}: {
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  onPickSuggestion: (s: SuggestionItem) => void;
}) {
  const { models } = useCatalog();
  const demoModel = models.find(
    (m) =>
      m.id.toLowerCase().includes("demo") ||
      m.name.toLowerCase().includes("demo")
  );
  const showDemoBanner = Boolean(demoModel && demoModel.id !== selectedModel);

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="mx-auto w-full max-w-2xl text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl border border-accent/30 bg-accent/10 text-accent">
          <Sparkles className="size-6" aria-hidden="true" />
        </div>

        <h1 className="text-xl font-semibold tracking-tight text-fg">
          OpenHarness
        </h1>
        <p className="mx-auto mt-1.5 max-w-lg text-sm leading-relaxed text-muted">
          An open agent harness with tools, approvals, plans, skills and
          subagents. Ask anything about your workspace or pick a suggestion to
          get started.
        </p>

        {showDemoBanner && demoModel && (
          <div className="mt-4 inline-flex flex-wrap items-center justify-center gap-1.5 rounded-full border border-border bg-elev px-3.5 py-1 text-xs text-muted">
            <span>These suggestions are built for the offline demo model.</span>
            <button
              type="button"
              onClick={() => onSelectModel(demoModel.id)}
              className="font-medium text-accent hover:underline"
            >
              Use {demoModel.name || demoModel.id} &rarr;
            </button>
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-2 text-left">
          {SUGGESTIONS.map((item, idx) => {
            const Icon = item.icon;
            const isOddLast =
              SUGGESTIONS.length % 2 === 1 && idx === SUGGESTIONS.length - 1;
            return (
              <button
                key={item.title}
                type="button"
                onClick={() => onPickSuggestion(item)}
                className={`group flex items-start gap-3 rounded-xl border border-border bg-elev p-3.5 text-left transition-colors hover:border-accent/40 hover:bg-hover ${
                  isOddLast ? "sm:col-span-2" : ""
                }`}
              >
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-subtle text-muted group-hover:text-accent">
                  <Icon className="size-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-fg">
                      {item.title}
                    </span>
                    {item.hint && (
                      <span className="rounded-full border border-accent/35 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                        {item.hint}
                      </span>
                    )}
                  </div>
                  {item.monoSubtitle && (
                    <p className="mt-0.5 font-mono text-[11px] text-muted">
                      {item.monoSubtitle}
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
