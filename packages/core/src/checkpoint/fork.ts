export { SessionCheckpointManager } from "../checkpoints/index.ts";
export type { ForkSessionOptions } from "../checkpoints/index.ts";

export function buildForkSessionTitle(parentTitle: string, customTitle?: string): string {
  if (customTitle && customTitle.trim()) return customTitle.trim();
  return `${parentTitle || "Session"} (Fork)`;
}
