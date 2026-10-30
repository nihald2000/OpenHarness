import React, { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Blocks,
  Check,
  Cloud,
  Lock,
  OctagonAlert,
  Plus,
  Server,
} from "lucide-react";
import { Link } from "@/lib/router";
import { client } from "@/lib/client";
import { errorMessage, isStatus, stringify } from "@/lib/format";
import { useApp, useCatalog } from "@/lib/hooks";
import { useAdmin } from "@/lib/use-admin";
import { Badge, Spinner } from "./ui";

export const buttonBase =
  "touch-target inline-flex h-8 items-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors duration-150 ease-out disabled:pointer-events-none disabled:opacity-40";
export const buttonPrimary = `${buttonBase} bg-accent text-accent-fg hover:bg-accent-strong`;
export const buttonSecondary = `${buttonBase} border border-border bg-elev hover:bg-hover text-fg`;
export const dangerButton = `${buttonBase} border border-danger/35 bg-danger/10 text-danger hover:bg-danger/15`;
export const inputCls =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-xs text-fg placeholder:text-muted focus-visible:border-accent aria-[invalid=true]:border-danger/60";

const PLUGIN_NAME_RE = /^[a-zA-Z0-9-_]+$/;

function findForbiddenSecretToken(val: unknown): string | null {
  if (typeof val === "string") {
    const m =
      /\{(?:env|file|secret):[^}]+\}|\[(?:file|env|secret):[^\]]+\]/i.exec(val);
    if (m) return m[0];
    return null;
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      const found = findForbiddenSecretToken(item);
      if (found) return found;
    }
    return null;
  }
  if (val && typeof val === "object") {
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (/^(?:@(?:env|file|secret)|\[(?:file|env|secret)[^\]]*\])$/i.test(k)) {
        return k;
      }
      const found = findForbiddenSecretToken(v);
      if (found) return found;
    }
  }
  return null;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      requestAnimationFrame(() => cancelRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-full max-w-md rounded-2xl border border-border bg-bg p-4 text-xs text-fg shadow-menu backdrop:bg-overlay"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-warning/35 bg-warning/10 text-warning">
          <OctagonAlert className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          <p className="mt-1 text-xs leading-normal text-muted">
            {description}
          </p>
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          className={buttonSecondary}
        >
          Cancel
        </button>
        <button type="button" onClick={onConfirm} className={dangerButton}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

export function PluginsTab({ inSettings = false }: { inSettings?: boolean }) {
  const { notify } = useApp();
  const { plugins, runtimes, pluginError, runtimeError, refresh } =
    useCatalog();
  const { admin, loading: adminLoading, markSignedOut } = useAdmin();

  const [remember, setRemember] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmDetach, setConfirmDetach] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState("");
  const [addModule, setAddModule] = useState("");
  const [addOptions, setAddOptions] = useState("{}");
  const [addError, setAddError] = useState<string | null>(null);

  const [forceRetry, setForceRetry] = useState<(() => Promise<void>) | null>(
    null
  );

  const runAction = async (
    key: string,
    fn: (force: boolean) => Promise<void>
  ) => {
    setBusyKey(key);
    try {
      await fn(false);
      await refresh();
    } catch (err) {
      if (isStatus(err, 401) || isStatus(err, 403)) {
        markSignedOut(true);
        notify(
          "error",
          "Your admin session is no longer valid. Sign in to Settings again."
        );
      } else if (isStatus(err, 409)) {
        setForceRetry(() => async () => {
          setBusyKey(key);
          try {
            await fn(true);
            await refresh();
          } catch (retryErr) {
            notify("error", errorMessage(retryErr));
          } finally {
            setBusyKey(null);
          }
        });
      } else {
        notify("error", errorMessage(err));
      }
    } finally {
      setBusyKey(null);
    }
  };

  const handleAttachSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);
    const trimmedName = addName.trim();
    if (!PLUGIN_NAME_RE.test(trimmedName)) {
      setAddError("Plugin name must match ^[a-zA-Z0-9-_]+$.");
      return;
    }

    let parsedOpts: Record<string, unknown> = {};
    if (addOptions.trim()) {
      try {
        const raw = JSON.parse(addOptions);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          setAddError("Options must be a JSON object.");
          return;
        }
        const token = findForbiddenSecretToken(raw);
        if (token) {
          setAddError(
            `Options sent from the Web UI may not contain ${token} tokens. Put secrets in the project config (openharness.jsonc) or the environment instead.`
          );
          return;
        }
        parsedOpts = raw as Record<string, unknown>;
      } catch {
        setAddError("Options must be valid JSON.");
        return;
      }
    }

    await runAction(`attach:${trimmedName}`, async (force) => {
      await client.plugins.attach({
        name: trimmedName,
        module: addModule.trim() || undefined,
        options: parsedOpts,
        persist: remember,
        force,
      });
      notify(
        "success",
        `Attached plugin ${trimmedName}${
          remember ? " and saved to config" : ""
        }${force ? " (active runs stopped)" : ""}.`
      );
      setShowAdd(false);
      setAddName("");
      setAddModule("");
      setAddOptions("{}");
    });
  };

  return (
    <div className="space-y-4 text-xs">
      {!admin ? (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-subtle px-3 py-2 text-muted">
          <Lock className="size-3.5 shrink-0" aria-hidden="true" />
          {adminLoading ? (
            <span>Checking admin session...</span>
          ) : (
            <span>
              {!inSettings ? (
                <>
                  <Link
                    href="/settings#plugins"
                    className="font-medium text-accent hover:underline"
                  >
                    Sign in to Settings
                  </Link>{" "}
                  to manage plugins.
                </>
              ) : (
                "Sign in as administrator to manage plugins."
              )}
            </span>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-subtle px-3 py-2">
          <label className="flex cursor-pointer items-center gap-2 font-medium text-fg">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="accent-accent"
            />
            <span>Remember (save to config)</span>
          </label>
          <p className="mt-1 text-xs text-muted">
            {remember
              ? "Attach, detach and default-runtime changes are written to the project config."
              : "Changes apply until the server restarts."}
          </p>
        </div>
      )}

      <div>
        <div className="mb-2 text-xs font-medium text-muted">
          Plugins · {plugins.length}
        </div>

        {pluginError && (
          <div className="mb-2 rounded-lg border border-danger/35 bg-danger/10 p-2 text-danger">
            {pluginError}
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-border bg-bg divide-y divide-border">
          {plugins.map((p) => {
            const isAttached = p.status === "attached";
            const isFailed = p.status === "failed";
            const isConfirming = confirmDetach === p.name;

            return (
              <div key={p.name} className="px-4 py-3 space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-fg">{p.name}</span>
                      {p.version && (
                        <span className="font-mono text-xs text-muted">
                          v{p.version}
                        </span>
                      )}
                      {p.module && (
                        <span className="font-mono text-xs text-muted">
                          ({p.module})
                        </span>
                      )}
                      <Badge
                        tone={
                          isAttached
                            ? "success"
                            : isFailed
                              ? "danger"
                              : "neutral"
                        }
                      >
                        {p.status}
                      </Badge>
                      {p.configured && <Badge tone="neutral">configured</Badge>}
                    </div>
                    {p.description && (
                      <p className="mt-1 text-xs text-muted">
                        {p.description}
                      </p>
                    )}
                  </div>

                  {admin && (
                    <div className="flex items-center gap-2">
                      {isAttached ? (
                        isConfirming ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted">
                              Detach {p.name}?
                            </span>
                            <button
                              type="button"
                              disabled={busyKey !== null}
                              onClick={() => {
                                setConfirmDetach(null);
                                void runAction(`detach:${p.name}`, async (force) => {
                                  await client.plugins.detach(p.name, {
                                    persist: remember,
                                    force,
                                  });
                                  notify(
                                    "success",
                                    `Detached plugin ${p.name}${
                                      remember ? " and updated config" : ""
                                    }${force ? " (active runs stopped)" : ""}.`
                                  );
                                });
                              }}
                              className={dangerButton}
                            >
                              Confirm detach
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDetach(null)}
                              className={buttonSecondary}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={busyKey !== null}
                            onClick={() => setConfirmDetach(p.name)}
                            className={buttonSecondary}
                          >
                            Detach
                          </button>
                        )
                      ) : (
                        <button
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() =>
                            void runAction(`reattach:${p.name}`, async (force) => {
                              await client.plugins.attach({
                                name: p.name,
                                module: p.module,
                                persist: remember,
                                force,
                              });
                              notify("success", `Attached plugin ${p.name}.`);
                            })
                          }
                          className={buttonSecondary}
                        >
                          {busyKey === `reattach:${p.name}` && <Spinner />}
                          <span>{isFailed ? "Retry" : "Attach"}</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {p.contributions && (
                  <div className="flex flex-wrap gap-1">
                    {Boolean(p.contributions.runtimes?.length) && (
                      <span className="rounded border border-border bg-code px-2 py-0.5 font-mono text-xs text-muted">
                        runtimes
                      </span>
                    )}
                    {Boolean(p.contributions.providers?.length) && (
                      <span className="rounded border border-border bg-code px-2 py-0.5 font-mono text-xs text-muted">
                        providers
                      </span>
                    )}
                    {Boolean(p.contributions.tools) && (
                      <span className="rounded border border-border bg-code px-2 py-0.5 font-mono text-xs text-muted">
                        {p.contributions.tools} tools
                      </span>
                    )}
                    {Boolean(p.contributions.hooks) && (
                      <span className="rounded border border-border bg-code px-2 py-0.5 font-mono text-xs text-muted">
                        hooks
                      </span>
                    )}
                  </div>
                )}

                {p.health && (
                  <div className="flex items-center gap-2 text-xs">
                    {p.health.ok ? (
                      <>
                        <Check
                          className="size-3.5 text-success"
                          aria-hidden="true"
                        />
                        <span className="text-muted">
                          Healthy{p.health.detail ? ` · ${p.health.detail}` : ""}
                        </span>
                      </>
                    ) : (
                      <>
                        <AlertTriangle
                          className="size-3.5 text-warning"
                          aria-hidden="true"
                        />
                        <span className="text-warning">
                          {p.health.detail || "Unhealthy"}
                        </span>
                      </>
                    )}
                  </div>
                )}

                {p.error && (
                  <div
                    role="alert"
                    className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
                  >
                    {p.error}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {admin && (
          <div className="mt-3">
            {!showAdd ? (
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="touch-target flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border py-2 text-xs font-medium text-muted transition-colors duration-150 ease-out hover:border-accent hover:text-fg"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                <span>Add plugin</span>
              </button>
            ) : (
              <form
                onSubmit={handleAttachSubmit}
                className="space-y-3 rounded-xl border border-border bg-bg p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-fg">Attach plugin</span>
                  <button
                    type="button"
                    onClick={() => {
                      setAddName("modal");
                      setAddModule("");
                      setAddOptions(
                        stringify({
                          sandbox: {
                            image: "node:22-bookworm-slim",
                            outboundDomainsAllowed: [],
                          },
                        })
                      );
                    }}
                    className="touch-target inline-flex items-center gap-1 rounded-lg border border-accent/30 bg-accent/10 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/15"
                  >
                    <Blocks className="size-3" aria-hidden="true" />
                    <span>Modal sandbox</span>
                  </button>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted">
                    Name
                  </label>
                  <input
                    type="text"
                    value={addName}
                    onChange={(e) => setAddName(e.target.value)}
                    placeholder="modal"
                    className={`${inputCls} font-mono`}
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted">
                    Module (optional)
                  </label>
                  <input
                    type="text"
                    value={addModule}
                    onChange={(e) => setAddModule(e.target.value)}
                    placeholder="@openharness/plugin-modal"
                    className={`${inputCls} font-mono`}
                  />
                  <p className="mt-1 text-xs text-muted">
                    Must be permitted by the server pluginAllowlist.
                  </p>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted">
                    Options (JSON object)
                  </label>
                  <textarea
                    rows={4}
                    value={addOptions}
                    onChange={(e) => setAddOptions(e.target.value)}
                    className={`${inputCls} font-mono`}
                  />
                </div>

                {addError && (
                  <p role="alert" className="text-xs text-danger">
                    {addError}
                  </p>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAdd(false);
                      setAddError(null);
                    }}
                    className={buttonSecondary}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busyKey !== null}
                    className={buttonPrimary}
                  >
                    {busyKey?.startsWith("attach:") && <Spinner />}
                    <span>Attach</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 text-xs font-medium text-muted">
          Runtimes · {runtimes.length}
        </div>

        {runtimeError && (
          <div className="mb-2 rounded-lg border border-danger/35 bg-danger/10 p-2 text-danger">
            {runtimeError}
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-border bg-bg divide-y divide-border">
          {runtimes.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {r.remote ? (
                    <Cloud
                      className="size-3.5 text-accent"
                      aria-hidden="true"
                    />
                  ) : (
                    <Server
                      className="size-3.5 text-muted"
                      aria-hidden="true"
                    />
                  )}
                  <span className="font-mono font-medium text-fg">{r.id}</span>
                  {r.isDefault && <Badge tone="accent">Default</Badge>}
                  {r.active && <Badge tone="success">Active</Badge>}
                  <Badge tone="neutral">
                    {r.plugin ? `plugin: ${r.plugin}` : "Built-in"}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {r.description || "Starts on first command."}
                </p>
              </div>

              {admin && !r.isDefault && (
                <button
                  type="button"
                  disabled={busyKey !== null}
                  onClick={() =>
                    void runAction(`runtime:${r.id}`, async () => {
                      await client.runtimes.setDefault(r.id, remember);
                      notify("success", `Default runtime set to ${r.id}.`);
                    })
                  }
                  className={buttonSecondary}
                >
                  {busyKey === `runtime:${r.id}` && <Spinner />}
                  <span>Make default</span>
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={forceRetry !== null}
        title="Stop active runs and continue?"
        description="Continuing aborts every active run before the plugin is attached/detached."
        confirmLabel="Stop runs and continue"
        onConfirm={() => {
          const fn = forceRetry;
          setForceRetry(null);
          if (fn) void fn();
        }}
        onCancel={() => {
          setForceRetry(null);
          notify("info", "Cancelled - active runs were left running.");
        }}
      />
    </div>
  );
}
