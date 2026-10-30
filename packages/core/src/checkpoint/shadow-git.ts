import type { CheckpointInfo } from "@openharness/sdk";
export { SessionCheckpointManager } from "../checkpoints/index.ts";

export function isValidShadowGitSha(sha: string): boolean {
  return typeof sha === "string" && sha.trim().length >= 7;
}

export function formatCheckpointSummary(cp: CheckpointInfo): string {
  const files = cp.files ?? cp.paths ?? [];
  return `[${cp.sha.slice(0, 8)}] ${cp.message} (${files.length} files)`;
}
