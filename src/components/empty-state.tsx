import { Link } from "@/lib/router";
import { useCatalog } from "@/lib/hooks";
import { BrandLogo } from "./ui";
import { ArrowUpRight, BarChart3, FileSpreadsheet, LayoutDashboard, Mic2, Network, Sparkles } from "lucide-react";

const DEMOS = [
  {
    title: "Verifiable web app",
    description: "Build a telemetry dashboard, start its preview, and verify the key interactions in a browser flow.",
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
    description: "Build a checkout demo and use the live browser takeover to inspect a user-reported issue.",
    agent: "assistant",
    prompt: "Build a small multi-step checkout demo with a visible state bug that you can reproduce and fix. Start it on 0.0.0.0:3020, open the live preview, and request browser takeover so I can inspect it and give you feedback.",
    icon: Mic2,
  },
];

export function EmptyState({ onChooseDemo }: { onChooseDemo?: (agent: string, prompt: string) => void }) {
  const { models, loading } = useCatalog();
  const needsConfiguration = !loading && models.length === 0;

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
      <div className={`mx-auto w-full ${models.length ? "max-w-5xl" : "max-w-[560px]"} text-center animate-fade-in`}>
        <div className="mx-auto mb-4 flex items-center justify-center"><BrandLogo className="size-10" /></div>
        {models.length > 0 && <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-[11px] font-semibold text-accent"><Sparkles className="size-3.5" />Meta Global AI Developer Hackathon · Push the Frontier</div>}
        <h1 className="text-[28px] font-semibold tracking-tight text-fg">OpenHarness</h1>
        {loading ? (
          <p className="mx-auto mt-3 max-w-lg text-sm leading-normal text-muted" role="status">
            Loading model configuration…
          </p>
        ) : needsConfiguration ? (
          <div className="mx-auto mt-4 max-w-lg rounded-xl border border-border bg-elev p-5">
            <h2 className="text-sm font-semibold text-fg">
              Configure a model to start
            </h2>
            <p className="mt-2 text-sm leading-normal text-muted">
              No model provider is configured. Add a provider and choose its
              model in Settings before starting a chat.
            </p>
            <Link
              href="/settings"
              className="mt-4 inline-flex h-9 items-center justify-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-strong"
            >
              Open model settings
            </Link>
          </div>
        ) : (
          <>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-normal text-muted">Verifiable cloud-sandbox software and a multimodal document studio, powered by Muse and visual review models on Modal.</p>
            <div className="mx-auto mt-4 flex max-w-4xl flex-wrap justify-center gap-2">
              {["Muse Spark 1.3 · Orchestrator", "Muse Wonder 1.0 · Studio", "Muse Glimmer 30B · Modal Open-Weights", "Muse Image · Visuals", "Muse Voice · Live Mic", "SAM 3.1 · Visual QA"].map((label) => <span key={label} className="rounded-full border border-border bg-elev px-3 py-1.5 text-[11px] text-muted">{label}</span>)}
            </div>
            <div className="mt-7 grid gap-3 text-left sm:grid-cols-2">
              {DEMOS.map((demo) => {
                const Icon = demo.icon;
                return <button key={demo.title} type="button" onClick={() => onChooseDemo?.(demo.agent, demo.prompt)} className="group rounded-xl border border-border bg-elev p-4 text-left transition hover:border-accent/40 hover:bg-hover">
                  <span className="flex items-center gap-2 text-sm font-semibold text-fg"><Icon className="size-4 text-accent" />{demo.title}<ArrowUpRight className="ml-auto size-3.5 text-muted opacity-0 transition group-hover:opacity-100" /></span>
                  <span className="mt-2 block text-xs leading-relaxed text-muted">{demo.description}</span>
                  <span className="mt-3 inline-block rounded-full bg-bg px-2 py-1 text-[10px] text-muted">{demo.agent === "document" ? "Studio agent" : "Code agent"}</span>
                </button>;
              })}
            </div>
            <p className="mt-5 text-xs text-muted">Choose a demo to select its agent and prefill a prompt. You can edit it before sending.</p>
          </>
        )}
      </div>
    </div>
  );
}
