import { LayeredContextManager, OVERFLOW_SHRINK_RATIOS } from "./manager.ts";
export { LayeredContextManager, OVERFLOW_SHRINK_RATIOS };

export function computeShrinkTargetTokens(contextWindow: number, attempt: number): number {
  const ratio = OVERFLOW_SHRINK_RATIOS[Math.min(attempt, OVERFLOW_SHRINK_RATIOS.length - 1)] ?? 0.35;
  return Math.floor(contextWindow * ratio);
}
