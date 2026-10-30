import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { McpPreset, McpServerAdminInfo } from "@/types/sdk";
import { client } from "@/lib/client";
import { useApp, useCatalog } from "@/lib/hooks";
import { ConfirmDialog } from "../plugins-tab";
import { Badge, Spinner } from "../ui";
import {
  buttonPrimary,
  buttonSecondary,
  Callout,
  Card,
  dangerButton,
  Field,
  inputCls,
  Modal,
  NumberField,
  parseNumber,
  secretName,
  SecretInput,
  SectionHeading,
  selectCls,
  Switch,
  useSettings,
} from "./controls";

const NAME_RE = /^[a-zA-Z0-9-_]+$/;
const SECRET_KEY_HINT_RE = /auth|token|key|secret|password|credential/i;

interface KvPair {
  key: string;
  value: string;
  secret: boolean;
  stored: boolean;
}

export function McpSection() {
  const { notify } = useApp();
  const { refresh: refreshCatalog } = useCatalog();
  const { handleError } = useSettings();

  const [servers, setServers] = useState<McpServerAdminInfo[]>([]);
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>(
    {}
  );
  const [expandedErrors, setExpandedErrors] = useState<Record<string, boolean>>(
    {}
  );
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Preset secret inputs
  const [presetSecrets, setPresetSecrets] = useState<
    Record<string, Record<string, string>>
  >({});

  // Custom server modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [transport, setTransport] = useState<"http" | "sse" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<KvPair[]>([]);
  const [command, setCommand] = useState("");
  const [extraArgs, setExtraArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [envVars, setEnvVars] = useState<KvPair[]>([]);
  const [timeoutMs, setTimeoutMs] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [srvList, presetList] = await Promise.all([
        client.mcpServers.list(),
        client.mcpServers.presets(),
      ]);
      setServers(srvList);
      setPresets(presetList);
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, [handleError]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const anyConnecting = servers.some((s) => s.status === "connecting");
  useEffect(() => {
    if (!anyConnecting) return;
    const id = setInterval(() => {
      void loadAll();
    }, 3000);
    return () => clearInterval(id);
  }, [anyConnecting, loadAll]);

  const openAddModal = () => {
    setEditingName(null);
    setName("");
    setTitle("");
    setTransport("http");
    setUrl("");
    setHeaders([]);
    setCommand("");
    setExtraArgs("");
    setCwd("");
    setEnvVars([]);
    setTimeoutMs("");
    setReadOnly(false);
    setFormError(null);
    setModalOpen(true);
  };

  const openEditModal = async (srv: McpServerAdminInfo) => {
    setEditingName(srv.name);
    setName(srv.name);
    setTitle(srv.title || "");
    const t =
      srv.transport === "stdio"
        ? "stdio"
        : srv.transport === "sse"
          ? "sse"
          : "http";
    setTransport(t);
    setUrl(srv.url || "");
    setCommand((srv.command || []).join(" "));
    setExtraArgs((srv.args || []).join("\n"));
    setCwd(srv.cwd || "");
    setTimeoutMs(srv.timeoutMs !== undefined ? String(srv.timeoutMs) : "");
    setReadOnly(Boolean(srv.readOnly));

    const hdrs: KvPair[] = Object.entries(srv.headers ?? {}).map(([k, v]) => ({
      key: k,
      value: /\{secret:[^}]+\}/i.test(v) ? "" : v,
      secret: SECRET_KEY_HINT_RE.test(k) || /\{secret:[^}]+\}/i.test(v),
      stored: /\{secret:[^}]+\}/i.test(v),
    }));
    setHeaders(hdrs);

    const envs: KvPair[] = Object.entries(srv.env ?? {}).map(([k, v]) => ({
      key: k,
      value: /\{secret:[^}]+\}/i.test(v) ? "" : v,
      secret: SECRET_KEY_HINT_RE.test(k) || /\{secret:[^}]+\}/i.test(v),
      stored: /\{secret:[^}]+\}/i.test(v),
    }));
    setEnvVars(envs);

    setFormError(null);
    setModalOpen(true);
  };

  const handleSaveServer = async () => {
    setFormError(null);
    const trimmedName = name.trim();
    if (!NAME_RE.test(trimmedName)) {
      setFormError("Server name must match ^[a-zA-Z0-9-_]+$.");
      return;
    }

    const tParsed = parseNumber(timeoutMs, { int: true, min: 100 });
    if (tParsed.error) {
      setFormError(`Timeout: ${tParsed.error}`);
      return;
    }

    const cfg: Record<string, unknown> = {
      transport,
      readOnly,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(tParsed.value !== undefined ? { timeoutMs: tParsed.value } : {}),
    };

    setBusyKey("save-modal");
    try {
      if (transport === "stdio") {
        const parts = command
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (parts.length === 0) {
          setFormError("Command is required for StdIO transport.");
          setBusyKey(null);
          return;
        }
        const extra = extraArgs
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        cfg.command = parts[0];
        cfg.args = [...parts.slice(1), ...extra];
        if (cwd.trim()) cfg.cwd = cwd.trim();

        const envOut: Record<string, string> = {};
        for (const pair of envVars) {
          const k = pair.key.trim();
          if (!k) continue;
          if (pair.secret) {
            const sName = secretName(["MCP", trimmedName, k]);
            if (pair.value.trim()) {
              await client.secrets.set(sName, pair.value.trim());
            }
            envOut[k] = `{secret:${sName}}`;
          } else {
            envOut[k] = pair.value;
          }
        }
        if (Object.keys(envOut).length > 0) cfg.env = envOut;
      } else {
        if (!/^https?:\/\//i.test(url.trim())) {
          setFormError("URL must start with http:// or https://.");
          setBusyKey(null);
          return;
        }
        cfg.url = url.trim();

        const hdrOut: Record<string, string> = {};
        for (const pair of headers) {
          const k = pair.key.trim();
          if (!k) continue;
          if (pair.secret) {
            const sName = secretName(["MCP", trimmedName, k]);
            const rawVal = pair.value.trim();
            if (rawVal) {
              const bearerMatch = /^Bearer\s+(.+)$/i.exec(rawVal);
              const secretPayload = bearerMatch ? bearerMatch[1]! : rawVal;
              await client.secrets.set(sName, secretPayload);
              hdrOut[k] = bearerMatch
                ? `Bearer {secret:${sName}}`
                : `{secret:${sName}}`;
            } else {
              hdrOut[k] =
                k.toLowerCase() === "authorization"
                  ? `Bearer {secret:${sName}}`
                  : `{secret:${sName}}`;
            }
          } else {
            hdrOut[k] = pair.value;
          }
        }
        if (Object.keys(hdrOut).length > 0) cfg.headers = hdrOut;
      }

      await client.mcpServers.put(trimmedName, cfg);
      await Promise.all([loadAll(), refreshCatalog()]);
      notify("success", `Saved MCP server ${trimmedName}.`);
      setModalOpen(false);
    } catch (err) {
      handleError(err);
    } finally {
      setBusyKey(null);
    }
  };

  const handleInstallPreset = async (preset: McpPreset) => {
    setBusyKey(`preset:${preset.id}`);
    try {
      const values = presetSecrets[preset.id] ?? {};
      for (const req of preset.requiredSecrets ?? []) {
        const val = values[req.name]?.trim();
        if (val) {
          await client.secrets.set(req.name, val);
        }
      }
      await client.mcpServers.install(preset.id);
      setPresetSecrets((prev) => ({ ...prev, [preset.id]: {} }));
      await Promise.all([loadAll(), refreshCatalog()]);
      notify("success", `Installed ${preset.title || preset.id}.`);
    } catch (err) {
      handleError(err);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="space-y-4">
      <SectionHeading
        title="MCP servers"
        description="Manage Model Context Protocol servers and install pre-configured catalog integrations."
      />

      <Callout tone="info">
        MCP tools are used by the agent through code execution (Code Mode).
      </Callout>

      <Card
        title="Connected servers"
        actions={
          <>
            <button
              type="button"
              onClick={() => void loadAll()}
              className={buttonSecondary}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={openAddModal}
              className={buttonPrimary}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              <span>Add custom server</span>
            </button>
          </>
        }
      >
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-muted">
            <Spinner />
            <span>Loading MCP servers...</span>
          </div>
        ) : servers.length === 0 ? (
          <p className="py-4 text-center text-muted">
            No MCP servers configured.
          </p>
        ) : (
          <div className="space-y-2.5">
            {servers.map((srv) => {
              const isConnecting = srv.status === "connecting";
              const isConnected = srv.status === "connected";
              const isFailed = srv.status === "failed";
              const showTools = Boolean(expandedTools[srv.name]);
              const showFullErr = Boolean(expandedErrors[srv.name]);

              return (
                <div
                  key={srv.name}
                  className="rounded-lg border border-border bg-bg p-3 space-y-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="relative inline-flex size-2">
                        {isConnecting && (
                          <span className="absolute inset-0 rounded-full bg-accent animate-ping opacity-40" />
                        )}
                        <span
                          className={`relative size-2 rounded-full ${
                            isConnected
                              ? "bg-success"
                              : isFailed
                                ? "bg-danger"
                                : isConnecting
                                  ? "bg-accent"
                                  : "bg-muted"
                          }`}
                        />
                      </span>
                      <span className="font-semibold text-fg">
                        {srv.title || srv.name}
                      </span>
                      <span className="font-mono text-[11px] text-muted">
                        ({srv.name})
                      </span>
                      <Badge
                        tone={
                          isConnected
                            ? "success"
                            : isFailed
                              ? "danger"
                              : isConnecting
                                ? "accent"
                                : "neutral"
                        }
                      >
                        {srv.status}
                      </Badge>
                      {srv.transport && (
                        <Badge tone="neutral">{srv.transport}</Badge>
                      )}
                      {srv.readOnly && (
                        <Badge tone="accent">read-only</Badge>
                      )}
                      <span className="font-mono text-[11px] text-muted">
                        {srv.tools?.length ?? srv.toolsCount ?? 0} tools
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <Switch
                        checked={srv.enabled !== false}
                        label={`Enable ${srv.name}`}
                        onChange={(next) => {
                          void (async () => {
                            try {
                              await client.mcpServers.enable(srv.name, next);
                              await Promise.all([loadAll(), refreshCatalog()]);
                            } catch (err) {
                              handleError(err);
                            }
                          })();
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          void (async () => {
                            setBusyKey(`reconn:${srv.name}`);
                            try {
                              await client.mcpServers.reconnect(srv.name);
                              await loadAll();
                            } catch (err) {
                              handleError(err);
                            } finally {
                              setBusyKey(null);
                            }
                          })();
                        }}
                        disabled={busyKey === `reconn:${srv.name}`}
                        className={buttonSecondary}
                      >
                        {busyKey === `reconn:${srv.name}` && <Spinner />}
                        <span>Reconnect</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void openEditModal(srv)}
                        className={buttonSecondary}
                      >
                        <Pencil className="size-3.5" aria-hidden="true" />
                        <span>Edit</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(srv.name)}
                        className={dangerButton}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                        <span>Remove</span>
                      </button>
                    </div>
                  </div>

                  {srv.error && (
                    <div className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
                      <span>
                        {showFullErr || srv.error.length <= 180
                          ? srv.error
                          : `${srv.error.slice(0, 180)}...`}
                      </span>
                      {srv.error.length > 180 && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedErrors((p) => ({
                              ...p,
                              [srv.name]: !showFullErr,
                            }))
                          }
                          className="ml-1.5 underline"
                        >
                          {showFullErr ? "Show less" : "Show more"}
                        </button>
                      )}
                    </div>
                  )}

                  {srv.tools && srv.tools.length > 0 && (
                    <div>
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedTools((p) => ({
                            ...p,
                            [srv.name]: !showTools,
                          }))
                        }
                        aria-expanded={showTools}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-muted hover:text-fg"
                      >
                        <ChevronDown
                          className={`size-3.5 transition-transform ${
                            showTools ? "rotate-180" : ""
                          }`}
                          aria-hidden="true"
                        />
                        <span>Tools ({srv.tools.length})</span>
                      </button>
                      {showTools && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {srv.tools.map((t) => (
                            <span
                              key={t}
                              className="rounded border border-border bg-code px-1.5 py-0.5 font-mono text-[10px] text-fg"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title="Catalog"
        description="One-click presets for popular MCP integrations."
      >
        {presets.length === 0 ? (
          <p className="py-4 text-center text-muted">No presets available.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {presets.map((preset) => {
              const installed = servers.some((s) => s.name === preset.id);
              return (
                <div
                  key={preset.id}
                  className="flex flex-col justify-between rounded-lg border border-border bg-bg p-3 space-y-2.5"
                >
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-fg">
                          {preset.title || preset.id}
                        </span>
                        {preset.category && (
                          <Badge tone="neutral">{preset.category}</Badge>
                        )}
                      </div>
                      {installed && <Badge tone="success">Installed</Badge>}
                    </div>
                    {preset.description && (
                      <p className="text-[11px] text-muted">
                        {preset.description}
                      </p>
                    )}
                    {preset.runtimeNote && (
                      <p className="font-mono text-[10px] text-muted">
                        {preset.runtimeNote}
                      </p>
                    )}

                    {preset.requiredSecrets &&
                      preset.requiredSecrets.length > 0 && (
                        <div className="space-y-1.5 pt-1">
                          {preset.requiredSecrets.map((sec) => (
                            <div key={sec.name}>
                              <div className="mb-0.5 flex items-center justify-between text-[11px]">
                                <span className="font-mono text-fg">
                                  {sec.name}
                                </span>
                                {sec.stored && (
                                  <Badge tone="success">Stored</Badge>
                                )}
                              </div>
                              <SecretInput
                                value={
                                  presetSecrets[preset.id]?.[sec.name] ?? ""
                                }
                                onChange={(val) =>
                                  setPresetSecrets((p) => ({
                                    ...p,
                                    [preset.id]: {
                                      ...(p[preset.id] ?? {}),
                                      [sec.name]: val,
                                    },
                                  }))
                                }
                                placeholder={
                                  sec.stored
                                    ? "Leave blank to keep stored secret"
                                    : "Enter secret value"
                                }
                              />
                            </div>
                          ))}
                        </div>
                      )}
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-border/60">
                    {preset.homepage ? (
                      <a
                        href={preset.homepage}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                      >
                        <span>Docs</span>
                        <ExternalLink className="size-3" aria-hidden="true" />
                      </a>
                    ) : (
                      <span />
                    )}
                    <button
                      type="button"
                      disabled={busyKey === `preset:${preset.id}`}
                      onClick={() => void handleInstallPreset(preset)}
                      className={buttonPrimary}
                    >
                      {busyKey === `preset:${preset.id}` ? (
                        <Spinner />
                      ) : (
                        <Plus className="size-3.5" aria-hidden="true" />
                      )}
                      <span>Install</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal
        open={modalOpen}
        wide
        title={
          editingName ? `Edit MCP server ${editingName}` : "Add custom server"
        }
        onClose={() => setModalOpen(false)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className={buttonSecondary}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busyKey === "save-modal"}
              onClick={() => void handleSaveServer()}
              className={buttonPrimary}
            >
              {busyKey === "save-modal" && <Spinner />}
              <span>Save server</span>
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            {(props) => (
              <input
                {...props}
                type="text"
                readOnly={Boolean(editingName)}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="github"
                className={`${inputCls} font-mono`}
              />
            )}
          </Field>
          <Field label="Title (optional)">
            {(props) => (
              <input
                {...props}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="GitHub MCP"
                className={inputCls}
              />
            )}
          </Field>
          <Field label="Transport">
            {(props) => (
              <select
                {...props}
                value={transport}
                onChange={(e) =>
                  setTransport(e.target.value as "http" | "sse" | "stdio")
                }
                className={selectCls}
              >
                <option value="http">Streamable HTTP</option>
                <option value="sse">SSE (Legacy) remote</option>
                <option value="stdio">StdIO</option>
              </select>
            )}
          </Field>
          <NumberField
            label="Timeout"
            value={timeoutMs}
            onChange={setTimeoutMs}
            unit="ms"
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2">
          <span className="font-medium text-fg">Read-only server</span>
          <Switch
            checked={readOnly}
            onChange={setReadOnly}
            label="Read-only server"
          />
        </div>

        {transport === "stdio" ? (
          <>
            <Field label="Command">
              {(props) => (
                <input
                  {...props}
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx -y @modelcontextprotocol/server-everything"
                  className={`${inputCls} font-mono`}
                />
              )}
            </Field>
            <Field label="Extra arguments (one per line)">
              {(props) => (
                <textarea
                  {...props}
                  rows={2}
                  value={extraArgs}
                  onChange={(e) => setExtraArgs(e.target.value)}
                  className={`${inputCls} font-mono`}
                />
              )}
            </Field>
            <Field label="Working directory">
              {(props) => (
                <input
                  {...props}
                  type="text"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  className={`${inputCls} font-mono`}
                />
              )}
            </Field>
          </>
        ) : (
          <Field label="URL">
            {(props) => (
              <input
                {...props}
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
                className={`${inputCls} font-mono`}
              />
            )}
          </Field>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-fg">
              {transport === "stdio" ? "Environment variables" : "Headers"}
            </span>
            <button
              type="button"
              onClick={() => {
                const setter = transport === "stdio" ? setEnvVars : setHeaders;
                setter((prev) => [
                  ...prev,
                  { key: "", value: "", secret: false, stored: false },
                ]);
              }}
              className={buttonSecondary}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              <span>Add</span>
            </button>
          </div>

          {(transport === "stdio" ? envVars : headers).map((pair, idx) => {
            const setter = transport === "stdio" ? setEnvVars : setHeaders;
            return (
              <div key={idx} className="flex items-center gap-2">
                <input
                  type="text"
                  value={pair.key}
                  onChange={(e) => {
                    const k = e.target.value;
                    setter((prev) =>
                      prev.map((item, i) =>
                        i === idx
                          ? {
                              ...item,
                              key: k,
                              secret:
                                item.secret || SECRET_KEY_HINT_RE.test(k),
                            }
                          : item
                      )
                    );
                  }}
                  placeholder="Key"
                  className={`${inputCls} w-1/3 font-mono`}
                />
                <input
                  type={pair.secret ? "password" : "text"}
                  value={pair.value}
                  onChange={(e) => {
                    const v = e.target.value;
                    setter((prev) =>
                      prev.map((item, i) =>
                        i === idx ? { ...item, value: v } : item
                      )
                    );
                  }}
                  placeholder={pair.stored ? "Stored" : "Value"}
                  className={`${inputCls} flex-1 font-mono`}
                />
                {pair.stored && <Badge tone="success">Stored</Badge>}
                <label className="flex items-center gap-1 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={pair.secret}
                    onChange={(e) => {
                      const s = e.target.checked;
                      setter((prev) =>
                        prev.map((item, i) =>
                          i === idx ? { ...item, secret: s } : item
                        )
                      );
                    }}
                  />
                  <span>Secret</span>
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setter((prev) => prev.filter((_, i) => i !== idx))
                  }
                  aria-label="Remove row"
                  className="text-muted hover:text-danger"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>

        {formError && (
          <p role="alert" className="text-xs text-danger">
            {formError}
          </p>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Remove MCP server "${deleteTarget ?? ""}"?`}
        description="This removes the MCP server configuration."
        confirmLabel="Remove"
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) {
            void (async () => {
              try {
                await client.mcpServers.remove(target);
                await Promise.all([loadAll(), refreshCatalog()]);
                notify("success", `Removed MCP server ${target}.`);
              } catch (err) {
                handleError(err);
              }
            })();
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
