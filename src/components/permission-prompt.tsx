import { useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { PermissionReply, PermissionRequest } from "@openharness/sdk";
import { stringify } from "@/lib/format";
import { Badge, Spinner } from "./ui";

export function PermissionPrompt({
  requests,
  onReply,
}: {
  requests: PermissionRequest[];
  onReply: (id: string, reply: PermissionReply) => Promise<boolean>;
}) {
  const current = requests[0];
  const [busy, setBusy] = useState<PermissionReply | null>(null);
  const allowOnceRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setBusy(null);
    if (current) {
      requestAnimationFrame(() => {
        allowOnceRef.current?.focus();
      });
    }
  }, [current?.id]);

  if (!current) return null;

  const handleReply = async (reply: PermissionReply) => {
    if (busy) return;
    setBusy(reply);
    await onReply(current.id, reply);
    setBusy(null);
  };

  const metaInput = current.metadata?.input;

  return (
    <div
      role="alertdialog"
      aria-labelledby="oh-perm-title"
      aria-describedby="oh-perm-desc"
      className="mx-auto w-full max-w-[720px] px-4 pb-2 animate-fade-in"
    >
      <div className="overflow-hidden rounded-xl border border-warning/35 bg-elev p-4 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldAlert
              className="size-4 shrink-0 text-warning"
              aria-hidden="true"
            />
            <span id="oh-perm-title" className="text-xs font-semibold text-fg">
              {current.title || `Allow ${current.permission}?`}
            </span>
            <Badge tone="warning">{current.permission}</Badge>
          </div>
          {requests.length > 1 && (
            <Badge tone="neutral">+{requests.length - 1} more</Badge>
          )}
        </div>

        <div id="oh-perm-desc" className="mt-2 space-y-2 text-xs text-muted">
          {current.pattern && (
            <div className="flex items-center gap-2">
              <span>Pattern:</span>
              <code className="rounded border border-border bg-code px-2 py-0.5 font-mono text-xs text-fg">
                {current.pattern}
              </code>
            </div>
          )}
          {metaInput !== undefined && (
            <pre className="max-h-32 overflow-auto rounded-lg bg-code p-3 font-mono text-xs text-fg whitespace-pre-wrap">
              {stringify(metaInput)}
            </pre>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => handleReply("reject")}
            className="touch-target inline-flex h-8 items-center gap-2 rounded-lg border border-danger/35 bg-danger/10 px-3 text-xs font-medium text-danger transition-colors duration-150 ease-out hover:bg-danger/15 disabled:opacity-40"
          >
            {busy === "reject" && <Spinner className="size-3" />}
            <span>Reject</span>
          </button>

          <button
            type="button"
            disabled={busy !== null}
            onClick={() => handleReply("always")}
            className="touch-target inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-bg px-3 text-xs font-medium text-fg transition-colors duration-150 ease-out hover:bg-hover disabled:opacity-40"
          >
            {busy === "always" && <Spinner className="size-3" />}
            <span>Always</span>
          </button>

          <button
            ref={allowOnceRef}
            type="button"
            disabled={busy !== null}
            onClick={() => handleReply("once")}
            className="touch-target inline-flex h-8 items-center gap-2 rounded-lg bg-accent px-3 text-xs font-medium text-accent-fg transition-colors duration-150 ease-out hover:bg-accent-strong disabled:opacity-40"
          >
            {busy === "once" && <Spinner className="size-3" />}
            <span>Allow once</span>
          </button>
        </div>
      </div>
    </div>
  );
}
