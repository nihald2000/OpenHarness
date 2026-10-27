"use client";

export interface PendingPrompt {
  text: string;
  agent?: string;
  fix?: { commands: string[] };
}

const pending = new Map<string, PendingPrompt>();

export function setPendingPrompt(sessionId: string, prompt: PendingPrompt): void {
  pending.set(sessionId, prompt);
}

export function takePendingPrompt(sessionId: string): PendingPrompt | undefined {
  const item = pending.get(sessionId);
  if (item) {
    pending.delete(sessionId);
  }
  return item;
}
