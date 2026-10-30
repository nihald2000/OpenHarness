import { useState } from "react";
import { LogOut, RefreshCw } from "lucide-react";
import { client } from "@/lib/client";
import { isStatus, stringify } from "@/lib/format";
import { useApp, useCatalog } from "@/lib/hooks";
import { useAdmin } from "@/lib/use-admin";
import { CopyButton } from "../copy-button";
import { Spinner } from "../ui";
import {
  ActiveRunWarning,
  buttonSecondary,
  Card,
  dangerButton,
  SectionHeading,
  useSettings,
} from "./controls";

export function AdvancedSection() {
  const { notify } = useApp();
  const { refresh: refreshCatalog } = useCatalog();
  const { logout } = useAdmin();
  const { view, refresh, handleError } = useSettings();

  const [reloading, setReloading] = useState(false);
  const [conflict, setConflict] = useState(false);

  const formattedJson = stringify(view.config);

  const handleReload = async (force = false) => {
    setReloading(true);
    try {
      const res = await client.reload(force);
      setConflict(false);
      await Promise.all([refresh(), refreshCatalog()]);
      notify(
        "success",
        res.reloaded === false
          ? "Reload scheduled - it applies before the next run starts."
          : "Configuration reloaded."
      );
    } catch (err) {
      if (isStatus(err, 409)) {
        setConflict(true);
      } else {
        handleError(err);
      }
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Advanced"
        description="Inspect masked project configuration JSON, reload server state, or sign out."
      />

      <Card
        title="Project configuration"
        description={`Masked snapshot of ${view.file}.`}
        actions={<CopyButton text={formattedJson} label="Copy JSON" />}
      >
        <pre
          tabIndex={0}
          className="max-h-[32rem] overflow-auto rounded-xl border border-border bg-code p-3 font-mono text-xs leading-relaxed text-fg"
        >
          {formattedJson}
        </pre>
      </Card>

      <Card
        title="Maintenance"
        description="Reload configuration from disk or sign out of the administrator session."
      >
        {conflict ? (
          <ActiveRunWarning
            onConfirm={() => void handleReload(true)}
            onCancel={() => {
              setConflict(false);
              notify("info", "Not applied - active runs were left running.");
            }}
            saving={reloading}
          />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              disabled={reloading}
              onClick={() => void handleReload(false)}
              className={buttonSecondary}
            >
              {reloading ? (
                <Spinner />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden="true" />
              )}
              <span>Reload configuration</span>
            </button>

            <button
              type="button"
              onClick={() => void logout()}
              className={dangerButton}
            >
              <LogOut className="size-3.5" aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
