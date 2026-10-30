import type { CheckpointInfo, Message, Session } from "@openharness/sdk";
import type { StateStore } from "../agent/deps.ts";
import { getActiveSandboxDaemon } from "../sandbox/providers.ts";

export interface RewindSessionOptions {
  tenantId: string;
  sessionId: string;
  checkpoint: string; // checkpoint SHA or ID
  files?: boolean; // default true (§11 Phase I)
  filesExplicit?: boolean;
  conversation?: boolean; // default false (§11 Phase I)
  atMessageId?: string;
}

export interface ForkSessionOptions {
  tenantId: string;
  sessionId: string;
  atMessageId?: string;
  checkpoint?: string;
  newTitle?: string;
}

function createStatusError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Manages shadow-git file checkpoints, session rewind (`files: true, conversation: false` by default),
 * and session forking (`atMessageId | checkpoint`) keeping conversation sessions and file checkpoints
 * as separate orthogonal concepts (§11 Phase I).
 */
export class SessionCheckpointManager {
  private stateStore: StateStore;

  constructor(stateStore: StateStore) {
    this.stateStore = stateStore;
  }

  async listCheckpoints(tenantId: string, sessionId: string): Promise<CheckpointInfo[]> {
    return this.stateStore.listCheckpoints(tenantId, sessionId);
  }

  /**
   * Rewinds a session to a checkpoint (§11 Phase I, Step 8 S8):
   * - Validates that the checkpoint exists in `listCheckpoints` (404 if missing)
   * - Restores workspace files from the shadow-git checkpoint by default (`files: true`)
   * - If `files: true` is requested on a task/long_task or sandboxed session without an active sandbox, fails closed with 409
   * - Keeps conversation history untouched by default (`conversation: false`); when `conversation: true`,
   *   also truncates the transcript to the checkpoint's step / `atMessageId`.
   */
  async rewindSession(opts: RewindSessionOptions): Promise<{
    session: Session;
    restoredFiles: boolean;
    truncatedConversation: boolean;
    messagesCount: number;
  }> {
    const restoreFiles = opts.files ?? true;
    const truncateConversation = opts.conversation ?? false;

    const session = await this.stateStore.getSession(opts.tenantId, opts.sessionId);
    if (!session) {
      throw createStatusError(404, `Session not found: ${opts.sessionId}`);
    }

    const checkpoints = await this.stateStore.listCheckpoints(opts.tenantId, opts.sessionId);
    const targetCp = checkpoints.find((c) => c.sha === opts.checkpoint);
    if (!targetCp) {
      throw createStatusError(404, `Checkpoint not found: ${opts.checkpoint}`);
    }

    // 1. Restore files via active sandbox shadow-git if requested
    let restoredFiles = false;
    if (restoreFiles) {
      let daemon = undefined;
      if (session.runId) {
        const stepCp = await this.stateStore.getStepCheckpoint(opts.tenantId, session.runId);
        const handleId = stepCp?.sandboxHandleId;
        if (handleId) {
          daemon = getActiveSandboxDaemon(handleId);
        }
      }
      if (daemon) {
        const res = await daemon.handleRequest(
          "POST",
          "/checkpoints/restore",
          { "x-session-key": daemon.config.sessionKey },
          { sha: opts.checkpoint }
        );
        if (res.status !== 200) {
          throw createStatusError(
            409,
            `Sandbox failed to restore files for checkpoint ${opts.checkpoint}`
          );
        }
        restoredFiles = true;
      } else if (
        session.mode === "task" ||
        session.mode === "long_task" ||
        (session.runtime && session.runtime !== "local")
      ) {
        throw createStatusError(
          409,
          `Cannot restore files without an active sandbox for checkpoint ${opts.checkpoint}`
        );
      } else {
        restoredFiles = true;
      }
      session.lastCheckpoint = opts.checkpoint;
    }

    // 2. Truncate conversation ONLY if `conversation: true` was explicitly passed (§11 Phase I)
    const { messages } = await this.stateStore.getMessages(opts.tenantId, opts.sessionId);
    let finalMessages: Message[] = messages;
    let truncatedConversation = false;

    if (truncateConversation) {
      if (opts.atMessageId) {
        const idx = messages.findIndex((m) => m.info.id === opts.atMessageId);
        if (idx !== -1) {
          finalMessages = messages.slice(0, idx + 1);
          truncatedConversation = true;
        }
      } else if (typeof targetCp.step === "number") {
        finalMessages = messages.slice(0, Math.max(1, targetCp.step));
        truncatedConversation = true;
      } else if (messages.length > 1) {
        finalMessages = messages.slice(0, Math.max(1, messages.length - 1));
        truncatedConversation = true;
      }
      await this.stateStore.replaceMessages(opts.tenantId, opts.sessionId, finalMessages);
    }

    session.updatedAt = Date.now();
    await this.stateStore.saveSession(opts.tenantId, session);

    return {
      session,
      restoredFiles,
      truncatedConversation,
      messagesCount: finalMessages.length,
    };
  }

  /**
   * Forks a session at `atMessageId` or `checkpoint`, creating a new session sharing history
   * up to that point and recording the restored checkpoint (§11 Phase I).
   */
  async forkSession(opts: ForkSessionOptions): Promise<{
    session: Session;
    messages: Message[];
    checkpoint?: string;
  }> {
    const parent = await this.stateStore.getSession(opts.tenantId, opts.sessionId);
    if (!parent) {
      throw createStatusError(404, `Parent session not found: ${opts.sessionId}`);
    }

    const { messages } = await this.stateStore.getMessages(opts.tenantId, opts.sessionId);
    let slicedMessages = structuredClone(messages);

    if (opts.atMessageId) {
      const idx = slicedMessages.findIndex((m) => m.info.id === opts.atMessageId);
      if (idx !== -1) {
        slicedMessages = slicedMessages.slice(0, idx + 1);
      }
    }

    const newSessionId = `sess-fork-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const forkedSession: Session = {
      id: newSessionId,
      parentId: parent.id,
      title: opts.newTitle ?? `${parent.title} (Fork)`,
      agent: parent.agent,
      model: parent.model,
      runtime: parent.runtime,
      status: "idle",
      phase: "paused",
      mode: parent.mode,
      lastCheckpoint: opts.checkpoint ?? parent.lastCheckpoint,
      updatedAt: Date.now(),
      usage: { input: 0, output: 0 },
      cost: 0,
    };

    await this.stateStore.saveSession(opts.tenantId, forkedSession);
    await this.stateStore.replaceMessages(opts.tenantId, newSessionId, slicedMessages);

    const parentCheckpoints = await this.stateStore.listCheckpoints(opts.tenantId, opts.sessionId);
    for (const cp of parentCheckpoints) {
      await this.stateStore.saveCheckpointInfo(opts.tenantId, newSessionId, {
        ...cp,
        sessionId: newSessionId,
      });
    }

    return {
      session: forkedSession,
      messages: slicedMessages,
      checkpoint: forkedSession.lastCheckpoint,
    };
  }
}
