import { useCallback, useEffect, useState } from "react";
import {
  CodeXml,
  Cpu,
  FolderCog,
  Gauge,
  KeyRound,
  LogOut,
  Menu,
  Plug,
  Puzzle,
  RefreshCw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import type { SettingsPreviewResponse } from "@openharness/sdk";
import { client } from "@/lib/client";
import { errorMessage, isStatus } from "@/lib/format";
import { useApp } from "@/lib/hooks";
import { useAdmin } from "@/lib/use-admin";
import { PluginsTab } from "../plugins-tab";
import { Badge, IconButton } from "../ui";
import { AdvancedSection } from "./advanced-section";
import {
  buttonSecondary,
  Callout,
  Card,
  Loading,
  SectionHeading,
  selectCls,
  SettingsProvider,
} from "./controls";
import { GeneralSection } from "./general-section";
import { GuardrailsSection } from "./guardrails-section";
import { LimitsSection } from "./limits-section";
import { McpSection } from "./mcp-section";
import { PermissionsSection } from "./permissions-section";
import { ProvidersSection } from "./providers-section";
import { SecretsSection } from "./secrets-section";
import { SignInCard } from "./sign-in";
import { ToolsSection } from "./tools-section";

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "providers", label: "Models & providers", icon: Cpu },
  { id: "mcp", label: "MCP servers", icon: Plug },
  { id: "plugins", label: "Plugins & runtimes", icon: Puzzle },
  { id: "tools", label: "Tools & Code Mode", icon: CodeXml },
  { id: "permissions", label: "Permissions", icon: ShieldCheck },
  { id: "limits", label: "Limits & context", icon: Gauge },
  { id: "guardrails", label: "Guardrails", icon: ShieldAlert },
  { id: "secrets", label: "Secrets", icon: KeyRound },
  { id: "advanced", label: "Advanced", icon: FolderCog },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function isValidSection(val: string): val is SectionId {
  return SECTIONS.some((s) => s.id === val);
}

