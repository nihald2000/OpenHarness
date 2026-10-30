import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  AlertTriangle,
  Info,
  Plus,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import type { SettingsPreviewResponse } from "@/types/sdk";
import { client } from "@/lib/client";
import { errorMessage, isStatus } from "@/lib/format";
import { useApp, useCatalog } from "@/lib/hooks";
import { useAdmin } from "@/lib/use-admin";
import {
  buttonBase,
  buttonPrimary,
  buttonSecondary,
  dangerButton,
  inputCls,
} from "../plugins-tab";
import { Spinner } from "../ui";

export { buttonBase, buttonPrimary, buttonSecondary, dangerButton, inputCls };
export const ghostButton =
  "touch-target inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40";
export const selectCls = `${inputCls} h-9 py-1.5 pr-8`;

export const MASK = "********";
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function isRecord(val: unknown): val is Record<string, unknown> {
  return Boolean(val && typeof val === "object" && !Array.isArray(val));
}

export function asString(val: unknown, fallback = ""): string {
  return typeof val === "string" ? val : fallback;
}

export function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v): v is string => typeof v === "string");
}

export function assignKey(
  obj: Record<string, unknown>,
  key: string,
  val: unknown
): Record<string, unknown> {
  const next = { ...obj };
  if (val === undefined || val === "") {
    delete next[key];
  } else {
    next[key] = val;
  }
  return next;
}

export function orNull(
  obj: Record<string, unknown>
): Record<string, unknown> | null {
  return Object.keys(obj).length === 0 ? null : obj;
}

export function stable(val: unknown): string {
  const sortRec = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortRec);
    if (v && typeof v === "object") {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = sortRec((v as Record<string, unknown>)[k]);
      }
      return sorted;
    }
    return v;
  };
  return JSON.stringify(sortRec(val));
}

export function secretName(parts: string[]): string {
  const raw = parts
    .join("_")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (raw || "SECRET").slice(0, 64);
}

export function describeSecretValue(val: unknown): string {
  if (!val) return "Not set";
  if (typeof val === "string") {
    if (val === MASK) return "Stored in config";
    const secMatch = /^\{secret:([^}]+)\}$/i.exec(val);
    if (secMatch) return `Secret ${secMatch[1]}`;
    const envMatch = /^\{env:([^}]+)\}$/i.exec(val);
    if (envMatch) return `Environment variable ${envMatch[1]}`;
    return "Set";
  }
  if (isRecord(val)) {
    if (typeof val.secret === "string") return `Secret ${val.secret}`;
    if (typeof val.env === "string") return `Environment variable ${val.env}`;
  }
  return "Set";
}

export function parseNumber(
  text: string,
  opts?: { int?: boolean; min?: number; max?: number }
): { value: number | undefined; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { value: undefined, error: null };
  const num = Number(trimmed);
  if (!Number.isFinite(num) || (opts?.int && !Number.isInteger(num))) {
    return { value: undefined, error: "Enter a number." };
  }
  if (opts?.min !== undefined && num < opts.min) {
    return { value: undefined, error: `Must be at least ${opts.min}.` };
  }
  if (opts?.max !== undefined && num > opts.max) {
    return { value: undefined, error: `Must be at most ${opts.max}.` };
  }
  return { value: num, error: null };
}

export interface SectionUpdateItem {
  section: string;
  value: unknown;
}

