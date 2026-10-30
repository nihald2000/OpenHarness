import React, { useEffect, useId, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { useApp, useCatalog, useTools } from "@/lib/hooks";
import { PluginsTab } from "./plugins-tab";
import { Badge, IconButton, Spinner } from "./ui";

export const CAPABILITY_TABS = [
  "Plugins",
  "Skills",
  "Agents",
  "Tools",
  "MCP",
  "Commands",
] as const;

export type CapabilityTabName = (typeof CAPABILITY_TABS)[number];

export const CAPABILITY_TAB_EVENT = "oh:select-capability-tab";
let requestedCapabilityTab: CapabilityTabName = "Plugins";

export function selectCapabilityTab(tab: CapabilityTabName) {
  requestedCapabilityTab = tab;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<CapabilityTabName>(CAPABILITY_TAB_EVENT, { detail: tab })
    );
  }
}

export function getRequestedCapabilityTab(): CapabilityTabName {
  return requestedCapabilityTab;
}

export function CapabilitiesPanel({ activeAgent }: { activeAgent: string }) {
  const { capabilitiesOpen, setCapabilitiesOpen } = useApp();
  const {
    skills,
    agents,
    mcp,
    commands,
    loading: catalogLoading,
    refresh,
  } = useCatalog();

  const [activeTab, setActiveTab] = useState<CapabilityTabName>(
    () => requestedCapabilityTab
  );
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();

  useEffect(() => {
    const onSelectTab = (e: Event) => {
      const detail = (e as CustomEvent<CapabilityTabName>).detail;
      if (detail && CAPABILITY_TABS.includes(detail)) {
        requestedCapabilityTab = detail;
        setActiveTab(detail);
      }
    };
    window.addEventListener(CAPABILITY_TAB_EVENT, onSelectTab);
    return () => window.removeEventListener(CAPABILITY_TAB_EVENT, onSelectTab);
  }, []);

  useEffect(() => {
    if (capabilitiesOpen) {
      setActiveTab(requestedCapabilityTab);
    }
  }, [capabilitiesOpen]);

  const { tools, loading: toolsLoading } = useTools(
    activeAgent,
    capabilitiesOpen && activeTab === "Tools"
  );

  useEffect(() => {
    if (!capabilitiesOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && window.innerWidth < 1280) {
        setCapabilitiesOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [capabilitiesOpen, setCapabilitiesOpen]);

  if (!capabilitiesOpen) return null;

  const handleTabChange = (tab: CapabilityTabName) => {
    selectCapabilityTab(tab);
    setActiveTab(tab);
  };

  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = (idx + 1) % CAPABILITY_TABS.length;
      handleTabChange(CAPABILITY_TABS[next]!);
      tabRefs.current[next]?.focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = (idx - 1 + CAPABILITY_TABS.length) % CAPABILITY_TABS.length;
      handleTabChange(CAPABILITY_TABS[prev]!);
      tabRefs.current[prev]?.focus();
    }
  };

  return (
    <>
      <div
        onClick={() => setCapabilitiesOpen(false)}
        className="fixed inset-0 z-30 bg-overlay backdrop-blur-xs xl:hidden"
        aria-hidden="true"
      />

      <aside
        aria-label="Capabilities"
        className="fixed inset-y-0 right-0 z-40 flex w-[min(32rem,100%)] shrink-0 flex-col border-l border-border bg-elev xl:static xl:w-84 animate-fade-in"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight text-fg">
            Capabilities
          </h2>
          <div className="flex items-center gap-1">
            <IconButton
              label="Reload catalog"
              onClick={() => void refresh()}
              disabled={catalogLoading}
            >
              {catalogLoading ? (
                <Spinner />
              ) : (
                <RefreshCw className="size-4" aria-hidden="true" />
              )}
            </IconButton>
            <IconButton
              label="Close capabilities"
              onClick={() => setCapabilitiesOpen(false)}
            >
              <X className="size-4" aria-hidden="true" />
            </IconButton>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Capabilities sections"
          className="flex overflow-x-auto border-b border-border px-3 pt-2"
        >
          {CAPABILITY_TABS.map((tab, idx) => {
            const selected = activeTab === tab;
            return (
              <button
                key={tab}
                ref={(el) => {
                  tabRefs.current[idx] = el;
                }}
                id={`${baseId}-tab-${tab}`}
                role="tab"
                type="button"
                aria-selected={selected}
                aria-controls={`${baseId}-panel-${tab}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => handleTabChange(tab)}
                onKeyDown={(e) => handleTabKeyDown(e, idx)}
                className={`touch-target border-b-2 px-3 pb-2 text-xs font-medium whitespace-nowrap transition-colors duration-150 ease-out ${
                  selected
                    ? "border-accent text-fg"
                    : "border-transparent text-muted hover:text-fg"
                }`}
              >
                {tab}
              </button>
            );
          })}
        </div>

        <div
          id={`${baseId}-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${activeTab}`}
          className="flex-1 overflow-y-auto p-4 text-xs"
        >
          {activeTab === "Plugins" && <PluginsTab />}

          {activeTab === "Skills" && (
            <div>
              {skills.length === 0 ? (
                <p className="py-6 text-center text-muted">No skills found.</p>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border bg-bg divide-y divide-border">
                  {skills.map((s) => (
                    <div key={s.name} className="px-4 py-3">
                      <div className="font-semibold text-fg">{s.name}</div>
                      {s.description && (
                        <p className="mt-1 text-xs text-muted">
                          {s.description}
                        </p>
                      )}
                      {s.triggers && s.triggers.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {s.triggers.map((t) => (
                            <span
                              key={t}
                              className="rounded border border-border bg-code px-2 py-0.5 font-mono text-xs text-muted"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "Agents" && (
            <div className="overflow-hidden rounded-xl border border-border bg-bg divide-y divide-border">
              {agents.map((a) => (
                <div key={a.name} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: a.color || "var(--accent)" }}
                      aria-hidden="true"
                    />
                    <span className="font-semibold text-fg">{a.name}</span>
                    {a.mode && (
                      <Badge
                        tone={a.mode === "subagent" ? "neutral" : "accent"}
                      >
                        {a.mode}
                      </Badge>
                    )}
                    {a.builtIn === false && (
                      <Badge tone="neutral">custom</Badge>
                    )}
                  </div>
                  {a.description && (
                    <p className="mt-1 text-xs text-muted">
                      {a.description}
                    </p>
                  )}
                  {a.model && (
                    <p className="mt-1 font-mono text-xs text-muted">
                      {a.model}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeTab === "Tools" && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted">
                Available to {activeAgent} · {tools.length} tools
              </div>
              {toolsLoading ? (
                <div className="flex items-center gap-2 py-4 text-muted">
                  <Spinner />
                  <span>Loading tools...</span>
                </div>
              ) : tools.length === 0 ? (
                <p className="py-6 text-center text-muted">No tools available.</p>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border bg-bg divide-y divide-border">
                  {tools.map((t) => (
                    <div key={t.name} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-medium text-fg">
                          {t.name}
                        </span>
                        {t.readOnly ? (
                          <Badge tone="accent">read-only</Badge>
                        ) : (
                          <Badge tone="warning">uses</Badge>
                        )}
                        {t.plugin ? (
                          <Badge tone="accent">plugin: {t.plugin}</Badge>
                        ) : (
                          t.source && <Badge tone="neutral">{t.source}</Badge>
                        )}
                      </div>
                      {t.description && (
                        <p className="mt-1 text-xs text-muted">
                          {t.description}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "MCP" && (
            <div>
              {mcp.length === 0 ? (
                <p className="py-6 text-center text-muted">
                  No MCP servers configured.
                </p>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border bg-bg divide-y divide-border">
                  {mcp.map((s) => (
                    <div key={s.name} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-fg">{s.name}</span>
                        <Badge
                          tone={
                            s.status === "connected"
                              ? "success"
                              : s.status === "failed"
                                ? "danger"
                                : s.status === "connecting"
                                  ? "accent"
                                  : "neutral"
                          }
                        >
                          {s.status}
                        </Badge>
                        {s.readOnly && <Badge tone="neutral">read-only</Badge>}
                        {s.toolsCount !== undefined && (
                          <span className="font-mono text-xs text-muted">
                            {s.toolsCount} tools
                          </span>
                        )}
                      </div>
                      {s.error && (
                        <p className="mt-1 text-xs text-danger">{s.error}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "Commands" && (
            <div>
              {commands.length === 0 ? (
                <p className="py-6 text-center text-muted">
                  No slash commands defined.
                </p>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border bg-bg divide-y divide-border">
                  {commands.map((c) => (
                    <div key={c.name} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-medium text-fg">
                          /{c.name}
                        </span>
                        {c.agent && <Badge tone="neutral">{c.agent}</Badge>}
                      </div>
                      {c.description && (
                        <p className="mt-1 text-xs text-muted">
                          {c.description}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
