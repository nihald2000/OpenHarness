import type { ModalApi } from "./modal-api.ts";
import type { SandboxRecord, SandboxRecordStore } from "./records.ts";

/** Call at every step boundary; rolls a sandbox over before Modal's 24 h hard limit. */
export const needsRollover = (
  r: SandboxRecord,
  marginMs = 30 * 60_000,
  now = Date.now()
): boolean => now > r.createdAt + r.timeoutMs - marginMs;

/** Every 5 minutes: terminate Modal sandboxes tagged oh:1 that no active/paused run owns. */
export async function reapOrphans(
  api: ModalApi,
  records: SandboxRecordStore,
  isAlive: (runId: string) => Promise<boolean>,
  now = Date.now()
): Promise<string[]> {
  const terminated: string[] = [];
  for await (const sb of api.list({ oh: "1" })) {
    const rec = await records.findModalId(sb.id);
    if (!rec) {
      await sb.terminate().catch(() => {});
      terminated.push(sb.id);
      continue;
    }
    const owned = rec.status === "running" && (await isAlive(rec.runId));
    const setupExpired = rec.status === "setup" && now - rec.createdAt > 60 * 60_000;
    const setupActive = rec.status === "setup" && !setupExpired && (await isAlive(rec.runId));
    if (!owned && !setupActive) {
      await sb.terminate().catch(() => {});
      await records.update(rec.handleId, { status: "terminated" });
      terminated.push(sb.id);
    }
  }
  return terminated;
}

/** Compute cost so far; add to RunState.cost each step so maxCostPerRun/task include sandbox time. */
export function accumulateSandboxCost(
  r: SandboxRecord,
  now = Date.now(),
  price = { cpuCoreSecondUsd: 0.00003942, memoryMiBSecondUsd: 0.00000667 }
): { usd: number; billedUntil: number } {
  const seconds = Math.max(0, (now - r.billedUntil) / 1000);
  return {
    usd:
      seconds *
      (r.cpu * price.cpuCoreSecondUsd +
        (r.memoryMiB / 1024) * price.memoryMiBSecondUsd),
    billedUntil: now,
  };
}
