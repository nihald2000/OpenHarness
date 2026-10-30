import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { Link, usePathname, useRouter } from "@/lib/router";
import { client } from "@/lib/client";
import { errorMessage, isStatus, relativeTime } from "@/lib/format";
import { useApp, useCatalog, useSessions } from "@/lib/hooks";
import { Kbd } from "./kbd";
import {
  BrandLogo,
  ConnectionIndicator,
  IconButton,
  StatusDot,
} from "./ui";

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
  } = useApp();
  const { sessions, loading } = useSessions();
  const { info } = useCatalog();

  const [query, setQuery] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

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
        aria-label="Sessions"
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

        <div className="px-4 pt-2 pb-1">
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
