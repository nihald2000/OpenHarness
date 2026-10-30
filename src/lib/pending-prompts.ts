export interface PendingPrompt {
  text: string;
  agent?: string;
  fix?: { commands: string[] };
}

const map = new Map<string, PendingPrompt>();

export function setPendingPrompt(id: string, prompt: PendingPrompt): void {
  map.set(id, prompt);
}

export function takePendingPrompt(id: string): PendingPrompt | undefined {
  const item = map.get(id);
  if (item) {
    map.delete(id);
  }
  return item;
}
