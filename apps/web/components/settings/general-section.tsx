"use client";

import React, { useMemo, useState } from "react";
import { useCatalog } from "@/lib/hooks";
import { Badge } from "../ui";
import {
  asString,
  asStringArray,
  Card,
  Field,
  isRecord,
  SaveBar,
  SectionHeading,
  selectCls,
  stable,
  useSettings,
} from "./controls";

function DefaultsCard() {
  const { view, saveSections, handleError } = useSettings();
  const { models, primaryAgents, runtimes } = useCatalog();

  const cfg = view.config;
  const eff = view.effective;

  const initial = {
    model: asString(cfg.model),
    smallModel: asString(cfg.smallModel),
    defaultAgent: asString(cfg.defaultAgent),
    defaultRuntime: asString(cfg.defaultRuntime),
  };

  const [model, setModel] = useState(initial.model);
  const [smallModel, setSmallModel] = useState(initial.smallModel);
  const [defaultAgent, setDefaultAgent] = useState(initial.defaultAgent);
  const [defaultRuntime, setDefaultRuntime] = useState(initial.defaultRuntime);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const dirty =
    model !== initial.model ||
    smallModel !== initial.smallModel ||
    defaultAgent !== initial.defaultAgent ||
    defaultRuntime !== initial.defaultRuntime;

  const modelsByProvider = useMemo(() => {
    const groups = new Map<string, typeof models>();
    for (const m of models) {
      const p = m.provider || "Other";
      const list = groups.get(p) ?? [];
      list.push(m);
      groups.set(p, list);
    }
    return Array.from(groups.entries());
  }, [models]);

  const reset = () => {
    setModel(initial.model);
    setSmallModel(initial.smallModel);
    setDefaultAgent(initial.defaultAgent);
    setDefaultRuntime(initial.defaultRuntime);
    setConflict(false);
  };

  const doSave = async (force = false) => {
    const updates: Array<{ section: string; value: unknown }> = [];
    if (model !== initial.model) {
      updates.push({ section: "model", value: model || null });
    }
    if (smallModel !== initial.smallModel) {
      updates.push({ section: "smallModel", value: smallModel || null });
    }
    if (defaultAgent !== initial.defaultAgent) {
      updates.push({ section: "defaultAgent", value: defaultAgent || null });
    }
    if (defaultRuntime !== initial.defaultRuntime) {
      updates.push({
        section: "defaultRuntime",
        value: defaultRuntime || null,
      });
    }
    if (updates.length === 0) return;

    setSaving(true);
    try {
      await saveSections("Defaults", updates, force);
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

  const effModel = asString(eff.model, "First available model");
  const effSmall = asString(eff.smallModel, "Uses the default model");
  const effAgent = asString(eff.defaultAgent, "assistant");
  const effRuntime = asString(eff.defaultRuntime, "local");

  const modelAvailable = !model || models.some((m) => m.id === model);
  const smallAvailable = !smallModel || models.some((m) => m.id === smallModel);
  const agentAvailable =
    !defaultAgent || primaryAgents.some((a) => a.name === defaultAgent);
  const runtimeAvailable =
    !defaultRuntime || runtimes.some((r) => r.id === defaultRuntime);

  return (
    <Card
      title="Defaults"
      description="Default model, agent, and execution runtime for new sessions."
      footer={
        <SaveBar
          dirty={dirty}
          saving={saving}
          conflict={conflict}
          onSave={() => void doSave(false)}
          onForceSave={() => void doSave(true)}
          onCancelConflict={() => setConflict(false)}
          onReset={reset}
        />
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Default model" hint="Format: provider/model.">
          {(props) => (
            <select
              {...props}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={selectCls}
            >
              <option value="">Not set - currently {effModel}</option>
              {!modelAvailable && model && (
                <option value={model}>{model} (not available)</option>
              )}
              {modelsByProvider.map(([prov, list]) => (
                <optgroup key={prov} label={prov}>
                  {list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id} ({m.id})
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </Field>

        <Field
          label="Small model"
          hint="Optional cheaper model for titles and summaries."
        >
          {(props) => (
            <select
              {...props}
              value={smallModel}
              onChange={(e) => setSmallModel(e.target.value)}
              className={selectCls}
            >
              <option value="">Not set - currently {effSmall}</option>
              {!smallAvailable && smallModel && (
                <option value={smallModel}>{smallModel} (not available)</option>
              )}
              {modelsByProvider.map(([prov, list]) => (
                <optgroup key={prov} label={prov}>
                  {list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id} ({m.id})
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </Field>

        <Field label="Default agent">
          {(props) => (
            <select
              {...props}
              value={defaultAgent}
              onChange={(e) => setDefaultAgent(e.target.value)}
              className={selectCls}
            >
              <option value="">Not set - currently {effAgent}</option>
              {!agentAvailable && defaultAgent && (
                <option value={defaultAgent}>
                  {defaultAgent} (not available)
                </option>
              )}
              {primaryAgents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          label="Default runtime"
          hint="Where shell commands run. Plugin runtimes start on first use."
        >
          {(props) => (
            <select
              {...props}
              value={defaultRuntime}
              onChange={(e) => setDefaultRuntime(e.target.value)}
              className={selectCls}
            >
              <option value="">Not set - currently {effRuntime}</option>
              {!runtimeAvailable && defaultRuntime && (
                <option value={defaultRuntime}>
                  {defaultRuntime} (not available)
                </option>
              )}
              {runtimes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
    </Card>
  );
}

export function GeneralSection() {
  const { view } = useSettings();
  const eff = view.effective;
  const server = isRecord(eff.server) ? eff.server : {};
  const cors = asStringArray(server.corsOrigins);
  const allowlist = asStringArray(eff.pluginAllowlist);

  return (
    <div className="space-y-4">
      <SectionHeading
        title="General"
        description="Default session selections, server parameters, and configuration file sources."
      />

      <DefaultsCard key={stable(view.config)} />

      <Card title="Server" description="Read-only runtime server status.">
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs">
          <div className="rounded-lg border border-border bg-bg px-3 py-2">
            <dt className="text-[11px] text-muted">Host</dt>
            <dd className="mt-0.5 font-mono text-fg">
              {asString(server.host, "127.0.0.1")}
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-bg px-3 py-2">
            <dt className="text-[11px] text-muted">Port</dt>
            <dd className="mt-0.5 font-mono text-fg">
              {String(server.port ?? 4096)}
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-bg px-3 py-2">
            <dt className="text-[11px] text-muted">Auth required</dt>
            <dd className="mt-0.5">
              <Badge tone={server.authRequired ? "success" : "neutral"}>
                {server.authRequired ? "Yes" : "No"}
              </Badge>
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-bg px-3 py-2">
            <dt className="text-[11px] text-muted">Storage</dt>
            <dd className="mt-0.5 font-mono text-fg">
              {asString(eff.storage, "sqlite")}
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-bg px-3 py-2 sm:col-span-2">
            <dt className="text-[11px] text-muted">CORS origins</dt>
            <dd className="mt-0.5 font-mono text-fg">
              {cors.length > 0 ? cors.join(", ") : "None"}
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-bg px-3 py-2 sm:col-span-2">
            <dt className="text-[11px] text-muted">Plugin Allowlist</dt>
            <dd className="mt-0.5 font-mono text-fg">
              {allowlist.length > 0 ? allowlist.join(", ") : "None"}
            </dd>
          </div>
        </dl>
      </Card>

      <Card title="Configuration sources">
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Project file:</span>
            <code className="rounded border border-border bg-code px-1.5 py-0.5 font-mono text-[11px] text-fg">
              {view.file}
            </code>
            {!view.exists && <Badge tone="neutral">not created yet</Badge>}
          </div>

          {view.sources && view.sources.length > 0 ? (
            <ol className="list-decimal pl-5 space-y-1 font-mono text-[11px] text-muted">
              {view.sources.map((src, i) => (
                <li key={i}>{src}</li>
              ))}
            </ol>
          ) : (
            <p className="text-muted">
              No configuration files found - defaults and environment only.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
