"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentInfo,
  CommandInfo,
  ConnectionStatus,
  McpServerInfo,
  ModelInfo,
  OpenHarnessEvent,
  PermissionReply,
  PermissionRequest,
  PluginInfo,
  RuntimeInfo,
  ServerInfo,
  Session,
  SkillInfo,
} from "@openharness/sdk";
import { client } from "./client";
import { errorMessage, isStatus } from "./format";

export type ToastKind = "info" | "success" | "error";

export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
}

export interface DraftSelection {
  agent?: string;
  model?: string;
  runtime?: string;
}

export interface CatalogState {
  info: ServerInfo | null;
  agents: AgentInfo[];
  models: ModelInfo[];
  commands: CommandInfo[];
  skills: SkillInfo[];
  mcp: McpServerInfo[];
  plugins: PluginInfo[];
  runtimes: RuntimeInfo[];
  loading: boolean;
  error: string | null;
  pluginError: string | null;
  runtimeError: string | null;
  version: number;
}

export interface AppContextValue {
  theme: "dark" | "light";
  toggleTheme: () => void;
  toasts: ToastItem[];
  notify: (kind: ToastKind, message: string) => void;
  dismissToast: (id: string) => void;
  sessions: Session[];
  sessionsLoading: boolean;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  refreshSessions: () => Promise<void>;
  upsertSession: (session: Session) => void;
  removeSession: (id: string) => void;
  permissions: PermissionRequest[];
  loadPermissions: (sessionId?: string) => Promise<void>;
  replyPermission: (id: string, reply: PermissionReply) => Promise<boolean>;
  ingestEvent: (event: OpenHarnessEvent) => void;
  globalStatus: ConnectionStatus;
  catalog: CatalogState;
  reloadCatalog: () => Promise<void>;
  draft: DraftSelection;
  setDraftField: <K extends keyof DraftSelection>(key: K, value: DraftSelection[K] | null) => void;
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  capabilitiesOpen: boolean;
  setCapabilitiesOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

const AppContext = createContext<AppContextValue | null>(null);

const DRAFT_STORAGE_KEY = "oh-draft";
const THEME_STORAGE_KEY = "oh-theme";

function sortSessions(list: Session[]): Session[] {
  return [...list].sort((a, b) => {
    const ta = typeof a.updatedAt === "number" ? a.updatedAt : new Date(a.updatedAt).getTime();
    const tb = typeof b.updatedAt === "number" ? b.updatedAt : new Date(b.updatedAt).getTime();
    return tb - ta;
  });
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const deletedIds = useRef<Set<string>>(new Set());

  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [globalStatus, setGlobalStatus] = useState<ConnectionStatus>("connecting");

  const [catalog, setCatalog] = useState<CatalogState>({
    info: null,
    agents: [],
    models: [],
    commands: [],
    skills: [],
    mcp: [],
    plugins: [],
    runtimes: [],
    loading: true,
    error: null,
    pluginError: null,
    runtimeError: null,
    version: 0,
  });

  const [draft, setDraft] = useState<DraftSelection>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);

  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
      if (savedTheme === "light") {
        setTheme("light");
      }
      const savedDraft = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (savedDraft) {
        const parsed = JSON.parse(savedDraft) as DraftSelection;
        if (parsed && typeof parsed === "object") {
          setDraft({
            agent: typeof parsed.agent === "string" ? parsed.agent : undefined,
            model: typeof parsed.model === "string" ? parsed.model : undefined,
            runtime: typeof parsed.runtime === "string" ? parsed.runtime : undefined,
          });
        }
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      try {
        const root = document.documentElement;
        if (next === "light") {
          root.classList.add("light");
          root.classList.remove("dark");
          root.style.colorScheme = "light";
        } else {
          root.classList.add("dark");
          root.classList.remove("light");
          root.style.colorScheme = "dark";
        }
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (kind: ToastKind, message: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
      const duration = kind === "error" ? 7000 : 4000;
      const timer = setTimeout(() => {
        dismissToast(id);
      }, duration);
      toastTimers.current.set(id, timer);
    },
    [dismissToast]
  );

  const setDraftField = useCallback(
    <K extends keyof DraftSelection>(key: K, value: DraftSelection[K] | null) => {
      setDraft((prev) => {
        const next: DraftSelection = { ...prev };
        if (!value) {
          delete next[key];
        } else {
          next[key] = value;
        }
        try {
          localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
    },
    []
  );

  const upsertSession = useCallback((incoming: Session) => {
    if (deletedIds.current.has(incoming.id)) return;
    setSessions((prev) => {
      const existingIdx = prev.findIndex((s) => s.id === incoming.id);
      if (existingIdx !== -1) {
        const existing = prev[existingIdx]!;
        const tExisting =
          typeof existing.updatedAt === "number"
            ? existing.updatedAt
            : new Date(existing.updatedAt).getTime();
        const tIncoming =
          typeof incoming.updatedAt === "number"
            ? incoming.updatedAt
            : new Date(incoming.updatedAt).getTime();
        if (tIncoming < tExisting) return prev;
        const copy = [...prev];
        copy[existingIdx] = incoming;
        return sortSessions(copy);
      }
      return sortSessions([incoming, ...prev]);
    });
  }, []);

  const removeSession = useCallback((id: string) => {
    deletedIds.current.add(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setPermissions((prev) => prev.filter((p) => p.sessionId !== id));
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await client.session.list(200);
      setSessions(
        sortSessions(list.filter((s) => !deletedIds.current.has(s.id)))
      );
    } catch (err) {
      notify("error", `Could not load sessions: ${errorMessage(err)}`);
    } finally {
      setSessionsLoading(false);
    }
  }, [notify]);

  const loadPermissions = useCallback(async (sessionId?: string) => {
    try {
      const list = await client.permissions.list(sessionId);
      setPermissions((prev) => {
        if (!sessionId) return list;
        const others = prev.filter((p) => p.sessionId !== sessionId);
        return [...others, ...list];
      });
    } catch {
      // ignore background permission fetch errors
    }
  }, []);

  const replyPermission = useCallback(
    async (id: string, reply: PermissionReply): Promise<boolean> => {
      try {
        await client.permissions.reply(id, reply);
        setPermissions((prev) => prev.filter((p) => p.id !== id));
        return true;
      } catch (err) {
        if (isStatus(err, 404)) {
          setPermissions((prev) => prev.filter((p) => p.id !== id));
          notify("info", "That approval request is no longer pending.");
          return false;
        }
        notify("error", `Could not send reply: ${errorMessage(err)}`);
        return false;
      }
    },
    [notify]
  );

  const ingestEvent = useCallback(
    (event: OpenHarnessEvent) => {
      switch (event.type) {
        case "session.updated":
          upsertSession(event.session);
          break;
        case "session.deleted":
          removeSession(event.sessionId);
          break;
        case "permission.asked":
          setPermissions((prev) => {
            if (prev.some((p) => p.id === event.request.id)) return prev;
            return [...prev, event.request];
          });
          break;
        case "permission.replied":
          setPermissions((prev) => prev.filter((p) => p.id !== event.requestId));
          break;
        default:
          break;
      }
    },
    [removeSession, upsertSession]
  );

  const reloadCatalog = useCallback(async () => {
    setCatalog((prev) => ({ ...prev, loading: true }));
    const [
      infoRes,
      agentsRes,
      modelsRes,
      commandsRes,
      skillsRes,
      mcpRes,
      pluginsRes,
      runtimesRes,
    ] = await Promise.allSettled([
      client.info(),
      client.agents(),
      client.models(),
      client.commands(),
      client.skills(),
      client.mcp(),
      client.plugins.list(),
      client.runtimes.list(),
    ]);

    const coreErrors: string[] = [];
    if (infoRes.status === "rejected") coreErrors.push(errorMessage(infoRes.reason));
    if (agentsRes.status === "rejected") coreErrors.push(errorMessage(agentsRes.reason));
    if (modelsRes.status === "rejected") coreErrors.push(errorMessage(modelsRes.reason));

    const agents = agentsRes.status === "fulfilled" ? agentsRes.value : [];
    const models = modelsRes.status === "fulfilled" ? modelsRes.value : [];
    const runtimes = runtimesRes.status === "fulfilled" ? runtimesRes.value : [];

    setCatalog((prev) => ({
      info: infoRes.status === "fulfilled" ? infoRes.value : prev.info,
      agents,
      models,
      commands: commandsRes.status === "fulfilled" ? commandsRes.value : [],
      skills: skillsRes.status === "fulfilled" ? skillsRes.value : [],
      mcp: mcpRes.status === "fulfilled" ? mcpRes.value : [],
      plugins: pluginsRes.status === "fulfilled" ? pluginsRes.value : [],
      runtimes,
      loading: false,
      error: coreErrors[0] ?? null,
      pluginError:
        pluginsRes.status === "rejected" ? errorMessage(pluginsRes.reason) : null,
      runtimeError:
        runtimesRes.status === "rejected" ? errorMessage(runtimesRes.reason) : null,
      version: prev.version + 1,
    }));

    // Validate draft against loaded catalog
    setDraft((prev) => {
      let changed = false;
      const next = { ...prev };
      if (
        next.agent &&
        agents.length > 0 &&
        !agents.some((a) => a.name === next.agent && a.mode !== "subagent")
      ) {
        delete next.agent;
        changed = true;
      }
      if (next.model && models.length > 0 && !models.some((m) => m.id === next.model)) {
        delete next.model;
        changed = true;
      }
      if (
        next.runtime &&
        runtimes.length > 0 &&
        !runtimes.some((r) => r.id === next.runtime)
      ) {
        delete next.runtime;
        changed = true;
      }
      if (changed) {
        try {
          localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(next));
        } catch {
          // ignore
        }
      }
      return changed ? next : prev;
    });
  }, []);

  useEffect(() => {
    let active = true;
    let openedOnce = false;

    void reloadCatalog();
    void loadPermissions();

    const sub = client.subscribe(
      undefined,
      (ev) => {
        if (!active) return;
        ingestEvent(ev);
      },
      (status) => {
        if (!active) return;
        setGlobalStatus(status);
        if (status === "open") {
          void refreshSessions();
          if (openedOnce) {
            void loadPermissions();
          }
          openedOnce = true;
        }
      },
      () => {
        // stream errors handled via status updates
      }
    );

    return () => {
      active = false;
      sub.close();
    };
  }, [ingestEvent, loadPermissions, refreshSessions, reloadCatalog]);

  useEffect(() => {
    if (globalStatus === "open" && catalog.error) {
      void reloadCatalog();
    }
  }, [globalStatus, catalog.error, reloadCatalog]);

  const value = useMemo<AppContextValue>(
    () => ({
      theme,
      toggleTheme,
      toasts,
      notify,
      dismissToast,
      sessions,
      sessionsLoading,
      activeSessionId,
      setActiveSessionId,
      refreshSessions,
      upsertSession,
      removeSession,
      permissions,
      loadPermissions,
      replyPermission,
      ingestEvent,
      globalStatus,
      catalog,
      reloadCatalog,
      draft,
      setDraftField,
      sidebarOpen,
      setSidebarOpen,
      capabilitiesOpen,
      setCapabilitiesOpen,
    }),
    [
      theme,
      toggleTheme,
      toasts,
      notify,
      dismissToast,
      sessions,
      sessionsLoading,
      activeSessionId,
      refreshSessions,
      upsertSession,
      removeSession,
      permissions,
      loadPermissions,
      replyPermission,
      ingestEvent,
      globalStatus,
      catalog,
      reloadCatalog,
      draft,
      setDraftField,
      sidebarOpen,
      capabilitiesOpen,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useApp must be used within AppProvider");
  }
  return ctx;
}
