import { useEffect, useMemo, useState } from "react";
import type { PermissionRequest, ToolInfo } from "@openharness/sdk";
import { useApp } from "./app-context";
import { client } from "./client";
import { errorMessage } from "./format";

export { useApp };

export function useSessions() {
  const { sessions, sessionsLoading, refreshSessions } = useApp();
  const topLevel = useMemo(
    () => sessions.filter((s) => !s.parentId),
    [sessions]
  );
  return {
    sessions: topLevel,
    loading: sessionsLoading,
    refresh: refreshSessions,
  };
}

export function useCatalog() {
  const { catalog, reloadCatalog } = useApp();

  const primaryAgents = useMemo(
    () => catalog.agents.filter((a) => a.mode !== "subagent"),
    [catalog.agents]
  );

  const defaultModel = useMemo(() => {
    const flagged = catalog.models.find((m) => m.isDefault);
    if (flagged) return flagged.id;
    if (catalog.info?.defaultModel) return catalog.info.defaultModel;
    return catalog.models[0]?.id ?? "";
  }, [catalog.models, catalog.info]);

  const defaultAgent = useMemo(() => {
    if (catalog.info?.defaultAgent) return catalog.info.defaultAgent;
    const build = primaryAgents.find((a) => a.name === "assistant");
    return build?.name ?? primaryAgents[0]?.name ?? "assistant";
  }, [catalog.info, primaryAgents]);

  const defaultRuntime = useMemo(() => {
    const def = catalog.runtimes.find((r) => r.isDefault);
    if (def) return def.id;
    if (catalog.info?.defaultRuntime) return catalog.info.defaultRuntime;
    return catalog.runtimes[0]?.id ?? "in-process";
  }, [catalog.runtimes, catalog.info]);

  return {
    ...catalog,
    primaryAgents,
    defaultModel,
    defaultAgent,
    defaultRuntime,
    refresh: reloadCatalog,
  };
}

export function usePermissions(sessionId?: string): PermissionRequest[] {
  const { permissions } = useApp();
  return useMemo(() => {
    const filtered = sessionId
      ? permissions.filter((p) => p.sessionId === sessionId)
      : permissions;
    return [...filtered].sort((a, b) => {
      const ta =
        typeof a.createdAt === "number"
          ? a.createdAt
          : new Date(a.createdAt).getTime();
      const tb =
        typeof b.createdAt === "number"
          ? b.createdAt
          : new Date(b.createdAt).getTime();
      return ta - tb;
    });
  }, [permissions, sessionId]);
}

export function useTools(agent?: string, enabled = true) {
  const { catalog } = useApp();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void client
      .tools(agent)
      .then((res) => {
        if (!cancelled) {
          setTools(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(errorMessage(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agent, enabled, catalog.version]);

  return { tools, loading, error };
}
