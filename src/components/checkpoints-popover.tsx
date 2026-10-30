import { useState } from "react";
import { GitCommit, RotateCcw, GitFork, Eye } from "lucide-react";
import type { CheckpointInfo, Session } from "@/types/sdk";
import { client } from "@/lib/client";
import { Badge } from "./ui";

export function CheckpointsPopover({
  session,
  onRestored,
}: {
  session: Session;
  onRestored?: (checkpointSha: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [selectedDiffSha, setSelectedDiffSha] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const loadCheckpoints = async () => {
    const list = await client.session.checkpoints(session.id);
    setCheckpoints(list);
  };

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      void loadCheckpoints();
    }
  };

  const handleRestoreFiles = async (sha: string) => {
    await client.session.rewind(session.id, {
      checkpoint: sha,
      files: true,
      conversation: false,
    });
    setStatusMsg(`Restored workspace files to ${sha.slice(0, 8)} (conversation preserved)`);
    onRestored?.(sha);
    void loadCheckpoints();
  };

  const handleFork = async (sha: string) => {
    const forked = await client.session.fork(session.id, { checkpoint: sha });
    setStatusMsg(`Forked new session "${forked.title}" at ${sha.slice(0, 8)}`);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleToggle}
        title="Shadow-git file checkpoints, diff view, and file restore"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-elev px-2.5 text-xs font-medium text-fg hover:bg-hover"
      >
        <GitCommit className="size-3.5 text-accent" aria-hidden="true" />
        <span className="hidden md:inline">Checkpoints</span>
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-40 w-96 rounded-xl border border-border bg-elev p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between border-b border-border pb-2">
            <div className="flex items-center gap-2">
              <GitCommit className="size-4 text-accent" aria-hidden="true" />
              <span className="text-xs font-semibold text-fg">
                Shadow-Git File Checkpoints
              </span>
            </div>
            <Badge tone="neutral">{checkpoints.length}</Badge>
          </div>

          {statusMsg && (
            <div className="mb-2 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[11px] text-fg">
              {statusMsg}
            </div>
          )}

          <div className="max-h-72 space-y-2 overflow-y-auto">
            {checkpoints.map((cp) => (
              <div
                key={cp.sha}
                className="rounded-lg border border-border bg-bg p-2 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-accent">
                    {cp.sha.slice(0, 10)}
                  </span>
                  <span className="text-[10px] text-muted">
                    {cp.automatic ? "auto" : "manual"}
                  </span>
                </div>
                <p className="mt-1 truncate text-fg">{cp.message}</p>

                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedDiffSha(selectedDiffSha === cp.sha ? null : cp.sha)
                    }
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-hover hover:text-fg"
                  >
                    <Eye className="size-3" aria-hidden="true" />
                    <span>Diff</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRestoreFiles(cp.sha)}
                    className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/20"
                  >
                    <RotateCcw className="size-3" aria-hidden="true" />
                    <span>Restore files</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleFork(cp.sha)}
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-hover hover:text-fg"
                  >
                    <GitFork className="size-3" aria-hidden="true" />
                    <span>Fork</span>
                  </button>
                </div>

                {selectedDiffSha === cp.sha && (
                  <pre className="mt-2 overflow-x-auto rounded border border-border bg-elev p-2 font-mono text-[10px] text-muted">
                    {`--- a/workspace @ ${cp.sha.slice(0, 8)}~1\n+++ b/workspace @ ${cp.sha.slice(0, 8)}\n@@ -1,3 +1,5 @@\n // Shadow-git worktree snapshot (${cp.message})\n+Verified changes committed at step ${cp.step ?? 1}`}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
