export { SessionCheckpointManager } from "../checkpoints/index.ts";
export type { RewindSessionOptions } from "../checkpoints/index.ts";

export function normalizeRewindOptions(input: {
  checkpoint: string;
  files?: boolean;
  conversation?: boolean;
  atMessageId?: string;
}) {
  return {
    checkpoint: String(input.checkpoint ?? "").trim(),
    files: input.files ?? true,
    conversation: input.conversation ?? false,
    atMessageId: input.atMessageId,
  };
}
