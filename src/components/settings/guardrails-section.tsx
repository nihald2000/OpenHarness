import { useState } from "react";
import {
  asStringArray,
  assignKey,
  Card,
  isRecord,
  orNull,
  SaveBar,
  SectionHeading,
  stable,
  StringListEditor,
  Switch,
  useSettings,
} from "./controls";

function validateRegex(pattern: string): string | null {
  try {
    new RegExp(pattern, "i");
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid regular expression.";
  }
}

function GuardrailsCard() {
  const { view, saveSections, handleError } = useSettings();
  const raw = isRecord(view.config.guardrails) ? view.config.guardrails : {};
  const eff = isRecord(view.effective.guardrails)
    ? view.effective.guardrails
    : {};

  const initial = {
    redactPii:
      typeof raw.redactPii === "boolean"
        ? raw.redactPii
        : Boolean(eff.redactPii ?? false),
    blockedPatterns: asStringArray(raw.blockedPatterns),
  };

  const [redactPii, setRedactPii] = useState(initial.redactPii);
  const [blockedPatterns, setBlockedPatterns] = useState(
    initial.blockedPatterns
  );
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const invalid = blockedPatterns.some((p) => validateRegex(p) !== null);
  const dirty =
    redactPii !== initial.redactPii ||
    stable(blockedPatterns) !== stable(initial.blockedPatterns);

  const doSave = async (force = false) => {
    if (invalid) return;
    let next: Record<string, unknown> = { ...raw, redactPii };
    next = assignKey(
      next,
      "blockedPatterns",
      blockedPatterns.length > 0 ? blockedPatterns : undefined
    );

    setSaving(true);
    try {
      await saveSections(
        "Guardrails",
        [{ section: "guardrails", value: orNull(next) }],
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
      title="Guardrails"
      description="Filter sensitive data and block prohibited input patterns."
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
            setRedactPii(initial.redactPii);
            setBlockedPatterns(initial.blockedPatterns);
            setConflict(false);
          }}
        />
      }
    >
      <div className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2">
        <span className="font-medium text-fg">Redact personal data</span>
        <Switch
          checked={redactPii}
          onChange={setRedactPii}
          label="Redact personal data"
        />
      </div>

      <StringListEditor
        label="Blocked input patterns"
        hint="Validated as case-insensitive JavaScript regular expressions."
        values={blockedPatterns}
        onChange={setBlockedPatterns}
        placeholder="e.g. DROP\\s+TABLE"
        validateItem={validateRegex}
      />
    </Card>
  );
}

export function GuardrailsSection() {
  const { view } = useSettings();
  return (
    <div className="space-y-4">
      <SectionHeading
        title="Guardrails"
        description="Configure safety filters and PII redaction rules."
      />
      <GuardrailsCard key={stable(view.config.guardrails)} />
    </div>
  );
}
