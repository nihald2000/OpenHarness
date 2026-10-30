import { useEffect, useRef, useState } from "react";
import {
  ClipboardList,
  Cloud,
  Cpu,
  Menu,
  PanelRight,
  Pencil,
  Server,
  Wrench,
} from "lucide-react";
import type { ContextUsage, Session } from "@/types/sdk";
import { isActive } from "@/lib/format";
import { useApp, useCatalog } from "@/lib/hooks";
import type { FixLoopState } from "@/lib/use-session";
import { SelectMenu, type SelectOption } from "./select-menu";
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
    meta: `${m.id}${m.contextWindow ? ` - ${Math.round(m.contextWindow / 1000)}k ctx` : ""}`,
    badge: m.isDefault ? "Default" : undefined,
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
      label: `Default (${defaultRuntime})`,
      description: "Follow the server's default runtime.",
      icon: <Server className="size-3.5 text-muted" aria-hidden="true" />,
    },
    ...runtimes.map((r) => ({
      id: r.id,
      label: r.id,
      description: r.description || "Starts on first command.",
      meta: r.plugin ? `plugin: ${r.plugin}` : "built-in",
      badge: r.isDefault ? "Default" : undefined,
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
    <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-glass px-4 py-2 backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-2">
        <IconButton
          label="Open sessions menu"
          onClick={() => setSidebarOpen(true)}
          className="lg:hidden"
        >
          <Menu className="size-4" aria-hidden="true" />
        </IconButton>

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
            className="h-8 max-w-[75vw] rounded-lg border border-accent bg-bg px-3 text-sm font-semibold text-fg focus:outline-none"
          />
        ) : (
          <button
            type="button"
            disabled={!session || readOnly}
            onClick={() => setEditingTitle(true)}
            title={session?.title || "New chat"}
            className="touch-target group inline-flex h-8 max-w-[16rem] items-center gap-2 truncate rounded-lg px-2 text-sm font-semibold tracking-tight text-fg transition-colors duration-150 ease-out hover:bg-hover disabled:pointer-events-none"
          >
            <span className="truncate">
              {session ? session.title || "Untitled" : "New chat"}
            </span>
            {session && !readOnly && (
              <Pencil
                className="size-3.5 shrink-0 text-muted opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100"
                aria-hidden="true"
              />
            )}
          </button>
        )}

        {isPlan && (
          <Badge tone="accent">
            <ClipboardList className="size-3" aria-hidden="true" />
            <span>Plan mode</span>
          </Badge>
        )}

        {fix && (fix.phase === "verifying" || fix.phase === "fixing") && (
          <button
            type="button"
            onClick={() => {
              const el = document.getElementById(`verify-${fix.iteration}`);
              el?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            className="touch-target inline-flex items-center gap-2 rounded-full border border-warning/30 bg-warning/10 px-3 py-1 text-xs font-medium text-warning transition-colors duration-150 ease-out hover:bg-warning/15"
          >
            <Wrench className="size-3" aria-hidden="true" />
            <span>
              Fix loop: {fix.phase} ({fix.iteration}/{fix.maxIterations})
            </span>
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {session && contextUsage && windowSize > 0 && (
          <button
            type="button"
            disabled={active}
            onClick={onCompact}
            title={`Context ${fillPct}% full - Compact`}
            className={`touch-target hidden sm:inline-flex h-8 max-w-[72px] items-center justify-center rounded-lg border px-2 font-mono text-xs transition-colors duration-150 ease-out disabled:opacity-40 ${
              fillPct >= 65
                ? "border-warning/30 bg-warning/10 text-warning hover:bg-warning/15"
                : "border-border bg-elev text-muted hover:bg-hover hover:text-fg"
            }`}
          >
            {fillPct}%
          </button>
        )}

        {agentOptions.length > 0 && (
          <SelectMenu
            label="Agent"
            value={selectedAgent}
            options={agentOptions}
            onChange={onSelectAgent}
            disabled={readOnly}
            badge={isPlan ? "read-only" : undefined}
            buttonClassName={
              isPlan ? "border-accent/30 bg-accent/10" : ""
            }
          />
        )}

        {modelOptions.length > 0 && (
          <SelectMenu
            label="Model"
            value={selectedModel}
            options={modelOptions}
            onChange={onSelectModel}
            disabled={readOnly}
            icon={<Cpu className="size-3.5 text-muted" aria-hidden="true" />}
          />
        )}

        {runtimes.length > 0 && (
          <SelectMenu
            label="Runtime"
            value={runtimeSelectValue}
            options={runtimeOptions}
            onChange={(val) =>
              onSelectRuntime(val === "_default_" ? null : val)
            }
            disabled={readOnly || active}
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

        {runtimeDetached && sessionExplicitRuntime && (
          <Badge tone="warning">
            Runtime {sessionExplicitRuntime} detached
          </Badge>
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

        <ConnectionIndicator status={globalStatus} hideLabelOnMobile />

        <IconButton
          label="Capabilities"
          active={capabilitiesOpen}
          onClick={() => setCapabilitiesOpen((o) => !o)}
          size="md"
        >
          <PanelRight className="size-4" aria-hidden="true" />
        </IconButton>
      </div>
    </header>
  );
}
