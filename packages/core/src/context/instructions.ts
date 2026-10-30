import fs from "node:fs";
import path from "node:path";
export { LayeredContextManager } from "./manager.ts";

export function loadAgentsMdFile(dirPath: string, maxBytes = 32_768): string | null {
  const candidate = path.join(dirPath, "AGENTS.md");
  if (!fs.existsSync(candidate)) return null;
  return fs.readFileSync(candidate, "utf8").slice(0, maxBytes);
}
