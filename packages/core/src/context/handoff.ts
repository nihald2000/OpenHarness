import type { FeatureItem } from "@openharness/sdk";
export { LayeredContextManager } from "./manager.ts";

export function buildFeatureHandoffBrief(
  completedFeature: FeatureItem,
  nextFeature: FeatureItem | undefined,
  checkpointSha: string | null
): string {
  return [
    `Completed feature ${completedFeature.id}: ${completedFeature.title}`,
    `Checkpoint: ${checkpointSha ?? "none"}`,
    nextFeature
      ? `Next feature: ${nextFeature.id} (${nextFeature.title})`
      : "All scheduled features processed.",
  ].join("\n");
}
