import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useTools } from "@/lib/hooks";
import {
  buttonSecondary,
  Callout,
  Card,
  inputCls,
  isRecord,
  SaveBar,
  SectionHeading,
  selectCls,
  stable,
  useSettings,
} from "./controls";

type RuleAction = "allow" | "ask" | "deny";

interface PermissionRuleRow {
  tool: string;
  pattern: string;
  action: RuleAction;
}

function parseRules(raw: unknown): PermissionRuleRow[] {
  if (!isRecord(raw)) return [];
  const rows: PermissionRuleRow[] = [];
  for (const [tool, val] of Object.entries(raw)) {
    if (val === "allow" || val === "ask" || val === "deny") {
      rows.push({ tool, pattern: "*", action: val });
    } else if (isRecord(val)) {
      for (const [pat, act] of Object.entries(val)) {
        if (act === "allow" || act === "ask" || act === "deny") {
          rows.push({ tool, pattern: pat, action: act });
        }
      }
    }
  }
  return rows;
}

function serializeRules(
  rows: PermissionRuleRow[]
): Record<string, unknown> | null {
  if (rows.length === 0) return null;
  const byTool = new Map<string, Array<{ pattern: string; action: RuleAction }>>();
  for (const r of rows) {
    const t = r.tool.trim() || "*";
    const p = r.pattern.trim() || "*";
    const list = byTool.get(t) ?? [];
    list.push({ pattern: p, action: r.action });
    byTool.set(t, list);
  }
  const out: Record<string, unknown> = {};
  for (const [tool, list] of byTool.entries()) {
    if (list.length === 1 && list[0]?.pattern === "*") {
      out[tool] = list[0].action;
    } else {
      const patObj: Record<string, RuleAction> = {};
      for (const item of list) {
        patObj[item.pattern] = item.action;
      }
      out[tool] = patObj;
    }
  }
  return out;
}

