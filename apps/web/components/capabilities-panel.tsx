"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { useApp, useCatalog, useTools } from "@/lib/hooks";
import { PluginsTab } from "./plugins-tab";
import { Badge, IconButton, Spinner } from "./ui";

const TABS = [
  "Plugins",
  "Skills",
  "Agents",
  "Tools",
  "MCP",
  "Commands",
] as const;

type TabName = (typeof TABS)[number];

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

  const [activeTab, setActiveTab] = useState<TabName>("Plugins");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();

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

  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = (idx + 1) % TABS.length;
      setActiveTab(TABS[next]!);
      tabRefs.current[next]?.focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = (idx - 1 + TABS.length) % TABS.length;
      setActiveTab(TABS[prev]!);
      tabRefs.current[prev]?.focus();
    }
  };

  return (
    <>
      <div
        onClick={() => setCapabilitiesOpen(false)}
        className="fixed inset-0 z-30 bg-black/40 xl:hidden"
        aria-hidden="true"
      />

      <aside
        aria-label="Capabilities"
        className="fixed inset-y-0 right-0 z-40 flex w-[min(32rem,100%)] shrink-0 flex-col border-l border-border bg-elev xl:static xl:w-84"
      >
        <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
          <h2 className="text-xs font-semibold text-fg">Capabilities</h2>
          <div className="flex items-center gap-1">
            <IconButton
              label="Reload catalog"
              onClick={() => void refresh()}
              disabled={catalogLoading}
            >
              {catalogLoading ? (
                <Spinner />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden="true" />
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
          className="flex overflow-x-auto border-b border-border px-2 pt-1.5"
        >
          {TABS.map((tab, idx) => {
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
                onClick={() => setActiveTab(tab)}
                onKeyDown={(e) => handleTabKeyDown(e, idx)}
                className={`border-b-2 px-2.5 pb-2 text-xs font-medium whitespace-nowrap transition-colors ${
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
          className="flex-1 overflow-y-auto p-3 text-xs"
        >
          {activeTab === "Plugins" && <PluginsTab />}

          {activeTab === "Skills" && (
            <div className="space-y-2">
              {skills.length === 0 ? (
                <p className="py-6 text-center text-muted">No skills found.</p>
              ) : (
                skills.map((s) => (
                  <div
                    key={s.name}
                    className="rounded-lg border border-border bg-bg px-3 py-2.5"
                  >
                    <div className="font-semibold text-fg">{s.name}</div>
                    {s.description && (
                      <p className="mt-1 text-[11px] text-muted">
                        {s.description}
                      </p>
                    )}
                    {s.triggers && s.triggers.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {s.triggers.map((t) => (
                          <span
                            key={t}
                            className="rounded border border-border bg-code px-1.5 py-0.5 font-mono text-[10px] text-muted"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === "Agents" && (
            <div className="space-y-2">
              {agents.map((a) => (
                <div
                  key={a.name}
                  className="rounded-lg border border-border bg-bg px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className="size-2.5 rounded-full"
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
                    <p className="mt-1 text-[11px] text-muted">
                      {a.description}
                    </p>
                  )}
                  {a.model && (
                    <p className="mt-1 font-mono text-[10px] text-muted">
                      {a.model}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeTab === "Tools" && (
            <div className="space-y-2">
              <div className="text-[11px] font-medium text-muted">
                Available to {activeAgent} · {tools.length} tools
              </div>
              {toolsLoading ? (
                <div className="flex items-center gap-2 py-4 text-muted">
                  <Spinner />
                  <span>Loading tools...</span>
                </div>
              ) : (
                tools.map((t) => (
                  <div
                    key={t.name}
                    className="rounded-lg border border-border bg-bg px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
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
                      <p className="mt-1 text-[11px] text-muted">
                        {t.description}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === "MCP" && (
            <div className="space-y-2">
              {mcp.length === 0 ? (
                <p className="py-6 text-center text-muted">
                  No MCP servers configured.
                </p>
              ) : (
                mcp.map((s) => (
                  <div
                    key={s.name}
                    className="rounded-lg border border-border bg-bg px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
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
                        <span className="font-mono text-[11px] text-muted">
                          {s.toolsCount} tools
                        </span>
                      )}
                    </div>
                    {s.error && (
                      <p className="mt-1 text-[11px] text-danger">{s.error}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === "Commands" && (
            <div className="space-y-2">
              {commands.length === 0 ? (
                <p className="py-6 text-center text-muted">
                  No slash commands defined.
                </p>
              ) : (
                commands.map((c) => (
                  <div
                    key={c.name}
                    className="rounded-lg border border-border bg-bg px-3 py-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-medium text-fg">
                        /{c.name}
                      </span>
                      {c.agent && <Badge tone="neutral">{c.agent}</Badge>}
                    </div>
                    {c.description && (
                      <p className="mt-1 text-[11px] text-muted">
                        {c.description}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