export function SettingsView() {
  const { setSidebarOpen } = useApp();
  const { admin, authDisabled, loading: adminLoading, expired, user, logout, markSignedOut } =
    useAdmin();

  const [view, setView] = useState<SettingsPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeSection, setActiveSection] = useState<SectionId>("general");
  const [mountedSections, setMountedSections] = useState<Set<SectionId>>(
    () => new Set(["general"])
  );

  const selectSection = useCallback((id: SectionId, updateHash = true) => {
    setActiveSection(id);
    setMountedSections((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    if (updateHash && typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${id}`);
    }
  }, []);

  useEffect(() => {
    const syncFromHash = () => {
      const raw = window.location.hash.replace(/^#/, "");
      if (isValidSection(raw)) {
        selectSection(raw, false);
      }
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [selectSection]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await client.settings.get();
      setView(data);
    } catch (err) {
      if (isStatus(err, 401) || isStatus(err, 403)) {
        markSignedOut(true);
        setView(null);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  }, [markSignedOut]);

  useEffect(() => {
    if (admin) {
      void loadSettings();
    } else {
      setView(null);
      setError(null);
    }
  }, [admin, loadSettings]);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-glass px-4 py-2 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
          <IconButton
            label="Open sessions menu"
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden"
          >
            <Menu className="size-4" aria-hidden="true" />
          </IconButton>
          <Settings className="size-4 text-accent" aria-hidden="true" />
          <h1 className="text-sm font-semibold text-fg">Settings</h1>
          {admin && view?.file && (
            <span className="hidden sm:inline truncate font-mono text-xs text-muted">
              {view.file}
            </span>
          )}
          {admin && view && !view.fixedConfig && (
            <Badge
              tone="success"
              title="Saved changes are applied without restarting the server"
            >
              Applies live
            </Badge>
          )}
        </div>

        {admin && !authDisabled && (
          <div className="flex items-center gap-3">
            {user && <span className="hidden max-w-44 truncate text-xs text-muted sm:block" title={user.email}>{user.name}</span>}
            <button
              type="button"
              onClick={() => void logout()}
              className={buttonSecondary}
            >
              <LogOut className="size-3.5" aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        {adminLoading ? (
          <Loading label="Checking admin session..." />
        ) : !admin ? (
          <SignInCard expired={expired} />
        ) : error ? (
          <div className="mx-auto max-w-xl p-6 space-y-3">
            <Callout tone="danger">Could not load settings: {error}</Callout>
            <button
              type="button"
              onClick={() => void loadSettings()}
              className={buttonSecondary}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              <span>Retry</span>
            </button>
          </div>
        ) : loading || !view ? (
          <Loading label="Loading settings..." />
        ) : (
          <SettingsProvider view={view} refresh={loadSettings}>
            <div className="mx-auto max-w-6xl p-4 sm:p-6 space-y-4">
              {view.fixedConfig && (
                <Callout tone="warning">
                  This server runs with an embedded (in-process) configuration.
                  Changes are written to{" "}
                  <code className="font-mono">{view.file}</code> but are not
                  applied until the server is restarted with that file.
                </Callout>
              )}

              {!view.exists && (
                <Callout tone="info">
                  No project config file exists yet - it will be created at{" "}
                  <code className="font-mono">{view.file}</code> on the first
                  save.
                </Callout>
              )}

              <div className="md:hidden">
                <select
                  aria-label="Settings section"
                  value={activeSection}
                  onChange={(e) => selectSection(e.target.value as SectionId)}
                  className={selectCls}
                >
                  {SECTIONS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 gap-6 md:grid-cols-[13.5rem_minmax(0,1fr)]">
                <nav
                  aria-label="Settings sections"
                  className="hidden md:block sticky top-4 self-start space-y-1"
                >
                  {SECTIONS.map((s) => {
                    const Icon = s.icon;
                    const active = activeSection === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        aria-current={active ? "page" : undefined}
                        onClick={() => selectSection(s.id)}
                        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors ${
                          active
                            ? "bg-hover text-fg"
                            : "text-muted hover:bg-hover/60 hover:text-fg"
                        }`}
                      >
                        <Icon
                          className={`size-4 shrink-0 ${
                            active ? "text-accent" : "text-muted"
                          }`}
                          aria-hidden="true"
                        />
                        <span className="truncate">{s.label}</span>
                      </button>
                    );
                  })}
                </nav>

                <div className="min-w-0">
                  {mountedSections.has("general") && (
                    <div
                      className={activeSection === "general" ? "" : "hidden"}
                    >
                      <GeneralSection />
                    </div>
                  )}
                  {mountedSections.has("providers") && (
                    <div
                      className={activeSection === "providers" ? "" : "hidden"}
                    >
                      <ProvidersSection />
                    </div>
                  )}
                  {mountedSections.has("mcp") && (
                    <div className={activeSection === "mcp" ? "" : "hidden"}>
                      <McpSection />
                    </div>
                  )}
                  {mountedSections.has("plugins") && (
                    <div
                      className={activeSection === "plugins" ? "" : "hidden"}
                    >
                      <div className="space-y-4">
                        <SectionHeading
                          title="Plugins & runtimes"
                          description="Attach or detach server plugins and select the default execution runtime."
                        />
                        <Card>
                          <PluginsTab inSettings />
                        </Card>
                      </div>
                    </div>
                  )}
                  {mountedSections.has("tools") && (
                    <div className={activeSection === "tools" ? "" : "hidden"}>
                      <ToolsSection />
                    </div>
                  )}
                  {mountedSections.has("permissions") && (
                    <div
                      className={
                        activeSection === "permissions" ? "" : "hidden"
                      }
                    >
                      <PermissionsSection />
                    </div>
                  )}
                  {mountedSections.has("limits") && (
                    <div className={activeSection === "limits" ? "" : "hidden"}>
                      <LimitsSection />
                    </div>
                  )}
                  {mountedSections.has("guardrails") && (
                    <div
                      className={activeSection === "guardrails" ? "" : "hidden"}
                    >
                      <GuardrailsSection />
                    </div>
                  )}
                  {mountedSections.has("secrets") && (
                    <div
                      className={activeSection === "secrets" ? "" : "hidden"}
                    >
                      <SecretsSection />
                    </div>
                  )}
                  {mountedSections.has("advanced") && (
                    <div
                      className={activeSection === "advanced" ? "" : "hidden"}
                    >
                      <AdvancedSection />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </SettingsProvider>
        )}
      </div>
    </div>
  );
}