function RulesCard() {
  const { view, saveSections, handleError } = useSettings();
  const { tools } = useTools(undefined, true);

  const initialRows = useMemo(
    () => parseRules(view.config.permissions),
    [view.config.permissions]
  );

  const [rows, setRows] = useState<PermissionRuleRow[]>(initialRows);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const dirty = JSON.stringify(rows) !== JSON.stringify(initialRows);

  const duplicateKeys = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const r of rows) {
      const k = `${r.tool.trim() || "*"}::${r.pattern.trim() || "*"}`;
      if (seen.has(k)) dupes.add(k);
      seen.add(k);
    }
    return dupes;
  }, [rows]);

  const interleavedTools = useMemo(() => {
    const lastIdx = new Map<string, number>();
    const interleaved = new Set<string>();
    rows.forEach((r, idx) => {
      const t = r.tool.trim() || "*";
      const prev = lastIdx.get(t);
      if (prev !== undefined && prev !== idx - 1) {
        interleaved.add(t);
      }
      lastIdx.set(t, idx);
    });
    return Array.from(interleaved);
  }, [rows]);

  const move = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= rows.length) return;
    setRows((prev) => {
      const copy = [...prev];
      const temp = copy[idx]!;
      copy[idx] = copy[target]!;
      copy[target] = temp;
      return copy;
    });
  };

  const doSave = async (force = false) => {
    if (duplicateKeys.size > 0) return;
    setSaving(true);
    try {
      await saveSections(
        "Permissions",
        [{ section: "permissions", value: serializeRules(rows) }],
        force
      );
      setConflict(false);
    } catch (err) {
      if ((err as { status?: number })?.status === 409) {
        setConflict(true);
      } else {
        handleError(err);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Rules"
      description="Order matters: the last matching rule wins."
      actions={
        <button
          type="button"
          onClick={() =>
            setRows((prev) => [
              ...prev,
              { tool: "*", pattern: "*", action: "ask" },
            ])
          }
          className={buttonSecondary}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          <span>Add rule</span>
        </button>
      }
      footer={
        <SaveBar
          dirty={dirty}
          invalid={duplicateKeys.size > 0}
          saving={saving}
          conflict={conflict}
          onSave={() => void doSave(false)}
          onForceSave={() => void doSave(true)}
          onCancelConflict={() => setConflict(false)}
          onReset={() => {
            setRows(initialRows);
            setConflict(false);
          }}
        />
      }
    >
      {interleavedTools.length > 0 && (
        <Callout tone="warning">
          Rules for tool(s) {interleavedTools.join(", ")} are interleaved and
          will be grouped together when saved.
        </Callout>
      )}

      {rows.length === 0 ? (
        <p className="py-4 text-center text-muted">
          No custom permission rules configured.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, idx) => {
            const key = `${row.tool.trim() || "*"}::${
              row.pattern.trim() || "*"
            }`;
            const isDupe = duplicateKeys.has(key);
            const actionColor =
              row.action === "allow"
                ? "text-success"
                : row.action === "deny"
                  ? "text-danger"
                  : "text-warning";

            return (
              <div
                key={idx}
                className={`flex flex-wrap items-center gap-2 rounded-lg border p-2 ${
                  isDupe ? "border-danger/60 bg-danger/5" : "border-border bg-bg"
                }`}
              >
                <select
                  value={row.tool}
                  onChange={(e) => {
                    const val = e.target.value;
                    setRows((prev) =>
                      prev.map((r, i) => (i === idx ? { ...r, tool: val } : r))
                    );
                  }}
                  aria-label="Rule tool"
                  className={`${selectCls} w-44 font-mono`}
                >
                  <option value="*">* (all tools)</option>
                  {tools.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>

                <input
                  type="text"
                  value={row.pattern}
                  onChange={(e) => {
                    const val = e.target.value;
                    setRows((prev) =>
                      prev.map((r, i) =>
                        i === idx ? { ...r, pattern: val } : r
                      )
                    );
                  }}
                  placeholder="* (any input)"
                  aria-label="Rule pattern"
                  className={`${inputCls} flex-1 min-w-[10rem] font-mono`}
                />

                <select
                  value={row.action}
                  onChange={(e) => {
                    const val = e.target.value as RuleAction;
                    setRows((prev) =>
                      prev.map((r, i) =>
                        i === idx ? { ...r, action: val } : r
                      )
                    );
                  }}
                  aria-label="Rule action"
                  className={`${selectCls} w-28 font-semibold ${actionColor}`}
                >
                  <option value="allow">allow</option>
                  <option value="ask">ask</option>
                  <option value="deny">deny</option>
                </select>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => move(idx, -1)}
                    aria-label="Move rule up"
                    className="rounded p-1 text-muted hover:bg-hover hover:text-fg disabled:opacity-30"
                  >
                    <ArrowUp className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === rows.length - 1}
                    onClick={() => move(idx, 1)}
                    aria-label="Move rule down"
                    className="rounded p-1 text-muted hover:bg-hover hover:text-fg disabled:opacity-30"
                  >
                    <ArrowDown className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setRows((prev) => prev.filter((_, i) => i !== idx))
                    }
                    aria-label="Remove rule"
                    className="rounded p-1 text-muted hover:bg-hover hover:text-danger"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {duplicateKeys.size > 0 && (
        <p role="alert" className="text-xs text-danger">
          Duplicate tool and pattern rules detected. Remove duplicates before
          saving.
        </p>
      )}
    </Card>
  );
}

export function PermissionsSection() {
  const { view } = useSettings();
  return (
    <div className="space-y-4">
      <SectionHeading
        title="Permissions"
        description="Configure tool approval rules and glob pattern matching."
      />

      <RulesCard key={stable(view.config.permissions)} />

      <Callout tone="info">
        Use <code className="font-mono">*</code> wildcards to match tool names
        or command/file patterns (for example,{" "}
        <code className="font-mono">git status*</code> or{" "}
        <code className="font-mono">src/**</code>).
      </Callout>
    </div>
  );
}
