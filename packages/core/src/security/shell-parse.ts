import { splitShellSubcommands, classifyToolCallRisk } from "./risk.ts";
export { splitShellSubcommands, classifyToolCallRisk };

export function containsHighRiskShellSubcommand(command: string): boolean {
  return classifyToolCallRisk("bash", { command }).risk === "high";
}
