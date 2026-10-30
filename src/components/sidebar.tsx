import React, { useEffect, useId, useMemo, useState } from "react";
import {
  Blocks,
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  Moon,
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
import { Kbd } from "./kbd";
import {
  BrandLogo,
  ConnectionIndicator,
  IconButton,
  StatusDot,
} from "./ui";

const WORKSPACE_OPEN_STORAGE_KEY = "oh-workspace-open";

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

  const [query, setQuery] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [workspaceOpen, setWorkspaceOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(WORKSPACE_OPEN_STORAGE_KEY);
      if (saved === "false") return false;
      return true;
    } catch {
      return true;
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
        className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-border bg-elev transition-transform duration-200 ease-out lg:static lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-lg text-sm font-semibold tracking-tight text-fg"
          >
            <BrandLogo className="size-6" />
            <span>OpenHarness</span>
          </Link>
          <IconButton
            label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden"
          >
            <X className="size-4" aria-hidden="true" />
          </IconButton>
        </div>

        <div className="space-y-2 px-3 py-2">
          <Link
            href="/"
            className="flex h-9 w-full items-center justify-between rounded-lg bg-accent px-3 text-xs font-medium text-accent-fg shadow-card transition-colors duration-150 ease-out hover:bg-accent-strong"
          >
            <span className="inline-flex items-center gap-2">
              <Plus className="size-4" aria-hidden="true" />
              <span>New chat</span>
            </span>
            <Kbd className="border-accent-fg/25 bg-accent-fg/15 text-accent-fg">
              N
            </Kbd>
          </Link>

          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="h-8 w-full rounded-lg border border-border bg-bg pl-8 pr-3 text-xs text-fg placeholder:text-muted focus-visible:border-accent"
            />
          </div>
        </div>

        <div className="px-3 pt-1 pb-2 border-b border-border">
          <button
            type="button"
            onClick={toggleWorkspace}
            aria-expanded={workspaceOpen}
            aria-controls={workspaceSectionId}
            aria-label={
              workspaceOpen
                ? "Collapse Workspace section"
                : "Expand Workspace section"
            }
            className="touch-target flex w-full items-center justify-between rounded-lg px-2 py-1 text-xs font-medium text-muted transition-colors duration-150 ease-out hover:bg-hover/60 hover:text-fg"
          >
            <span>Workspace</span>
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
              className="mt-1 space-y-0.5"
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
                    className={`touch-target flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition-colors duration-150 ease-out ${
                      isSelected
                        ? "bg-bg font-semibold text-accent shadow-card ring-1 ring-border"
                        : "font-medium text-fg hover:bg-hover/70"
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
                      <span className="ml-2 rounded-full bg-hover px-2 py-0.5 font-mono text-xs text-muted">
                        {item.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-4 pt-3 pb-1">
          <span className="text-xs font-medium text-muted">Sessions</span>
        </div>

        <nav
          aria-label="Chat history"
          className="flex-1 overflow-y-auto px-3 py-1 space-y-1"
        >
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-12 rounded-lg bg-hover/60 animate-pulse"
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
                  className={`group relative flex items-center gap-2 rounded-lg px-3 py-2 text-xs transition-colors duration-150 ease-out ${
                    isCurrent
                      ? "bg-bg text-fg shadow-card ring-1 ring-border"
                      : "text-fg hover:bg-hover/70"
                  }`}
                >
                  <StatusDot status={s.status} />

                  <Link
                    href={`/c/${encodeURIComponent(s.id)}`}
                    aria-current={isCurrent ? "page" : undefined}
                    className="min-w-0 flex-1"
                  >
                    <div
                      className={`truncate ${
                        isCurrent ? "font-semibold" : "font-medium"
                      }`}
                    >
                      {s.title || "Untitled"}
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-xs text-muted truncate">
                      <span>{relativeTime(s.updatedAt, now)}</span>
                      {s.agent && (
                        <>
                          <span>·</span>
                          <span>{s.agent}</span>
                        </>
                      )}
                    </div>
                  </Link>

                  {isConfirming ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        autoFocus
                        onClick={() => handleDelete(s.id)}
                        aria-label="Confirm delete"
                        title="Confirm delete"
                        className="touch-target inline-flex size-7 items-center justify-center rounded-lg bg-danger text-accent-fg transition-colors duration-150 ease-out hover:opacity-90"
                      >
                        <Check className="size-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        aria-label="Cancel delete"
                        title="Cancel delete"
                        className="touch-target inline-flex size-7 items-center justify-center rounded-lg text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg"
                      >
                        <X className="size-3.5" aria-hidden="true" />
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
                      className="touch-target inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted opacity-0 transition-opacity duration-150 ease-out hover:bg-hover hover:text-danger group-hover:opacity-100 focus:opacity-100"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </nav>

        <div className="border-t border-border p-3 space-y-1">
          <Link
            href="/settings"
            aria-current={pathname === "/settings" ? "page" : undefined}
            className={`flex items-center justify-between rounded-lg px-3 py-2 text-xs font-medium transition-colors duration-150 ease-out ${
              pathname === "/settings"
                ? "bg-bg text-fg shadow-card ring-1 ring-border"
                : "text-fg hover:bg-hover/70"
            }`}
          >
            <span className="inline-flex items-center gap-2">
              <Settings className="size-4 text-muted" aria-hidden="true" />
              <span>Settings</span>
            </span>
          </Link>

          <div className="flex items-center justify-between px-3 py-1 text-xs text-muted">
            <div className="flex items-center gap-2 min-w-0">
              <ConnectionIndicator status={globalStatus} />
              {info?.version && (
                <span
                  title={info.workspace || `v${info.version}`}
                  className="truncate font-mono text-xs"
                >
                  v{info.version}
                </span>
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
                <Sun className="size-4" aria-hidden="true" />
              ) : (
                <Moon className="size-4" aria-hidden="true" />
              )}
            </IconButton>
          </div>
        </div>
      </aside>
    </>
  );
}
