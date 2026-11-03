import { useEffect, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { client, type TenantProviderView } from "@/lib/client";
import { errorMessage } from "@/lib/format";
import { useApp, useCatalog } from "@/lib/hooks";
import { buttonPrimary, buttonSecondary, Card, inputCls, SectionHeading } from "./controls";

const PROVIDER_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;

export function GuestProvidersSection() {
  const { notify } = useApp();
  const { refresh: refreshCatalog } = useCatalog();
  const [providers, setProviders] = useState<TenantProviderView[]>([]);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelIds, setModelIds] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => setProviders(await client.userProviders.list());
  useEffect(() => { void load().catch((err) => setError(errorMessage(err))); }, []);

  const edit = (provider: TenantProviderView) => {
    setId(provider.id);
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setApiKey("");
    setModelIds(provider.models.map((model) => model.id).join("\n"));
    setEditing(true);
    setError("");
  };

  const reset = () => {
    setId(""); setName(""); setBaseUrl(""); setApiKey(""); setModelIds(""); setEditing(false); setError("");
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!PROVIDER_ID_RE.test(id.trim())) { setError("Provider ID must contain 1–40 letters, numbers, underscores, or hyphens."); return; }
    const models = modelIds.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).map((modelId) => ({ id: modelId, name: modelId }));
    if (models.length === 0) { setError("Enter at least one model ID."); return; }
    setBusy(true);
    try {
      await client.userProviders.save(id.trim(), { name: name.trim(), baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), models });
      await load();
      await refreshCatalog();
      notify("success", "Your provider is saved for this guest account.");
      reset();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };

  const remove = async (provider: TenantProviderView) => {
    if (!window.confirm(`Remove ${provider.name} and its saved credential from this guest account?`)) return;
    setBusy(true);
    try {
      await client.userProviders.delete(provider.id);
      await load();
      await refreshCatalog();
      notify("success", "Provider removed.");
      if (id === provider.id) reset();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <SectionHeading title="Your model providers" description="Add a personal OpenAI-compatible endpoint. Provider URLs and encrypted credentials are scoped to this guest account; server-wide admin secrets stay private." />
      <Card title="Saved providers">
        {providers.length === 0 ? <p className="py-2 text-muted">No personal providers yet. Models configured by the server remain available above.</p> : (
          <div className="space-y-2">
            {providers.map((provider) => (
              <div key={provider.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg p-3">
                <div className="min-w-0">
                  <div className="truncate font-medium text-fg">{provider.name} <span className="font-mono text-muted">({provider.id})</span></div>
                  <div className="truncate text-muted">{provider.baseUrl}</div>
                  <div className="text-muted">{provider.models.length} model(s) · {provider.hasApiKey ? "credential stored encrypted" : "credential missing"}</div>
                </div>
                <div className="flex gap-2">
                  <button type="button" className={buttonSecondary} onClick={() => edit(provider)}>Edit</button>
                  <button type="button" className={buttonSecondary} disabled={busy} onClick={() => void remove(provider)} aria-label={`Remove ${provider.name}`}><Trash2 className="size-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card title={editing ? `Edit ${id}` : "Add a provider"}>
        <form onSubmit={(event) => void save(event)} className="space-y-3">
          {error && <p role="alert" className="text-danger">{error}</p>}
          <label className="block space-y-1"><span className="text-fg">Provider ID</span><input className={inputCls} value={id} onChange={(event) => setId(event.target.value)} disabled={editing} placeholder="my-provider" autoComplete="off" /></label>
          <label className="block space-y-1"><span className="text-fg">Display name</span><input className={inputCls} value={name} onChange={(event) => setName(event.target.value)} placeholder="My Model API" /></label>
          <label className="block space-y-1"><span className="text-fg">Base URL</span><input className={inputCls} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" autoComplete="url" /></label>
          <label className="block space-y-1"><span className="text-fg">API key</span><input className={inputCls} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={editing ? "Leave blank to keep the saved key" : "Paste your provider key"} autoComplete="new-password" /></label>
          <label className="block space-y-1"><span className="text-fg">Model IDs</span><textarea className={`${inputCls} min-h-24 font-mono`} value={modelIds} onChange={(event) => setModelIds(event.target.value)} placeholder={'provider/model-a\nprovider/model-b'} /></label>
          <p className="text-muted">Only HTTPS public endpoints are accepted. Keys are write-only and encrypted at rest. Each guest account can use up to 10 providers.</p>
          <div className="flex gap-2"><button className={buttonPrimary} disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Save provider"}</button>{editing && <button type="button" className={buttonSecondary} onClick={reset}>Cancel</button>}</div>
        </form>
      </Card>
    </div>
  );
}
