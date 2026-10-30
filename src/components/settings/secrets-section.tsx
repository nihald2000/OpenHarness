import React, { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { SecretItem } from "@openharness/sdk";
import { client } from "@/lib/client";
import { relativeTime } from "@/lib/format";
import { useApp } from "@/lib/hooks";
import { ConfirmDialog } from "../plugins-tab";
import { Spinner } from "../ui";
import {
  buttonPrimary,
  buttonSecondary,
  Callout,
  Card,
  dangerButton,
  Field,
  inputCls,
  SECRET_NAME_RE,
  SecretInput,
  SectionHeading,
  useSettings,
} from "./controls";

export function SecretsSection() {
  const { notify } = useApp();
  const { handleError } = useSettings();

  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [replacingName, setReplacingName] = useState<string | null>(null);
  const [replaceValue, setReplaceValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const loadSecrets = useCallback(async () => {
    try {
      const list = await client.secrets.list();
      setSecrets(list);
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, [handleError]);

  useEffect(() => {
    void loadSecrets();
  }, [loadSecrets]);

  const exists = secrets.some((s) => s.name === newName.trim());

  const handleAddOrReplace = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const name = newName.trim().toUpperCase();
    if (!SECRET_NAME_RE.test(name)) {
      setFormError("Secret name must match ^[A-Z][A-Z0-9_]{0,63}$.");
      return;
    }
    if (!newValue) {
      setFormError("Secret value is required.");
      return;
    }

    const valToSubmit = newValue;
    setNewValue("");
    setBusy(true);
    try {
      await client.secrets.set(name, valToSubmit);
      setNewName("");
      await loadSecrets();
      notify("success", `Saved secret ${name}.`);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleInlineReplace = async (name: string) => {
    if (!replaceValue) return;
    const valToSubmit = replaceValue;
    setReplaceValue("");
    setBusy(true);
    try {
      await client.secrets.set(name, valToSubmit);
      setReplacingName(null);
      await loadSecrets();
      notify("success", `Updated secret ${name}.`);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (name: string) => {
    setDeleteTarget(null);
    setBusy(true);
    try {
      await client.secrets.delete(name);
      await loadSecrets();
      notify("success", `Deleted secret ${name}.`);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Secrets"
        description="Manage encrypted API keys and credentials."
      />

      <Callout tone="info">
        Values are encrypted at rest and can never be viewed again. Reference
        them in config as <code className="font-mono">{"{secret:NAME}"}</code>.
      </Callout>

      <Card title="Stored secrets">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-muted">
            <Spinner />
            <span>Loading secrets...</span>
          </div>
        ) : secrets.length === 0 ? (
          <p className="py-4 text-center text-muted">No secrets stored yet.</p>
        ) : (
          <div className="space-y-2">
            {secrets.map((sec) => {
              const isReplacing = replacingName === sec.name;
              return (
                <div
                  key={sec.name}
                  className="rounded-lg border border-border bg-bg p-3 space-y-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-mono font-semibold text-fg">
                        {sec.name}
                      </span>
                      {sec.updatedAt && (
                        <span className="ml-2 text-xs text-muted">
                          Updated {relativeTime(sec.updatedAt)}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setReplacingName(isReplacing ? null : sec.name);
                          setReplaceValue("");
                        }}
                        className={buttonSecondary}
                      >
                        {isReplacing ? "Cancel" : "Replace"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(sec.name)}
                        className={dangerButton}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                        <span>Delete</span>
                      </button>
                    </div>
                  </div>

                  {isReplacing && (
                    <div className="flex items-center gap-2 pt-1">
                      <div className="flex-1">
                        <SecretInput
                          value={replaceValue}
                          onChange={setReplaceValue}
                          placeholder={`New value for ${sec.name}`}
                        />
                      </div>
                      <button
                        type="button"
                        disabled={busy || !replaceValue}
                        onClick={() => void handleInlineReplace(sec.name)}
                        className={buttonPrimary}
                      >
                        {busy && <Spinner />}
                        <span>Save</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Add secret">
        <form onSubmit={handleAddOrReplace} className="space-y-3">
          <Field
            label="Name"
            hint="Uppercase letters, digits, and underscores (e.g. OPENAI_API_KEY)."
            error={formError}
          >
            {(props) => (
              <input
                {...props}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value.toUpperCase())}
                placeholder="OPENAI_API_KEY"
                className={`${inputCls} font-mono`}
              />
            )}
          </Field>

          <Field label="Value">
            {({ id }) => (
              <SecretInput
                id={id}
                value={newValue}
                onChange={setNewValue}
                placeholder="Secret value..."
              />
            )}
          </Field>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busy || !newName.trim() || !newValue}
              className={buttonPrimary}
            >
              {busy ? (
                <Spinner />
              ) : (
                <Plus className="size-3.5" aria-hidden="true" />
              )}
              <span>{exists ? "Replace secret" : "Add secret"}</span>
            </button>
          </div>
        </form>
      </Card>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete secret "${deleteTarget ?? ""}"?`}
        description="Any configuration referencing this secret will fail until a new value is provided."
        confirmLabel="Delete secret"
        onConfirm={() => {
          if (deleteTarget) void handleDelete(deleteTarget);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
