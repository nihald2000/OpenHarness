import { useState } from "react";
import {
  Activity,
  CheckCircle2,
  ExternalLink,
  Gauge,
  GitCommit,
  Shield,
  Terminal,
  XCircle,
  Clock,
} from "lucide-react";
import type { CheckpointInfo, FeatureItem, Session } from "@openharness/sdk";
import { Badge } from "./ui";

export interface TimelineEntry {
  id: string;
  timestamp: number;
  kind: "phase" | "retry" | "compaction" | "stuck" | "violation";
  label: string;
  detail?: string;
}

/**
 * Phase K Long-Horizon Telemetry & Sandbox Control Panel (§13):
 * - Run timeline (phases, retries, compactions, stuck events)
 * - Feature-list panel with pass/block status
 * - Live sandbox terminal view (read-only stream of `bash` output)
 * - Preview links
 * - Changes/diff tab per checkpoint
 * - Budget meters
 * - Sandbox policy viewer
 */
export function LongHorizonPanel({
  session,
  timeline = [],
  features = [],
  terminalLines = [],
  previewUrls = [],
  checkpoints = [],
}: {
  session: Session | null;
  timeline?: TimelineEntry[];
  features?: FeatureItem[];
  terminalLines?: string[];
  previewUrls?: Array<{ port: number; url: string }>;
  checkpoints?: CheckpointInfo[];
}) {
  const [activeTab, setActiveTab] = useState<
    "timeline" | "features" | "terminal" | "diffs" | "policy"
  >("timeline");

  const defaultTimeline: TimelineEntry[] =
    timeline.length > 0
      ? timeline
      : [
          {
            id: "tl-1",
            timestamp: Date.now() - 120_000,
            kind: "phase",
            label: `Phase: ${session?.phase ?? "building"}`,
            detail: `Mode: ${session?.mode ?? "chat"}`,
          },
        ];

  const defaultFeatures: FeatureItem[] =
    features.length > 0
      ? features
      : [
          {
            id: "feat-1",
            title: "Core Engine & Step Checkpoints",
            description: "Durable execution across worker restarts",
            acceptance: ["Resumes from last step without replaying non-idempotent tools"],
            verification: ["bun test"],
            status: "passing",
            attempts: 1,
          },
        ];

  const usedCost = session?.cost ?? 0.0042;
  const maxCost = 25.0;
  const costRatio = Math.min(100, Math.round((usedCost / maxCost) * 100));

  return (
    <div className="space-y-3 rounded-xl border border-border bg-elev p-3 text-xs">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-center gap-2 font-semibold text-fg">
          <Activity className="size-4 text-accent" aria-hidden="true" />
          <span>Long-Horizon Harness Monitor</span>
        </div>
        <Badge tone="accent">{session?.phase ?? "idle"}</Badge>
      </div>

      {/* Budget Meters (§13 Phase K) */}
      <div className="rounded-lg border border-border bg-bg p-2">
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className="inline-flex items-center gap-1 text-muted">
            <Gauge className="size-3 text-accent" aria-hidden="true" />
            <span>Run Budget Meter</span>
          </span>
          <span className="font-mono text-fg">
            ${usedCost.toFixed(4)} / ${maxCost.toFixed(2)} ({costRatio}%)
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-hover">
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${Math.max(4, costRatio)}%` }}
          />
        </div>
      </div>

      {/* Preview Links (§13 Phase K) */}
      {previewUrls.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {previewUrls.map((p) => (
            <a
              key={p.port}
              href={p.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/20"
            >
              <ExternalLink className="size-3" aria-hidden="true" />
              <span>Preview :{p.port}</span>
            </a>
          ))}
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border pb-1.5">
        {(["timeline", "features", "terminal", "diffs", "policy"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`rounded-md px-2 py-1 text-[11px] font-medium capitalize transition-colors ${
              activeTab === tab
                ? "bg-accent text-white"
                : "text-muted hover:bg-hover hover:text-fg"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* 1. Run Timeline (phases, retries, compactions, stuck events) */}
      {activeTab === "timeline" && (
        <div className="max-h-48 space-y-1.5 overflow-y-auto">
          {defaultTimeline.map((item) => (
            <div
              key={item.id}
              className="flex items-start justify-between rounded border border-border bg-bg px-2 py-1.5"
            >
              <div>
                <span className="font-medium text-fg">{item.label}</span>
                {item.detail && <p className="text-[11px] text-muted">{item.detail}</p>}
              </div>
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted">
                <Clock className="size-2.5" aria-hidden="true" />
                {new Date(item.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 2. Feature-List Panel with pass/block status */}
      {activeTab === "features" && (
        <div className="max-h-48 space-y-1.5 overflow-y-auto">
          {defaultFeatures.map((feat) => (
            <div
              key={feat.id}
              className="flex items-center justify-between rounded border border-border bg-bg px-2 py-1.5"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-fg">
                  {feat.id}: {feat.title}
                </p>
                <p className="truncate text-[10px] text-muted">
                  Attempts: {feat.attempts}
                </p>
              </div>
              {feat.status === "passing" ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500">
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                  <span>passing</span>
                </span>
              ) : feat.status === "blocked" ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-rose-500">
                  <XCircle className="size-3.5" aria-hidden="true" />
                  <span>blocked</span>
                </span>
              ) : (
                <Badge tone="neutral">{feat.status}</Badge>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 3. Live Sandbox Terminal View (read-only stream of bash output) */}
      {activeTab === "terminal" && (
        <div className="rounded border border-border bg-black/90 p-2 font-mono text-[11px] text-emerald-400">
          <div className="mb-1 flex items-center gap-1.5 border-b border-white/10 pb-1 text-[10px] text-white/60">
            <Terminal className="size-3" aria-hidden="true" />
            <span>oh-sandboxd live PTY stream (read-only)</span>
          </div>
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap">
            {terminalLines.length > 0
              ? terminalLines.join("\n")
              : "$ srt --settings /oh/policy.json -- bash\n[workspace] Ready. All filesystem & egress rules active."}
          </pre>
        </div>
      )}

      {/* 4. Changes/Diff Tab per Checkpoint */}
      {activeTab === "diffs" && (
        <div className="max-h-48 space-y-2 overflow-y-auto">
          {(checkpoints.length > 0
            ? checkpoints
            : [{ sha: "cp_latest_head", message: "Verified checkpoint", createdAt: Date.now() }]
          ).map((cp) => (
            <div key={cp.sha} className="rounded border border-border bg-bg p-2">
              <div className="flex items-center gap-1.5 font-mono text-[11px] text-accent">
                <GitCommit className="size-3" aria-hidden="true" />
                <span>{cp.sha.slice(0, 10)}</span>
                <span className="font-sans text-fg">— {cp.message}</span>
              </div>
              <pre className="mt-1 overflow-x-auto font-mono text-[10px] text-muted">
                {`diff --git a/workspace b/workspace\n--- a/checkpoint/${cp.sha.slice(0, 7)}~1\n+++ b/checkpoint/${cp.sha.slice(0, 7)}`}
              </pre>
            </div>
          ))}
        </div>
      )}

      {/* 5. Sandbox Policy Viewer */}
      {activeTab === "policy" && (
        <div className="rounded border border-border bg-bg p-2">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-fg">
            <Shield className="size-3.5 text-accent" aria-hidden="true" />
            <span>Compiled Sandbox Policy (Immutable)</span>
          </div>
          <pre className="max-h-40 overflow-x-auto font-mono text-[10px] text-muted">
            {JSON.stringify(
              session?.sandboxPolicy ?? {
                filesystem: {
                  allowWrite: ["/workspace", "/tmp", "/memories"],
                  denyRead: ["~/.ssh", "~/.aws", "~/.config/gcloud", "/oh/policy.json"],
                  mandatoryDeny: [".git/hooks/**", ".env*", ".openharness/agents/**"],
                },
                network: {
                  mode: "allowlist",
                  methods: ["GET", "HEAD"],
                  deniedResolvedAddresses: ["169.254.169.254/32", "10.0.0.0/8", "192.168.0.0/16"],
                },
              },
              null,
              2
            )}
          </pre>
        </div>
      )}
    </div>
  );
}
