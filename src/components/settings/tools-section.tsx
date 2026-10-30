import { useMemo, useState } from "react";
import { useTools } from "@/lib/hooks";
import { Badge } from "../ui";
import {
  asStringArray,
  assignKey,
  Card,
  inputCls,
  isRecord,
  NumberField,
  orNull,
  parseNumber,
  SaveBar,
  SectionHeading,
  stable,
  StringListEditor,
  Switch,
  useSettings,
} from "./controls";

function CodeModeCard() {
  const { view, saveSections, handleError } = useSettings();
  const raw = isRecord(view.config.codeMode) ? view.config.codeMode : {};
  const eff = isRecord(view.effective.codeMode) ? view.effective.codeMode : {};

  const initial = {
    enabled:
      typeof raw.enabled === "boolean"
        ? raw.enabled
        : Boolean(eff.enabled ?? true),
    callableTools: asStringArray(raw.callableTools),
    exclusiveTools: asStringArray(raw.exclusiveTools),
    timeoutMs: raw.timeoutMs !== undefined ? String(raw.timeoutMs) : "",
    memoryLimitMb:
      raw.memoryLimitMb !== undefined ? String(raw.memoryLimitMb) : "",
    maxToolCalls:
      raw.maxToolCalls !== undefined ? String(raw.maxToolCalls) : "",
    maxOutputChars:
      raw.maxOutputChars !== undefined ? String(raw.maxOutputChars) : "",
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [callableTools, setCallableTools] = useState(initial.callableTools);
  const [exclusiveTools, setExclusiveTools] = useState(initial.exclusiveTools);
  const [timeoutMs, setTimeoutMs] = useState(initial.timeoutMs);
  const [memoryLimitMb, setMemoryLimitMb] = useState(initial.memoryLimitMb);
  const [maxToolCalls, setMaxToolCalls] = useState(initial.maxToolCalls);
  const [maxOutputChars, setMaxOutputChars] = useState(initial.maxOutputChars);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const tCheck = parseNumber(timeoutMs, { int: true, min: 100 });
  const mCheck = parseNumber(memoryLimitMb, { int: true, min: 0, max: 1024 });
  const cCheck = parseNumber(maxToolCalls, { int: true, min: 1 });
  const oCheck = parseNumber(maxOutputChars, { int: true, min: 100 });

  const invalid = Boolean(
    tCheck.error || mCheck.error || cCheck.error || oCheck.error
  );

  const dirty =
    enabled !== initial.enabled ||
    stable(callableTools) !== stable(initial.callableTools) ||
    stable(exclusiveTools) !== stable(initial.exclusiveTools) ||
    timeoutMs !== initial.timeoutMs ||
    memoryLimitMb !== initial.memoryLimitMb ||
    maxToolCalls !== initial.maxToolCalls ||
    maxOutputChars !== initial.maxOutputChars;

  const reset = () => {
    setEnabled(initial.enabled);
    setCallableTools(initial.callableTools);
    setExclusiveTools(initial.exclusiveTools);
    setTimeoutMs(initial.timeoutMs);
    setMemoryLimitMb(initial.memoryLimitMb);
    setMaxToolCalls(initial.maxToolCalls);
    setMaxOutputChars(initial.maxOutputChars);
    setConflict(false);
  };

  const doSave = async (force = false) => {
    if (invalid) return;
    let next: Record<string, unknown> = { ...raw, enabled };
    next = assignKey(
      next,
      "callableTools",
      callableTools.length > 0 ? callableTools : undefined
    );
    next = assignKey(
      next,
      "exclusiveTools",
      exclusiveTools.length > 0 ? exclusiveTools : undefined
    );
    next = assignKey(next, "timeoutMs", tCheck.value);
    next = assignKey(next, "memoryLimitMb", mCheck.value);
    next = assignKey(next, "maxToolCalls", cCheck.value);
    next = assignKey(next, "maxOutputChars", oCheck.value);

    setSaving(true);
    try {
      await saveSections("Code Mode", [
        { section: "codeMode", value: orNull(next) },
      ], force);
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
      title="Code Mode"
      description="Control the sandboxed TypeScript execution tool and its resource limits."
      footer={
        <SaveBar
          dirty={dirty}
          invalid={invalid}
          saving={saving}
          conflict={conflict}
          onSave={() => void doSave(false)}
          onForceSave={() => void doSave(true)}
          onCancelConflict={() => setConflict(false)}
          onReset={reset}
        />
      }
    >
      <div className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2">
        <span className="font-medium text-fg">Enable run_code</span>
        <Switch
          checked={enabled}
          onChange={setEnabled}
          label="Enable run_code"
        />
      </div>

      <StringListEditor
        label="Tools callable from code"
        values={callableTools}
        onChange={setCallableTools}
        placeholder="tool_name or *"
      />

      <StringListEditor
        label="Code-only (exclusive) tools"
        values={exclusiveTools}
        onChange={setExclusiveTools}
        placeholder="mcp__*"
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <NumberField
          label="Timeout"
          value={timeoutMs}
          onChange={setTimeoutMs}
          effective={eff.timeoutMs as number | undefined}
          unit="ms"
          error={tCheck.error}
        />
        <NumberField
          label="Memory Limit"
          value={memoryLimitMb}
          onChange={setMemoryLimitMb}
          effective={eff.memoryLimitMb as number | undefined}
          unit="MB"
          error={mCheck.error}
        />
        <NumberField
          label="Max Tool Calls"
          value={maxToolCalls}
          onChange={setMaxToolCalls}
          effective={eff.maxToolCalls as number | undefined}
          error={cCheck.error}
        />
        <NumberField
          label="Max output"
          value={maxOutputChars}
          onChange={setMaxOutputChars}
          effective={eff.maxOutputChars as number | undefined}
          unit="chars"
          error={oCheck.error}
        />
      </div>
    </Card>
  );
}

export function ToolsSection() {
  const { view } = useSettings();
  const { tools } = useTools(undefined, true);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q) ||
        (t.source || "").toLowerCase().includes(q)
    );
  }, [filter, tools]);

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Tools & Code Mode"
        description="Configure programmatic tool execution and inspect registered tools."
      />

      <CodeModeCard key={stable(view.config.codeMode)} />

      <Card
        title="Available Tools"
        actions={
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tools..."
            aria-label="Filter tools"
            className={`${inputCls} w-48`}
          />
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[11px] uppercase text-muted">
                <th className="py-2 pr-3">Tool</th>
                <th className="py-2 pr-3">Description</th>
                <th className="py-2 pr-3">Plugin / runtime</th>
                <th className="py-2 pr-3">Read/write</th>
                <th className="py-2">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {filtered.map((t) => (
                <tr key={t.name}>
                  <td className="py-2 pr-3 font-mono font-medium text-fg">
                    {t.name}
                  </td>
                  <td className="py-2 pr-3 text-muted">
                    {t.description || "—"}
                  </td>
                  <td className="py-2 pr-3 text-muted">
                    {t.plugin ? (
                      <Badge tone="accent">plugin: {t.plugin}</Badge>
                    ) : (
                      <span className="font-mono text-[11px]">
                        {t.source || "built-in"}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {t.readOnly ? (
                      <Badge tone="accent">read-only</Badge>
                    ) : (
                      <Badge tone="warning">write</Badge>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      <Badge tone="neutral">{t.source || "built-in"}</Badge>
                      {t.plugin && (
                        <Badge tone="accent">plugin: {t.plugin}</Badge>
                      )}
                      {t.codeOnly && <Badge tone="neutral">code-only</Badge>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
