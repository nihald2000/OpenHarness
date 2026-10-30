import { useState } from "react";
import { Plus, X } from "lucide-react";
import {
  assignKey,
  buttonSecondary,
  Card,
  inputCls,
  isRecord,
  NumberField,
  orNull,
  parseNumber,
  SaveBar,
  SectionHeading,
  stable,
  Switch,
  useSettings,
} from "./controls";

const LIMIT_SPECS = [
  {
    key: "maxConcurrentRuns",
    label: "Max concurrent runs",
    min: 1,
    max: 100,
  },
  {
    key: "maxRunDurationSec",
    label: "Max run duration",
    unit: "sec",
    min: 1,
  },
  {
    key: "maxSessionContextTokens",
    label: "Max session context tokens",
    min: 1000,
  },
  {
    key: "maxTokensPerTurn",
    label: "Max tokens per turn",
    min: 100,
  },
  {
    key: "maxToolOutputChars",
    label: "Max tool output",
    unit: "chars",
    min: 100,
  },
  {
    key: "maxToolDepth",
    label: "Max subagent depth",
    min: 1,
    max: 10,
  },
  {
    key: "maxIterations",
    label: "Max turns per run",
    min: 1,
  },
] as const;

function LimitsCard() {
  const { view, saveSections, handleError } = useSettings();
  const raw = isRecord(view.config.limits) ? view.config.limits : {};
  const eff = isRecord(view.effective.limits) ? view.effective.limits : {};

  const initial: Record<string, string> = {};
  for (const spec of LIMIT_SPECS) {
    initial[spec.key] =
      raw[spec.key] !== undefined ? String(raw[spec.key]) : "";
  }

  const [vals, setVals] = useState<Record<string, string>>(initial);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const errors: Record<string, string | null> = {};
  let invalid = false;
  for (const spec of LIMIT_SPECS) {
    const parsed = parseNumber(vals[spec.key] ?? "", {
      int: true,
      min: spec.min,
      max: "max" in spec ? spec.max : undefined,
    });
    errors[spec.key] = parsed.error;
    if (parsed.error) invalid = true;
  }

  const dirty = stable(vals) !== stable(initial);

  const doSave = async (force = false) => {
    if (invalid) return;
    let next: Record<string, unknown> = { ...raw };
    for (const spec of LIMIT_SPECS) {
      const parsed = parseNumber(vals[spec.key] ?? "", { int: true });
      next = assignKey(next, spec.key, parsed.value);
    }
    setSaving(true);
    try {
      await saveSections(
        "Limits",
        [{ section: "limits", value: orNull(next) }],
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
      title="Limits"
      description="Execution concurrency, token budgets, and recursion caps."
      footer={
        <SaveBar
          dirty={dirty}
          invalid={invalid}
          saving={saving}
          conflict={conflict}
          onSave={() => void doSave(false)}
          onForceSave={() => void doSave(true)}
          onCancelConflict={() => setConflict(false)}
          onReset={() => {
            setVals(initial);
            setConflict(false);
          }}
        />
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {LIMIT_SPECS.map((spec) => (
          <NumberField
            key={spec.key}
            label={spec.label}
            value={vals[spec.key] ?? ""}
            onChange={(v) => setVals((p) => ({ ...p, [spec.key]: v }))}
            effective={eff[spec.key] as number | undefined}
            unit={"unit" in spec ? spec.unit : undefined}
            error={errors[spec.key]}
          />
        ))}
      </div>
    </Card>
  );
}

function CompactionCard() {
  const { view, saveSections, handleError } = useSettings();
  const raw = isRecord(view.config.compaction) ? view.config.compaction : {};
  const eff = isRecord(view.effective.compaction)
    ? view.effective.compaction
    : {};

  const effTrigger =
    typeof eff.triggerAt === "number" ? eff.triggerAt : 0.8;

  const initial = {
    enabled:
      typeof raw.enabled === "boolean"
        ? raw.enabled
        : Boolean(eff.enabled ?? true),
    triggerAt:
      typeof raw.triggerAt === "number" ? raw.triggerAt : undefined,
    maxMessages:
      raw.maxMessages !== undefined ? String(raw.maxMessages) : "",
    keepFirst: raw.keepFirst !== undefined ? String(raw.keepFirst) : "",
    keepLast: raw.keepLast !== undefined ? String(raw.keepLast) : "",
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [triggerAt, setTriggerAt] = useState<number | undefined>(
    initial.triggerAt
  );
  const [maxMessages, setMaxMessages] = useState(initial.maxMessages);
  const [keepFirst, setKeepFirst] = useState(initial.keepFirst);
  const [keepLast, setKeepLast] = useState(initial.keepLast);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const mCheck = parseNumber(maxMessages, { int: true, min: 4 });
  const kfCheck = parseNumber(keepFirst, { int: true, min: 0 });
  const klCheck = parseNumber(keepLast, { int: true, min: 2 });
  const invalid = Boolean(mCheck.error || kfCheck.error || klCheck.error);

  const dirty =
    enabled !== initial.enabled ||
    triggerAt !== initial.triggerAt ||
    maxMessages !== initial.maxMessages ||
    keepFirst !== initial.keepFirst ||
    keepLast !== initial.keepLast;

  const doSave = async (force = false) => {
    if (invalid) return;
    let next: Record<string, unknown> = { ...raw, enabled };
    next = assignKey(next, "triggerAt", triggerAt);
    next = assignKey(next, "maxMessages", mCheck.value);
    next = assignKey(next, "keepFirst", kfCheck.value);
    next = assignKey(next, "keepLast", klCheck.value);

    setSaving(true);
    try {
      await saveSections(
        "Context compaction",
        [{ section: "compaction", value: orNull(next) }],
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

  const sliderVal = triggerAt ?? effTrigger;

  return (
    <Card
      title="Context compaction"
      description="Automatic context summarization thresholds."
      footer={
        <SaveBar
          dirty={dirty}
          invalid={invalid}
          saving={saving}
          conflict={conflict}
          onSave={() => void doSave(false)}
          onForceSave={() => void doSave(true)}
          onCancelConflict={() => setConflict(false)}
          onReset={() => {
            setEnabled(initial.enabled);
            setTriggerAt(initial.triggerAt);
            setMaxMessages(initial.maxMessages);
            setKeepFirst(initial.keepFirst);
            setKeepLast(initial.keepLast);
            setConflict(false);
          }}
        />
      }
    >
      <div className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2">
        <span className="font-medium text-fg">Enable auto-compaction</span>
        <Switch
          checked={enabled}
          onChange={setEnabled}
          label="Enable auto-compaction"
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="font-medium text-fg">
            Trigger at ({Math.round(sliderVal * 100)}% of context window)
          </span>
          {triggerAt !== undefined && (
            <button
              type="button"
              onClick={() => setTriggerAt(undefined)}
              className="text-[11px] text-accent hover:underline"
            >
              Use default ({Math.round(effTrigger * 100)}%)
            </button>
          )}
        </div>
        <input
          type="range"
          min={0.5}
          max={0.95}
          step={0.05}
          value={sliderVal}
          onChange={(e) => setTriggerAt(Number(e.target.value))}
          aria-label="Auto-compaction threshold"
          className="w-full accent-accent"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <NumberField
          label="Max messages"
          value={maxMessages}
          onChange={setMaxMessages}
          effective={eff.maxMessages as number | undefined}
          error={mCheck.error}
        />
        <NumberField
          label="Keep first"
          value={keepFirst}
          onChange={setKeepFirst}
          effective={eff.keepFirst as number | undefined}
          error={kfCheck.error}
        />
        <NumberField
          label="Keep recent"
          value={keepLast}
          onChange={setKeepLast}
          effective={eff.keepLast as number | undefined}
          error={klCheck.error}
        />
      </div>
    </Card>
  );
}

function VerifyLoopCard() {
  const { view, saveSections, handleError } = useSettings();
  const raw = isRecord(view.config.verify) ? view.config.verify : {};
  const eff = isRecord(view.effective.verify) ? view.effective.verify : {};

  const rawCmds = Array.isArray(raw.commands)
    ? (raw.commands as Array<Record<string, unknown>>).map((c) => ({
        name: typeof c.name === "string" ? c.name : "",
        command: typeof c.command === "string" ? c.command : String(c),
      }))
    : [];

  const initial = {
    auto:
      typeof raw.auto === "boolean" ? raw.auto : Boolean(eff.auto ?? false),
    maxIterations:
      raw.maxIterations !== undefined ? String(raw.maxIterations) : "",
    commands: rawCmds,
  };

  const [auto, setAuto] = useState(initial.auto);
  const [maxIterations, setMaxIterations] = useState(initial.maxIterations);
  const [commands, setCommands] = useState(initial.commands);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const iterCheck = parseNumber(maxIterations, { int: true, min: 1, max: 10 });
  const invalid = Boolean(iterCheck.error);

  const dirty =
    auto !== initial.auto ||
    maxIterations !== initial.maxIterations ||
    stable(commands) !== stable(initial.commands);

  const doSave = async (force = false) => {
    if (invalid) return;
    let next: Record<string, unknown> = { ...raw, auto };
    next = assignKey(next, "maxIterations", iterCheck.value);
    const cleanedCmds = commands
      .filter((c) => c.command.trim())
      .map((c) => ({
        name: c.name.trim() || c.command.trim(),
        command: c.command.trim(),
      }));
    next = assignKey(
      next,
      "commands",
      cleanedCmds.length > 0 ? cleanedCmds : undefined
    );

    setSaving(true);
    try {
      await saveSections(
        "Verify & fix loop",
        [{ section: "verify", value: orNull(next) }],
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
      title="Verify & fix loop"
      description="Automated post-turn verification commands and self-healing iterations."
      footer={
        <SaveBar
          dirty={dirty}
          invalid={invalid}
          saving={saving}
          conflict={conflict}
          onSave={() => void doSave(false)}
          onForceSave={() => void doSave(true)}
          onCancelConflict={() => setConflict(false)}
          onReset={() => {
            setAuto(initial.auto);
            setMaxIterations(initial.maxIterations);
            setCommands(initial.commands);
            setConflict(false);
          }}
        />
      }
    >
      <div className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2">
        <span className="font-medium text-fg">Run verification automatically</span>
        <Switch
          checked={auto}
          onChange={setAuto}
          label="Run verification automatically"
        />
      </div>

      <NumberField
        label="Max iterations (1-10)"
        value={maxIterations}
        onChange={setMaxIterations}
        effective={eff.maxIterations as number | undefined}
        error={iterCheck.error}
      />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-medium text-fg">Verify commands</span>
          <button
            type="button"
            onClick={() =>
              setCommands((prev) => [...prev, { name: "", command: "" }])
            }
            className={buttonSecondary}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            <span>Add command</span>
          </button>
        </div>

        {commands.map((row, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <input
              type="text"
              value={row.name}
              onChange={(e) => {
                const v = e.target.value;
                setCommands((prev) =>
                  prev.map((r, i) => (i === idx ? { ...r, name: v } : r))
                );
              }}
              placeholder="Name (e.g. typecheck)"
              aria-label="Verify command name"
              className={`${inputCls} w-1/3`}
            />
            <input
              type="text"
              value={row.command}
              onChange={(e) => {
                const v = e.target.value;
                setCommands((prev) =>
                  prev.map((r, i) => (i === idx ? { ...r, command: v } : r))
                );
              }}
              placeholder="bun run typecheck"
              aria-label="Verify shell command"
              className={`${inputCls} flex-1 font-mono`}
            />
            <button
              type="button"
              onClick={() =>
                setCommands((prev) => prev.filter((_, i) => i !== idx))
              }
              aria-label="Remove verify command"
              className="text-muted hover:text-danger"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function LimitsSection() {
  const { view } = useSettings();
  return (
    <div className="space-y-4">
      <SectionHeading
        title="Limits & context"
        description="Configure session limits, automatic context compaction, and verify-fix loops."
      />
      <LimitsCard key={`lim-${stable(view.config.limits)}`} />
      <CompactionCard key={`cmp-${stable(view.config.compaction)}`} />
      <VerifyLoopCard key={`ver-${stable(view.config.verify)}`} />
    </div>
  );
}
