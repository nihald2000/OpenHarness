import { useEffect, useRef, useState } from "react";
import {
  ClipboardList,
  Cloud,
  Cpu,
  Globe,
  Layers,
  Menu,
  PanelLeft,
  PanelRight,
  Pencil,
  Server,
  Wrench,
} from "lucide-react";
import type { ContextUsage, Session } from "@openharness/sdk";
import { isActive } from "@/lib/format";
import { useApp, useCatalog } from "@/lib/hooks";
import type { FixLoopState } from "@/lib/use-session";
import { SelectMenu, type SelectOption } from "./select-menu";
import { TOGGLE_SIDEBAR_EVENT } from "./sidebar";
import { Badge, ConnectionIndicator, IconButton } from "./ui";
import { UsagePopover } from "./usage-popover";
import { CheckpointsPopover } from "./checkpoints-popover";

export function ChatHeader({
  session,
  selectedAgent,
  selectedModel,
  selectedRuntime,
  onSelectAgent,
  onSelectModel,
  onSelectRuntime,
  onRenameTitle,
  contextUsage,
  contextError,
  contextLoading,
  onRefreshContext,
  onCompact,
  compacting,
  fix,
  readOnly,
  browserOpen = false,
  studioOpen = false,
  onOpenBrowser,
  onOpenStudio,
}: {
  session: Session | null;
  selectedAgent: string;
  selectedModel: string;
  selectedRuntime: string;
  onSelectAgent: (agent: string) => void;
  onSelectModel: (model: string) => void;
  onSelectRuntime: (runtime: string | null) => void;
  onRenameTitle: (title: string) => void;
  contextUsage: ContextUsage | null;
  contextError: string | null;
  contextLoading: boolean;
  onRefreshContext: () => void;
  onCompact: () => void;
  compacting: boolean;
  fix: FixLoopState | null;
  readOnly: boolean;
  browserOpen?: boolean;
  studioOpen?: boolean;
  onOpenBrowser: () => void;
  onOpenStudio: () => void;
}) {
  const {
    setSidebarOpen,
    capabilitiesOpen,
    setCapabilitiesOpen,
    globalStatus,
  } = useApp();
  const { primaryAgents, models, runtimes, defaultRuntime } = useCatalog();

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(session?.title || "");
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitleDraft(session?.title || "");
    setEditingTitle(false);
  }, [session?.id, session?.title]);

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

  const commitTitle = () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (session && trimmed && trimmed !== session.title) {
      onRenameTitle(trimmed);
    } else {
      setTitleDraft(session?.title || "");
    }
  };

  const active = isActive(session?.status) || compacting;
  const isPlan = selectedAgent === "plan";

  const agentOptions: SelectOption[] = primaryAgents.map((a) => ({
    id: a.name,
    label: a.name,
    description: a.description,
    color: a.color || "var(--accent)",
    badge: a.name === "plan" ? "read-only" : undefined,
  }));

  const modelOptions: SelectOption[] = models.map((m) => ({
    id: m.id,
    label: m.name || m.id,
    description: m.providerDetail ?? m.provider,
    meta: `${m.id}${m.contextWindow ? ` - ${Math.round(m.contextWindow / 1000)}k ctx` : ""}`,
    badge: m.isDefault ? "Default" : /Glimmer|Open-Weights/i.test(`${m.id} ${m.provider ?? ""}`) ? "Open-Weights" : /Wonder/i.test(m.id) ? "Creative" : undefined,
  }));

  const sessionExplicitRuntime = session?.runtime;
  const runtimeDetached = Boolean(
    sessionExplicitRuntime &&
      runtimes.length > 0 &&
      !runtimes.some((r) => r.id === sessionExplicitRuntime)
  );

  const runtimeOptions: SelectOption[] = [
    {
      id: "_default_",
      label: defaultRuntime ? `Default (${defaultRuntime})` : "No default runtime",
      description: defaultRuntime
        ? "Follow the server's default runtime."
        : "Choose a runtime or set a default in Settings.",
      icon: <Server className="size-3.5 text-muted" aria-hidden="true" />,
    },
    ...runtimes.map((r) => ({
      id: r.id,
      label: r.id,
      description: r.description || "Starts on first command.",
      meta: r.plugin ? `plugin: ${r.plugin}` : "built-in",
      badge: !r.active ? "Unavailable" : r.isDefault ? "Default" : undefined,
      icon: r.remote ? (
        <Cloud className="size-3.5 text-accent" aria-hidden="true" />
      ) : (
        <Server className="size-3.5 text-muted" aria-hidden="true" />
      ),
    })),
  ];

  if (runtimeDetached && sessionExplicitRuntime) {
    runtimeOptions.push({
      id: sessionExplicitRuntime,
      label: `${sessionExplicitRuntime} (detached)`,
      description: "This runtime is no longer attached.",
      icon: <Server className="size-3.5 text-warning" aria-hidden="true" />,
    });
  }

  const runtimeSelectValue = session
    ? session.runtime || "_default_"
    : selectedRuntime || "_default_";

  const currentRuntimeObj = runtimes.find(
    (r) =>
      r.id === (runtimeSelectValue === "_default_" ? defaultRuntime : runtimeSelectValue)
  );

  const estimated = contextUsage?.estimatedTokens ?? 0;
  const windowSize = contextUsage?.contextWindow ?? 0;
  const fillPct =
    windowSize > 0 ? Math.min(100, Math.round((estimated / windowSize) * 100)) : 0;

  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/80 bg-glass px-3 backdrop-blur-md">
      {/* Left: Sidebar toggle + Model / Agent / Runtime selectors */}
      <div className="flex min-w-0 items-center gap-1.5">
        <IconButton
          label="Open sessions menu"
          onClick={() => setSidebarOpen(true)}
          className="lg:hidden"
        >
          <Menu className="size-4" aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Toggle sidebar"
          onClick={() => window.dispatchEvent(new CustomEvent(TOGGLE_SIDEBAR_EVENT))}
          className="hidden lg:inline-flex"
        >
          <PanelLeft className="size-4" aria-hidden="true" />
        </IconButton>

        {modelOptions.length > 0 && (
          <SelectMenu
            label="Model"
            value={selectedModel}
            options={modelOptions}
            onChange={onSelectModel}
            disabled={readOnly}
            align="left"
            icon={<Cpu className="size-3.5 text-muted" aria-hidden="true" />}
          />
        )}

        {agentOptions.length > 0 && (
          <SelectMenu
            label="Agent"
            value={selectedAgent}
            options={agentOptions}
            onChange={onSelectAgent}
            disabled={readOnly}
            align="left"
            badge={isPlan ? "read-only" : undefined}
            buttonClassName={isPlan ? "border-accent/30 bg-accent/10" : ""}
          />
        )}

        {runtimes.length > 0 && (
          <SelectMenu
            label="Runtime"
            value={runtimeSelectValue}
            options={runtimeOptions}
            onChange={(val) => onSelectRuntime(val === "_default_" ? null : val)}
            disabled={readOnly || active}
            align="left"
            disabledTitle="Runtime can't change while the agent is working"
            icon={
              currentRuntimeObj?.remote ? (
                <Cloud className="size-3.5 text-accent" aria-hidden="true" />
              ) : (
                <Server className="size-3.5 text-muted" aria-hidden="true" />
              )
            }
          />
        )}

        {editingTitle && session && !readOnly ? (
          <input
            ref={titleInputRef}
            type="text"
            maxLength={200}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTitle();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setTitleDraft(session.title || "");
                setEditingTitle(false);
              }
            }}
            aria-label="Chat title"
            className="hidden xl:inline-block h-7 max-w-[14rem] rounded-lg border border-accent bg-bg px-2.5 text-xs font-medium text-fg focus:outline-none"
          />
        ) : session ? (
          <button
            type="button"
            disabled={readOnly}
            onClick={() => setEditingTitle(true)}
            title={session.title || "Untitled"}
            className="touch-target group hidden xl:inline-flex h-7 max-w-[14rem] items-center gap-1.5 truncate rounded-lg px-2 text-xs font-medium text-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none"
          >
            <span className="truncate">{session.title || "Untitled"}</span>
            {!readOnly && (
              <Pencil
                className="size-3 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
                aria-hidden="true"
              />
            )}
          </button>
        ) : null}

        {isPlan && (
          <Badge tone="accent">
            <ClipboardList className="size-3" aria-hidden="true" />
            <span>Plan</span>
          </Badge>
        )}

        {fix && (fix.phase === "verifying" || fix.phase === "fixing") && (
          <button
            type="button"
            onClick={() => {
              const el = document.getElementById(`verify-${fix.iteration}`);
              el?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            className="touch-target inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2.5 py-0.5 text-xs font-medium text-warning hover:bg-warning/15"
          >
            <Wrench className="size-3" aria-hidden="true" />
            <span>
              {fix.phase} ({fix.iteration}/{fix.maxIterations})
            </span>
          </button>
        )}
      </div>

      {/* Right: Workspace panes & status */}
      <div className="flex shrink-0 items-center gap-1.5">
        {session && contextUsage && windowSize > 0 && fillPct >= 65 && (
          <button
            type="button"
            disabled={active}
            onClick={onCompact}
            title={`Context ${fillPct}% full - Compact`}
            className="touch-target hidden sm:inline-flex h-7 items-center justify-center rounded-lg border border-warning/30 bg-warning/10 px-2 font-mono text-[11px] text-warning hover:bg-warning/15 disabled:opacity-40"
          >
            {fillPct}%
          </button>
        )}

        {session && <CheckpointsPopover session={session} />}

        {session && (
          <UsagePopover
            session={session}
            contextUsage={contextUsage}
            contextError={contextError}
            contextLoading={contextLoading}
            onOpen={onRefreshContext}
            onCompact={onCompact}
            compacting={compacting}
          />
        )}

        <button
          type="button"
          onClick={onOpenBrowser}
          aria-pressed={browserOpen}
          title="Toggle Live Browser"
          className={`touch-target inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
            browserOpen
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-border bg-elev text-fg hover:bg-hover"
          }`}
        >
          <Globe className="size-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Browser</span>
        </button>

        <IconButton label="Studio" active={studioOpen} onClick={onOpenStudio} size="md">
          <Layers className="size-4" aria-hidden="true" />
        </IconButton>

        <IconButton
          label="Capabilities"
          active={capabilitiesOpen}
          onClick={() => setCapabilitiesOpen((o) => !o)}
          size="md"
        >
          <PanelRight className="size-4" aria-hidden="true" />
        </IconButton>

        <ConnectionIndicator status={globalStatus} hideLabelOnMobile />
      </div>
    </header>
  );
}
