import { LayeredContextManager } from "./manager.ts";
export { LayeredContextManager };

export function shouldPrecomputeCompaction(
  estimatedTokens: number,
  contextWindow: number,
  ratio = 0.85
): boolean {
  const mgr = new LayeredContextManager({ contextWindow });
  return estimatedTokens >= Math.floor(mgr.getTriggerTokens(contextWindow) * ratio);
}
