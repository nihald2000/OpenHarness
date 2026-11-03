import { Link } from "@/lib/router";
import { useCatalog } from "@/lib/hooks";
import { BrandLogo } from "./ui";
import { ArrowUpRight, BarChart3, FileSpreadsheet, Mic2, Network } from "lucide-react";

const DEMOS = [
  {
    title: "Verifiable web app",
    description: "Build a telemetry dashboard, start its preview, and verify key interactions in a browser flow.",
    agent: "assistant",
    prompt: "Build a polished real-time GPU telemetry dashboard as a small web app. Start the dev server on 0.0.0.0:3010, add a browser check for the main dashboard content, run it, and fix any failure before you finish.",
    icon: BarChart3,
  },
  {
    title: "Multimodal executive studio",
    description: "Create an editable slide deck and financial workbook, then inspect rendered pages and formulas.",
    agent: "document",
    prompt: "Create a polished 5-slide executive pitch deck and an editable SaaS unit-economics workbook with three scenarios. Use a cohesive visual style, render the documents, check for spreadsheet formula errors, and fix any layout issues.",
    icon: FileSpreadsheet,
  },
  {
    title: "Parallel architecture review",
    description: "Build a compact architecture brief with parallel codebase exploration and a review pass.",
    agent: "assistant",
    prompt: "Create an architecture brief for this workspace. Delegate parallel explore and reviewer tasks, synthesize their findings, add a Mermaid architecture diagram, and export a readable PDF brief.",
    icon: Network,
  },
  {
    title: "Human takeover co-debug",
    description: "Build a checkout demo and use live browser takeover to inspect a user-reported issue.",
    agent: "assistant",
    prompt: "Build a small multi-step checkout demo with a visible state bug that you can reproduce and fix. Start it on 0.0.0.0:3020, open the live preview, and request browser takeover so I can inspect it and give you feedback.",
    icon: Mic2,
  },
];

export function EmptyState({ onChooseDemo }: { onChooseDemo?: (agent: string, prompt: string) => void }) {
  const { models, loading } = useCatalog();
  const needsConfiguration = !loading && models.length === 0;

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-8">
      <div className={`mx-auto w-full ${models.length ? "max-w-[720px]" : "max-w-[520px]"} text-center animate-fade-in`}>
        <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-2xl border border-border bg-elev shadow-card">
          <BrandLogo className="size-6" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          What can I help you build?
        </h1>
        {loading ? (
          <p className="mx-auto mt-2 max-w-md text-xs text-muted" role="status">
            Loading workspace configuration…
          </p>
        ) : needsConfiguration ? (
          <div className="mx-auto mt-4 max-w-md rounded-2xl border border-border bg-elev p-5">
            <h2 className="text-sm font-semibold text-fg">
              Configure a model to start
            </h2>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              No model provider is configured. Add a provider and choose its
              model in Settings before starting a chat.
            </p>
            <Link
              href="/settings"
              className="mt-4 inline-flex h-8 items-center justify-center rounded-lg bg-accent px-4 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-strong"
            >
              Open model settings
            </Link>
          </div>
        ) : (
          <>
            <p className="mx-auto mt-1.5 max-w-lg text-xs leading-relaxed text-muted">
              Cloud-sandbox software engineering, live browser co-debugging, and multimodal document studio.
            </p>
            <div className="mt-6 grid gap-2.5 text-left sm:grid-cols-2">
              {DEMOS.map((demo) => {
                const Icon = demo.icon;
                return (
                  <button
                    key={demo.title}
                    type="button"
                    onClick={() => onChooseDemo?.(demo.agent, demo.prompt)}
                    className="group flex flex-col justify-between rounded-xl border border-border bg-elev/70 p-3.5 text-left transition-all hover:border-accent/40 hover:bg-hover/60"
                  >
                    <div>
                      <span className="flex items-center gap-2 text-xs font-semibold text-fg">
                        <Icon className="size-3.5 text-accent" />
                        <span>{demo.title}</span>
                        <ArrowUpRight className="ml-auto size-3.5 text-muted opacity-0 transition group-hover:opacity-100" />
                      </span>
                      <span className="mt-1.5 block text-xs leading-relaxed text-muted">
                        {demo.description}
                      </span>
                    </div>
                    <span className="mt-2.5 inline-block self-start rounded-md border border-border/80 bg-bg px-2 py-0.5 text-[10px] font-medium text-muted">
                      {demo.agent === "document" ? "Studio agent" : "Code agent"}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
