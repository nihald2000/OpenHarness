import React, { useEffect, useId, useMemo, useState } from "react";
import {
  Blocks,
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  Moon,
  PanelLeftClose,
  Plus,
  Search,
  Server,
  Settings,
  Sun,
  TerminalSquare,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Link, usePathname, useRouter } from "@/lib/router";
import { client } from "@/lib/client";
import { errorMessage, isStatus, relativeTime } from "@/lib/format";
import { useApp, useCatalog, useSessions } from "@/lib/hooks";
import {
  CAPABILITY_TAB_EVENT,
  getRequestedCapabilityTab,
  selectCapabilityTab,
  type CapabilityTabName,
} from "./capabilities-panel";
import {
  BrandLogo,
  ConnectionIndicator,
  IconButton,
  StatusDot,
} from "./ui";

const WORKSPACE_OPEN_STORAGE_KEY = "oh-workspace-open";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "oh-sidebar-collapsed";
export const TOGGLE_SIDEBAR_EVENT = "oh:toggle-sidebar";

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const {
    theme,
    toggleTheme,
    notify,
    activeSessionId,
    removeSession,
    globalStatus,
    sidebarOpen,
    setSidebarOpen,
    capabilitiesOpen,
    setCapabilitiesOpen,
  } = useApp();
  const { sessions, loading } = useSessions();
  const {
    info,
    agents,
    mcp,
    plugins,
    skills,
    commands,
    loading: catalogLoading,
  } = useCatalog();
  const [dismissedWaiting, setDismissedWaiting] = useState<string[]>(() => {
    try { return JSON.parse(sessionStorage.getItem("oh.dismissedWaiting") ?? "[]") as string[]; } catch { return []; }
  });
  const [now, setNow] = useState(() => Date.now());
  const waitingInAnotherChat = sessions.find((session) => {
    if (session.status !== "awaiting_input" && session.pauseReason !== "takeover") return false;
    if (dismissedWaiting.includes(session.id)) return false;
    const updated = typeof session.updatedAt === "number" ? session.updatedAt : new Date(session.updatedAt).getTime();
    return session.id === activeSessionId || (Number.isFinite(updated) && now - updated <= 30 * 60_000);
  });

  const [query, setQuery] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [desktopCollapsed, setDesktopCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  // Default Workspace capabilities accordion to collapsed so chat history gets full vertical space like ChatGPT/Claude
  const [workspaceOpen, setWorkspaceOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(WORKSPACE_OPEN_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [activeCapTab, setActiveCapTab] = useState<CapabilityTabName>(() =>
    getRequestedCapabilityTab()
  );
  const workspaceSectionId = useId();

  useEffect(() => {
    const onSelectTab = (e: Event) => {
      const detail = (e as CustomEvent<CapabilityTabName>).detail;
      if (detail) setActiveCapTab(detail);
    };
    window.addEventListener(CAPABILITY_TAB_EVENT, onSelectTab);
    return () => window.removeEventListener(CAPABILITY_TAB_EVENT, onSelectTab);
  }, []);

  useEffect(() => {
    const onToggleSidebar = (e: Event) => {
      const forced = (e as CustomEvent<{ collapsed?: boolean }>).detail?.collapsed;
      setDesktopCollapsed((prev) => {
        const next = typeof forced === "boolean" ? forced : !prev;
        try {
          localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
        } catch {}
        return next;
      });
    };
    window.addEventListener(TOGGLE_SIDEBAR_EVENT, onToggleSidebar);
    return () => window.removeEventListener(TOGGLE_SIDEBAR_EVENT, onToggleSidebar);
  }, []);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname, setSidebarOpen]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSidebarOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sidebarOpen, setSidebarOpen]);

  const toggleWorkspace = () => {
    setWorkspaceOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(WORKSPACE_OPEN_STORAGE_KEY, String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const toggleDesktopCollapse = () => {
    setDesktopCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  };

  const openWorkspaceCapability = (tab: CapabilityTabName) => {
    selectCapabilityTab(tab);
    setActiveCapTab(tab);
    setCapabilitiesOpen(true);
    setSidebarOpen(false);
    if (pathname === "/settings") {
      router.push("/");
    }
  };

  const workspaceItems: Array<{
    tab: CapabilityTabName;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count?: number;
  }> = [
    {
      tab: "Agents",
      label: "Agents & Subagents",
      icon: Bot,
      count: !catalogLoading ? agents.length : undefined,
    },
    {
      tab: "MCP",
      label: "Protocols (MCP)",
      icon: Server,
      count: !catalogLoading ? mcp.length : undefined,
    },
    {
      tab: "Plugins",
      label: "Apps & Plugins",
      icon: Blocks,
      count: !catalogLoading ? plugins.length : undefined,
    },
    {
      tab: "Skills",
      label: "Skills",
      icon: BookOpen,
      count: !catalogLoading ? skills.length : undefined,
    },
    {
      tab: "Tools",
      label: "Tools",
      icon: Wrench,
    },
    {
      tab: "Commands",
      label: "Commands",
      icon: TerminalSquare,
      count: !catalogLoading ? commands.length : undefined,
    },
  ];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        (s.title || "Untitled").toLowerCase().includes(q) ||
        (s.agent || "").toLowerCase().includes(q)
    );
  }, [query, sessions]);

  const handleDelete = async (id: string) => {
    setConfirmDeleteId(null);
    const wasActive = activeSessionId === id || pathname === `/c/${id}`;
    if (wasActive) {
      router.push("/");
    }
    try {
      await client.session.delete(id);
      removeSession(id);
    } catch (err) {
      if (isStatus(err, 404)) {
        removeSession(id);
        return;
      }
      notify("error", `Could not delete session: ${errorMessage(err)}`);
    }
  };

  return (
    <>
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-overlay backdrop-blur-xs lg:hidden"
          aria-hidden="true"
        />
      )}

      <aside
        aria-label="Sidebar navigation"
        className={`fixed inset-y-0 left-0 z-40 flex w-[260px] shrink-0 flex-col border-r border-border bg-elev transition-all duration-200 ease-out lg:static ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } ${
          desktopCollapsed
            ? "lg:w-0 lg:-translate-x-full lg:overflow-hidden lg:border-r-0"
            : "lg:w-[260px] lg:translate-x-0"
        }`}
      >
        {/* Top brand + New chat header */}
        <div className="flex h-12 shrink-0 items-center justify-between px-3">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm font-semibold tracking-tight text-fg hover:bg-hover/60"
          >
            <BrandLogo className="size-5" />
            <span>OpenHarness</span>
          </Link>
          <div className="flex items-center gap-1">
            <Link
              href="/"
              title="New chat"
              aria-label="New chat"
              className="touch-target inline-flex size-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <Plus className="size-4" aria-hidden="true" />
            </Link>
            <IconButton
              label="Collapse sidebar"
              onClick={toggleDesktopCollapse}
              className="hidden lg:inline-flex"
            >
              <PanelLeftClose className="size-4" aria-hidden="true" />
            </IconButton>
            <IconButton
              label="Close sidebar"
              onClick={() => setSidebarOpen(false)}
              className="lg:hidden"
            >
              <X className="size-4" aria-hidden="true" />
            </IconButton>
          </div>
        </div>

        {/* New chat pill & search */}
        <div className="space-y-1.5 px-2.5 pb-2">
          <Link
            href="/"
            className="flex h-8 w-full items-center gap-2 rounded-lg border border-border bg-bg px-2.5 text-xs font-medium text-fg shadow-2xs transition-colors hover:bg-hover/70"
          >
            <Plus className="size-3.5 text-accent" aria-hidden="true" />
            <span>New chat</span>
          </Link>

          {sessions.length > 3 && (
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted"
                aria-hidden="true"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chats…"
                aria-label="Search chats"
                className="h-7 w-full rounded-lg border border-border/80 bg-bg/70 pl-7 pr-2.5 text-xs text-fg placeholder:text-muted focus-visible:border-accent"
              />
            </div>
          )}
        </div>

        {waitingInAnotherChat && (
          <div className="mx-2.5 mb-2 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-2.5 py-1.5 text-xs text-fg">
            <Link href={`/c/${encodeURIComponent(waitingInAnotherChat.id)}`} className="min-w-0 flex-1 truncate">
              {waitingInAnotherChat.pauseReason === "takeover" ? "Browser control waiting: " : "Question waiting: "}
              <span className="font-semibold">{waitingInAnotherChat.title || "Untitled"}</span>
            </Link>
            <button
              type="button"
              aria-label="Dismiss waiting alert"
              className="shrink-0 rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
              onClick={() =>
                setDismissedWaiting((current) => {
                  const next = Array.from(new Set([...current, waitingInAnotherChat.id]));
                  try { sessionStorage.setItem("oh.dismissedWaiting", JSON.stringify(next)); } catch {}
                  return next;
                })
              }
            >
              <X className="size-3" />
            </button>
          </div>
        )}

        <div className="px-3 pt-1 pb-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted/80">Recents</span>
        </div>

        {/* Full-height chat sessions list */}
        <nav
          aria-label="Chat history"
          className="flex-1 overflow-y-auto px-2 py-0.5 space-y-0.5"
        >
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-9 rounded-lg bg-hover/50 animate-pulse"
              />
            ))
          ) : filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted">
              {sessions.length === 0 ? "No chats yet" : "No matching chats."}
            </p>
          ) : (
            filtered.map((s) => {
              const isCurrent =
                activeSessionId === s.id || pathname === `/c/${s.id}`;
              const isConfirming = confirmDeleteId === s.id;

              return (
                <div
                  key={s.id}
                  className={`group relative flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors duration-150 ease-out ${
                    isCurrent
                      ? "bg-hover text-fg font-medium"
                      : "text-fg/90 hover:bg-hover/60"
                  }`}
                >
                  <StatusDot status={s.status} />

                  <Link
                    href={`/c/${encodeURIComponent(s.id)}`}
                    aria-current={isCurrent ? "page" : undefined}
                    className="min-w-0 flex-1"
                  >
                    <div className="truncate text-[13px] leading-snug">
                      {s.title || "Untitled"}
                    </div>
                    <div className="flex items-center gap-1 text-[11px] text-muted truncate">
                      <span>{relativeTime(s.updatedAt, now)}</span>
                      {s.agent && s.agent !== "assistant" && (
                        <>
                          <span>·</span>
                          <span>{s.agent}</span>
                        </>
                      )}
                    </div>
                  </Link>

                  {isConfirming ? (
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        autoFocus
                        onClick={() => handleDelete(s.id)}
                        aria-label="Confirm delete"
                        title="Confirm delete"
                        className="touch-target inline-flex size-6 items-center justify-center rounded-md bg-danger text-accent-fg hover:opacity-90"
                      >
                        <Check className="size-3" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        aria-label="Cancel delete"
                        title="Cancel delete"
                        className="touch-target inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
                      >
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setConfirmDeleteId(s.id);
                      }}
                      aria-label={`Delete ${s.title || "Untitled"}`}
                      title="Delete chat"
                      className="touch-target inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity duration-150 ease-out hover:bg-bg hover:text-danger group-hover:opacity-100 focus:opacity-100"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </nav>

        {/* Compact collapsible Workspace Capabilities drawer & footer */}
        <div className="border-t border-border p-2 space-y-1">
          <div>
            <button
              type="button"
              onClick={toggleWorkspace}
              aria-expanded={workspaceOpen}
              aria-controls={workspaceSectionId}
              className="touch-target flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-hover/60 hover:text-fg"
            >
              <span className="inline-flex items-center gap-2">
                <Blocks className="size-3.5 text-muted" aria-hidden="true" />
                <span>Workspace &amp; Tools</span>
              </span>
              <ChevronRight
                className={`size-3.5 transition-transform duration-150 ease-out ${
                  workspaceOpen ? "rotate-90" : ""
                }`}
                aria-hidden="true"
              />
            </button>

            {workspaceOpen && (
              <div
                id={workspaceSectionId}
                role="group"
                aria-label="Workspace capabilities"
                className="mt-1 space-y-0.5 pl-1"
              >
                {workspaceItems.map((item) => {
                  const Icon = item.icon;
                  const isSelected =
                    capabilitiesOpen &&
                    pathname !== "/settings" &&
                    activeCapTab === item.tab;
                  return (
                    <button
                      key={item.tab}
                      type="button"
                      onClick={() => openWorkspaceCapability(item.tab)}
                      aria-label={`Open ${item.label} in Capabilities`}
                      aria-pressed={isSelected}
                      className={`touch-target flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                        isSelected
                          ? "bg-bg font-semibold text-accent ring-1 ring-border"
                          : "font-medium text-fg/90 hover:bg-hover/70"
                      }`}
                    >
                      <span className="inline-flex min-w-0 items-center gap-2">
                        <Icon
                          className={`size-3.5 shrink-0 ${
                            isSelected ? "text-accent" : "text-muted"
                          }`}
                          aria-hidden="true"
                        />
                        <span className="truncate">{item.label}</span>
                      </span>
                      {item.count !== undefined && (
                        <span className="ml-2 rounded-full bg-hover px-1.5 py-0.5 font-mono text-[10px] text-muted">
                          {item.count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between px-2 py-1 text-xs text-muted">
            <div className="flex items-center gap-2 min-w-0">
              <ConnectionIndicator status={globalStatus} />
              {!info?.hostedIsolation && (
                <Link
                  href="/settings"
                  aria-current={pathname === "/settings" ? "page" : undefined}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
                >
                  <Settings className="size-3.5" aria-hidden="true" />
                  <span>Settings</span>
                </Link>
              )}
            </div>

            <IconButton
              label={
                theme === "dark"
                  ? "Switch to light mode"
                  : "Switch to dark mode"
              }
              onClick={toggleTheme}
            >
              {theme === "dark" ? (
                <Sun className="size-3.5" aria-hidden="true" />
              ) : (
                <Moon className="size-3.5" aria-hidden="true" />
              )}
            </IconButton>
          </div>
        </div>
      </aside>
    </>
  );
}
