import { useState } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { client } from "@/lib/client";
import { stringify } from "@/lib/format";
import { ConfirmDialog } from "../plugins-tab";
import { Badge, Spinner } from "../ui";
import {
  asString,
  buttonPrimary,
  buttonSecondary,
  Card,
  dangerButton,
  describeSecretValue,
  Field,
  inputCls,
  isRecord,
  Modal,
  NumberField,
  parseNumber,
  secretName,
  SecretInput,
  SectionHeading,
  selectCls,
  useSettings,
} from "./controls";

const ID_RE = /^[a-zA-Z0-9-_]+$/;

interface ModelDraftRow {
  id: string;
  name: string;
  contextWindow: string;
  extra: Record<string, unknown>;
}

export function ProvidersSection() {
  const { view, saveSections, handleError } = useSettings();

  const cfgProviders = isRecord(view.config.providers)
    ? (view.config.providers as Record<string, Record<string, unknown>>)
    : {};
  const effProviders = isRecord(view.effective.providers)
    ? (view.effective.providers as Record<string, Record<string, unknown>>)
    : {};

  const allIds = Array.from(
    new Set([...Object.keys(effProviders), ...Object.keys(cfgProviders)])
  );

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Modal fields
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<"openai" | "plugin">("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("");
  const [pluginKind, setPluginKind] = useState("");
  const [pluginOpts, setPluginOpts] = useState("{}");
  const [keyMode, setKeyMode] = useState<"keep" | "replace" | "remove">("keep");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [models, setModels] = useState<ModelDraftRow[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const openAdd = () => {
    setEditingId(null);
    setId("");
    setName("");
    setType("openai");
    setBaseUrl("https://api.openai.com/v1");
    setTimeoutMs("");
    setPluginKind("");
    setPluginOpts("{}");
    setKeyMode("replace");
    setApiKeyInput("");
    setModels([{ id: "", name: "", contextWindow: "128000", extra: {} }]);
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (provId: string) => {
    const raw = cfgProviders[provId] ?? effProviders[provId] ?? {};
    setEditingId(provId);
    setId(provId);
    setName(asString(raw.name, provId));
    const isPlugin = raw.type === "plugin" || Boolean(raw.kind);
    setType(isPlugin ? "plugin" : "openai");
    setBaseUrl(asString(raw.baseUrl || raw.base_url));
    setTimeoutMs(raw.timeoutMs !== undefined ? String(raw.timeoutMs) : "");
    setPluginKind(asString(raw.kind));
    setPluginOpts(isRecord(raw.options) ? stringify(raw.options) : "{}");
    setKeyMode(raw.apiKey ? "keep" : "replace");
    setApiKeyInput("");

    const rawModels = isRecord(raw.models) ? raw.models : {};
    const rows: ModelDraftRow[] = Object.entries(rawModels).map(
      ([mId, mVal]) => {
        const rec = isRecord(mVal) ? mVal : {};
        const { name: mName, contextWindow: cw, ...rest } = rec;
        return {
          id: mId,
          name: asString(mName),
          contextWindow: cw !== undefined ? String(cw) : "",
          extra: rest,
        };
      }
    );
    setModels(
      rows.length > 0
        ? rows
        : [{ id: "", name: "", contextWindow: "", extra: {} }]
    );
    setFormError(null);
    setModalOpen(true);
  };

  const handleSaveProvider = async () => {
    setFormError(null);
    const trimmedId = id.trim();
    if (!ID_RE.test(trimmedId)) {
      setFormError("Provider ID must match ^[a-zA-Z0-9-_]+$.");
      return;
    }
    if (!editingId && cfgProviders[trimmedId]) {
      setFormError(`Provider "${trimmedId}" already exists.`);
      return;
    }

    const nextProv: Record<string, unknown> = {
      name: name.trim() || trimmedId,
      type,
    };

    if (type === "openai") {
      if (!/^https?:\/\//i.test(baseUrl.trim())) {
        setFormError("Base URL must start with http:// or https://.");
        return;
      }
      nextProv.baseUrl = baseUrl.trim();
      const tParsed = parseNumber(timeoutMs, { int: true, min: 100 });
      if (tParsed.error) {
        setFormError(`Timeout: ${tParsed.error}`);
        return;
      }
      if (tParsed.value !== undefined) nextProv.timeoutMs = tParsed.value;
    } else {
      if (!pluginKind.trim()) {
        setFormError("Plugin provider kind is required.");
        return;
      }
      nextProv.kind = pluginKind.trim();
      try {
        const parsed = JSON.parse(pluginOpts || "{}");
        if (!isRecord(parsed)) {
          setFormError("Plugin Options must be a JSON object.");
          return;
        }
        nextProv.options = parsed;
      } catch {
        setFormError("Plugin Options must be valid JSON.");
        return;
      }
    }

    const modelsMap: Record<string, unknown> = {};
    for (const row of models) {
      const mId = row.id.trim();
      if (!mId) continue;
      const cwParsed = parseNumber(row.contextWindow, { int: true, min: 1 });
      if (cwParsed.error) {
        setFormError(`Model ${mId} context window: ${cwParsed.error}`);
        return;
      }
      modelsMap[mId] = {
        ...row.extra,
        name: row.name.trim() || mId,
        ...(cwParsed.value !== undefined
          ? { contextWindow: cwParsed.value }
          : {}),
      };
    }
    nextProv.models = modelsMap;

    setSaving(true);
    try {
      const existing = editingId ? cfgProviders[editingId] : undefined;
      if (keyMode === "keep" && existing?.apiKey) {
        nextProv.apiKey = existing.apiKey;
      } else if (keyMode === "replace" && apiKeyInput.trim()) {
        const secName = secretName(["PROVIDER", trimmedId, "API_KEY"]);
        await client.secrets.set(secName, apiKeyInput.trim());
        setApiKeyInput("");
        nextProv.apiKey = `{secret:${secName}}`;
      }

      const nextAll = { ...cfgProviders, [trimmedId]: nextProv };
      await saveSections("Providers", [
        { section: "providers", value: nextAll },
      ]);
      setModalOpen(false);
    } catch (err) {
      handleError(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (provId: string) => {
    setDeleteTarget(null);
    setSaving(true);
    try {
      const nextAll = { ...cfgProviders };
      delete nextAll[provId];
      await saveSections("Providers", [
        {
          section: "providers",
          value: Object.keys(nextAll).length > 0 ? nextAll : null,
        },
      ]);
    } catch (err) {
      handleError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Models & providers"
        description="Configure model providers, API endpoints, credentials, and context windows."
      />

      <Card
        title="Providers"
        actions={
          <button type="button" onClick={openAdd} className={buttonPrimary}>
            <Plus className="size-3.5" aria-hidden="true" />
            <span>Add provider</span>
          </button>
        }
      >
        {allIds.length === 0 ? (
          <p className="py-4 text-center text-muted">
            No providers configured.
          </p>
        ) : (
          <div className="space-y-3">
            {allIds.map((provId) => {
              const inCfg = Boolean(cfgProviders[provId]);
              const data = cfgProviders[provId] ?? effProviders[provId] ?? {};
              const pModels = isRecord(data.models)
                ? Object.keys(data.models)
                : [];
              const keyDesc = describeSecretValue(data.apiKey);

              return (
                <div
                  key={provId}
                  className="rounded-lg border border-border bg-bg p-3 space-y-2"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-fg">
                          {asString(data.name, provId)}
                        </span>
                        <span className="font-mono text-xs text-muted">
                          ({provId})
                        </span>
                        <Badge tone="neutral">
                          {asString(data.type, "openai")}
                        </Badge>
                        {!inCfg && (
                          <Badge tone="accent">From environment</Badge>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                        <span>
                          {asString(data.baseUrl || data.base_url || data.kind)}
                        </span>
                        <span>-</span>
                        <span>
                          {data.apiKey
                            ? `Key stored - ${keyDesc}`
                            : "No API key"}
                        </span>
                      </div>
                    </div>

                    {inCfg && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openEdit(provId)}
                          className={buttonSecondary}
                        >
                          <Pencil className="size-3.5" aria-hidden="true" />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(provId)}
                          className={dangerButton}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                          <span>Delete</span>
                        </button>
                      </div>
                    )}
                  </div>

                  {pModels.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {pModels.map((mId) => (
                        <span
                          key={mId}
                          className="rounded border border-border bg-code px-2 py-0.5 font-mono text-xs text-muted"
                        >
                          {mId}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal
        open={modalOpen}
        wide
        title={editingId ? `Edit provider ${editingId}` : "Add provider"}
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
              disabled={saving}
              onClick={() => void handleSaveProvider()}
              className={buttonPrimary}
            >
              {saving && <Spinner />}
              <span>Save provider</span>
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="ID">
            {(props) => (
              <input
                {...props}
                type="text"
                readOnly={Boolean(editingId)}
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="openai"
                className={`${inputCls} font-mono ${
                  editingId ? "opacity-60" : ""
                }`}
              />
            )}
          </Field>

          <Field label="Display name">
            {(props) => (
              <input
                {...props}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="OpenAI"
                className={inputCls}
              />
            )}
          </Field>

          <Field label="Type">
            {(props) => (
              <select
                {...props}
                disabled={Boolean(editingId)}
                value={type}
                onChange={(e) =>
                  setType(e.target.value as "openai" | "plugin")
                }
                className={selectCls}
              >
                <option value="openai">OpenAI-compatible API</option>
                <option value="plugin">Plugin provider</option>
              </select>
            )}
          </Field>

          {type === "openai" ? (
            <NumberField
              label="Timeout"
              value={timeoutMs}
              onChange={setTimeoutMs}
              unit="ms"
            />
          ) : (
            <Field label="Kind">
              {(props) => (
                <input
                  {...props}
                  type="text"
                  value={pluginKind}
                  onChange={(e) => setPluginKind(e.target.value)}
                  placeholder="custom-kind"
                  className={`${inputCls} font-mono`}
                />
              )}
            </Field>
          )}
        </div>

        {type === "openai" ? (
          <Field label="Base URL">
            {(props) => (
              <input
                {...props}
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className={`${inputCls} font-mono`}
              />
            )}
          </Field>
        ) : (
          <Field label="Plugin Options (JSON)">
            {(props) => (
              <textarea
                {...props}
                rows={3}
                value={pluginOpts}
                onChange={(e) => setPluginOpts(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            )}
          </Field>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg">API Key</span>
            {editingId && Boolean(cfgProviders[editingId]?.apiKey) && (
              <div className="flex items-center gap-2 text-xs">
                <Badge tone="success">Key stored</Badge>
                <button
                  type="button"
                  onClick={() => setKeyMode("replace")}
                  className="text-accent hover:underline"
                >
                  Replace
                </button>
                <span>-</span>
                <button
                  type="button"
                  onClick={() => setKeyMode("remove")}
                  className="text-danger hover:underline"
                >
                  Remove
                </button>
                {keyMode !== "keep" && (
                  <>
                    <span>-</span>
                    <button
                      type="button"
                      onClick={() => setKeyMode("keep")}
                      className="text-muted hover:underline"
                    >
                      Keep key
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {keyMode === "replace" && (
            <SecretInput
              value={apiKeyInput}
              onChange={setApiKeyInput}
              placeholder="sk-..."
            />
          )}
          {keyMode === "remove" && (
            <p className="text-xs text-warning">
              API key reference will be removed on save.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg">Models</span>
            <button
              type="button"
              onClick={() =>
                setModels((prev) => [
                  ...prev,
                  { id: "", name: "", contextWindow: "", extra: {} },
                ])
              }
              className={buttonSecondary}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              <span>Add model</span>
            </button>
          </div>

          {models.map((row, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
              <input
                type="text"
                value={row.id}
                onChange={(e) => {
                  const val = e.target.value;
                  setModels((prev) =>
                    prev.map((r, i) =>
                      i === idx
                        ? {
                            ...r,
                            id: val,
                            name: r.name === r.id ? val : r.name,
                          }
                        : r
                    )
                  );
                }}
                placeholder="Model ID (e.g. gpt-4o)"
                aria-label="Model ID"
                className={`${inputCls} col-span-4 font-mono`}
              />
              <input
                type="text"
                value={row.name}
                onChange={(e) => {
                  const val = e.target.value;
                  setModels((prev) =>
                    prev.map((r, i) => (i === idx ? { ...r, name: val } : r))
                  );
                }}
                placeholder="Display name"
                aria-label="Model display name"
                className={`${inputCls} col-span-4`}
              />
              <input
                type="text"
                inputMode="numeric"
                value={row.contextWindow}
                onChange={(e) => {
                  const val = e.target.value;
                  setModels((prev) =>
                    prev.map((r, i) =>
                      i === idx ? { ...r, contextWindow: val } : r
                    )
                  );
                }}
                placeholder="Context window"
                aria-label="Model context window"
                className={`${inputCls} col-span-3 font-mono`}
              />
              <button
                type="button"
                onClick={() =>
                  setModels((prev) => prev.filter((_, i) => i !== idx))
                }
                aria-label="Remove model row"
                className="col-span-1 inline-flex justify-center text-muted hover:text-danger"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>

        {formError && (
          <p role="alert" className="text-xs text-danger">
            {formError}
          </p>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete provider "${deleteTarget ?? ""}"?`}
        description="This removes the provider and its models from the project configuration."
        confirmLabel="Delete provider"
        onConfirm={() => {
          if (deleteTarget) void handleDelete(deleteTarget);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
