import React from "react";
import {
  Bot,
  ClipboardList,
  FilePlus2,
  Telescope,
  Wrench,
} from "lucide-react";
import { useCatalog } from "@/lib/hooks";
import { Badge, BrandLogo } from "./ui";

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
      <div className="mx-auto w-full max-w-[720px] text-center animate-fade-in">
        <div className="mx-auto mb-4 flex items-center justify-center">
          <BrandLogo className="size-10" />
        </div>

        <h1 className="text-[28px] font-semibold tracking-tight text-fg">
          OpenHarness
        </h1>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-normal text-muted">
          An open agent harness with tools, approvals, plans, skills and
          subagents. Ask anything about your workspace or pick a suggestion to
          get started.
        </p>

        {showDemoBanner && demoModel && (
          <div className="mt-4 inline-flex flex-wrap items-center justify-center gap-2 rounded-full border border-border bg-elev px-4 py-1 text-xs text-muted">
            <span>These suggestions are built for the offline demo model.</span>
            <button
              type="button"
              onClick={() => onSelectModel(demoModel.id)}
              className="touch-target font-medium text-accent hover:underline"
            >
              Use {demoModel.name || demoModel.id} &rarr;
            </button>
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 text-left">
          {SUGGESTIONS.map((item, idx) => {
            const Icon = item.icon;
            const isOddLast =
              SUGGESTIONS.length % 2 === 1 && idx === SUGGESTIONS.length - 1;
            return (
              <button
                key={item.title}
                type="button"
                onClick={() => onPickSuggestion(item)}
                className={`group flex items-start gap-3 rounded-xl border border-border bg-elev p-4 text-left transition-colors duration-150 ease-out hover:border-accent/40 hover:bg-hover ${
                  isOddLast ? "sm:col-span-2" : ""
                }`}
              >
                <Icon
                  className="mt-0.5 size-4 shrink-0 text-muted transition-colors duration-150 ease-out group-hover:text-accent"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-fg">
                      {item.title}
                    </span>
                    {item.hint && <Badge tone="accent">{item.hint}</Badge>}
                  </div>
                  {item.monoSubtitle && (
                    <p className="mt-1 font-mono text-xs text-muted">
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
