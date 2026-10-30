import type { Message } from "@openharness/sdk";
import { LayeredContextManager, OVERFLOW_SHRINK_RATIOS } from "./manager.ts";
export { LayeredContextManager, OVERFLOW_SHRINK_RATIOS };

export function shouldTriggerCompaction(estimatedTokens: number, contextWindow: number): boolean {
  const mgr = new LayeredContextManager({ contextWindow });
  return estimatedTokens >= mgr.getTriggerTokens(contextWindow);
}

export function estimateTranscriptSize(systemPrompt: string, messages: Message[]): number {
  return new LayeredContextManager().estimateTranscriptTokens(systemPrompt, messages);
}
