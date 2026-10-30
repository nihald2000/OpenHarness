import { LayeredContextManager } from "./manager.ts";
export function clearOldToolResults(messages: any[], workspaceRoot?: string, clearAfterTurns = 6) {
  return new LayeredContextManager({ clearAfterTurns, workspaceRoot }).clearOldToolResults(messages, workspaceRoot);
}