export interface SettingsContextValue {
  view: SettingsPreviewResponse;
  refresh: () => Promise<void>;
  handleError: (err: unknown) => void;
  saveSections: (
    label: string,
    updates: SectionUpdateItem[],
    force?: boolean
  ) => Promise<boolean>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({
  view,
  refresh,
  children,
}: {
  view: SettingsPreviewResponse;
  refresh: () => Promise<void>;
  children: React.ReactNode;
}) {
  const { notify } = useApp();
  const { refresh: refreshCatalog } = useCatalog();
  const { markSignedOut } = useAdmin();

  const handleError = useCallback(
    (err: unknown) => {
      if (isStatus(err, 401) || isStatus(err, 403)) {
        markSignedOut(true);
        notify("error", "Your admin session is no longer valid. Sign in again.");
        return;
      }
      notify("error", errorMessage(err));
    },
    [markSignedOut, notify]
  );

  const saveSections = useCallback(
    async (
      label: string,
      updates: SectionUpdateItem[],
      force = false
    ): Promise<boolean> => {
      let extractedCount = 0;
      for (let i = 0; i < updates.length; i++) {
        const u = updates[i]!;
        const res = await client.settings.update(u.section, u.value, force);
        if (res.extractedSecrets?.length) {
          extractedCount += res.extractedSecrets.length;
        }
      }
      await Promise.all([refresh(), refreshCatalog()]);
      notify(
        "success",
        `${label} saved.${force ? " Active runs were stopped." : ""}`
      );
      if (extractedCount > 0) {
        notify(
          "info",
          `Moved ${extractedCount} pasted secret(s) into the encrypted store.`
        );
      }
      return true;
    },
    [notify, refresh, refreshCatalog]
  );

  return (
    <SettingsContext.Provider
      value={{ view, refresh, handleError, saveSections }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside SettingsProvider");
  return ctx;
}

export function SectionHeading({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {description && (
        <p className="mt-1 text-xs text-muted">{description}</p>
      )}
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  footer,
  children,
}: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-elev overflow-hidden">
      {(title || description || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            {title && (
              <h3 className="text-xs font-semibold text-fg">{title}</h3>
            )}
            {description && (
              <p className="mt-1 text-xs text-muted">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4 text-xs space-y-3">{children}</div>
      {footer && (
        <div className="border-t border-border bg-subtle/50 px-4 py-3">
          {footer}
        </div>
      )}
    </section>
  );
}

export function ActiveRunWarning({
  onConfirm,
  onCancel,
  saving,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">
          Runs are active - stop them and apply?
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className={buttonSecondary}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={saving}
          className={dangerButton}
        >
          {saving && <Spinner />}
          <span>Stop runs and apply</span>
        </button>
      </div>
    </div>
  );
}

export function SaveBar({
  dirty,
  invalid = false,
  saving = false,
  conflict = false,
  onSave,
  onForceSave,
  onCancelConflict,
  onReset,
}: {
  dirty: boolean;
  invalid?: boolean;
  saving?: boolean;
  conflict?: boolean;
  onSave: () => void;
  onForceSave?: () => void;
  onCancelConflict?: () => void;
  onReset: () => void;
}) {
  if (conflict && onForceSave && onCancelConflict) {
    return (
      <ActiveRunWarning
        onConfirm={onForceSave}
        onCancel={onCancelConflict}
        saving={saving}
      />
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-muted">
        {dirty ? "Unsaved changes" : "Up to date"}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={onReset}
          className={buttonSecondary}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          <span>Reset</span>
        </button>
        <button
          type="button"
          disabled={!dirty || invalid || saving}
          onClick={onSave}
          className={buttonPrimary}
        >
          {saving ? (
            <Spinner />
          ) : (
            <Save className="size-3.5" aria-hidden="true" />
          )}
          <span>Save</span>
        </button>
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: (props: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }) => React.ReactNode;
}) {
  const id = useId();
  const descId = hint || error ? `${id}-desc` : undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-fg">
        {label}
      </label>
      {children({
        id,
        "aria-describedby": descId,
        "aria-invalid": Boolean(error),
      })}
      {(error || hint) && (
        <p
          id={descId}
          className={`text-xs ${error ? "text-danger" : "text-muted"}`}
        >
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function NumberField({
  label,
  hint,
  value,
  onChange,
  effective,
  unit,
  error,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (val: string) => void;
  effective?: number | string;
  unit?: string;
  error?: string | null;
}) {
  const placeholder =
    effective !== undefined ? `${effective} (default)` : "Default";
  return (
    <Field label={label} hint={hint} error={error}>
      {(fieldProps) => (
        <div className="relative flex items-center">
          <input
            {...fieldProps}
            type="text"
            inputMode="numeric"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className={`${inputCls} font-mono ${unit ? "pr-12" : ""}`}
          />
          {unit && (
            <span className="pointer-events-none absolute right-3 text-xs text-muted">
              {unit}
            </span>
          )}
        </div>
      )}
    </Field>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors disabled:pointer-events-none disabled:opacity-40 ${
        checked
          ? "border-accent bg-accent"
          : "border-border bg-subtle"
      }`}
    >
      <span
        className={`inline-block size-3.5 rounded-full bg-accent-fg transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function StringListEditor({
  label,
  hint,
  values,
  onChange,
  placeholder = "Add item...",
  validateItem,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  validateItem?: (item: string) => string | null;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addItem = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (values.includes(trimmed)) {
      setError("Already in list.");
      return;
    }
    if (validateItem) {
      const err = validateItem(trimmed);
      if (err) {
        setError(err);
        return;
      }
    }
    setError(null);
    onChange([...values, trimmed]);
    setDraft("");
  };

  return (
    <Field label={label} hint={hint} error={error}>
      {(fieldProps) => (
        <div className="space-y-2">
          {values.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {values.map((item) => {
                const itemErr = validateItem ? validateItem(item) : null;
                return (
                  <span
                    key={item}
                    title={itemErr || undefined}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs ${
                      itemErr
                        ? "border-danger/50 bg-danger/10 text-danger"
                        : "border-border bg-code text-fg"
                    }`}
                  >
                    <span>{item}</span>
                    <button
                      type="button"
                      onClick={() =>
                        onChange(values.filter((v) => v !== item))
                      }
                      aria-label={`Remove ${item}`}
                      className="text-muted hover:text-fg"
                    >
                      <X className="size-3" aria-hidden="true" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          <div className="flex gap-2">
            <input
              {...fieldProps}
              type="text"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addItem();
                }
              }}
              placeholder={placeholder}
              className={`${inputCls} font-mono`}
            />
            <button
              type="button"
              onClick={addItem}
              className={buttonSecondary}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              <span>Add</span>
            </button>
          </div>
        </div>
      )}
    </Field>
  );
}

export function Modal({
  open,
  title,
  wide = false,
  onClose,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  wide?: boolean;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
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
        onClose();
      }}
      className={`m-auto w-full ${
        wide ? "max-w-[44rem]" : "max-w-[28rem]"
      } rounded-2xl border border-border bg-bg p-0 text-xs text-fg shadow-menu backdrop:bg-overlay`}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto p-4 space-y-3">
        {children}
      </div>
      {footer && (
        <div className="flex justify-end gap-2 border-t border-border bg-subtle/50 px-4 py-3">
          {footer}
        </div>
      )}
    </dialog>
  );
}

export function Callout({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "danger";
  children: React.ReactNode;
}) {
  const styles = {
    info: "border-border bg-subtle text-muted",
    warning: "border-warning/40 bg-warning/10 text-warning",
    danger: "border-danger/40 bg-danger/10 text-danger",
  }[tone];

  const Icon =
    tone === "danger"
      ? AlertCircle
      : tone === "warning"
        ? AlertTriangle
        : Info;

  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-xs ${styles}`}
    >
      <Icon className="mt-1 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
    </div>
  );
}

export function Loading({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 justify-center text-xs text-muted">
      <Spinner className="size-4 text-accent" />
      <span>{label}</span>
    </div>
  );
}

export function SecretInput({
  id,
  value,
  onChange,
  placeholder,
}: {
  id?: string;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-2">
      <input
        id={id}
        type={show ? "text" : "password"}
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${inputCls} font-mono`}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className={buttonSecondary}
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}
