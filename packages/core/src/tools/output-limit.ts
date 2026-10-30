import fs from "node:fs";
import path from "node:path";

export const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 50 * 1024; // 50 KB
export const DEFAULT_MAX_TOOL_OUTPUT_LINES = 2000;

export interface TruncatedToolOutput {
  output: string;
  truncated: boolean;
  spillPath?: string;
  originalBytes: number;
  originalLines: number;
}

/**
 * Enforces the 50 KB / 2,000-line tool output cap (§0.2 opencode, §6 Phase D).
 * Saves oversized output under `<workspaceRoot>/.openharness/outputs/<callId>.txt`
 * and returns the head, the tail, the path, and instructions to page or grep it.
 */
export function enforceToolOutputLimit(
  rawOutput: unknown,
  callId: string,
  workspaceRoot: string,
  limits?: { maxBytes?: number; maxLines?: number }
): TruncatedToolOutput {
  const maxBytes = limits?.maxBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES;
  const maxLines = limits?.maxLines ?? DEFAULT_MAX_TOOL_OUTPUT_LINES;

  const text =
    typeof rawOutput === "string"
      ? rawOutput
      : JSON.stringify(rawOutput, null, 2) ?? "";

  const originalBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n");
  const originalLines = lines.length;

  if (originalBytes <= maxBytes && originalLines <= maxLines) {
    return {
      output: text,
      truncated: false,
      originalBytes,
      originalLines,
    };
  }

  const outDir = path.join(workspaceRoot, ".openharness", "outputs");
  fs.mkdirSync(outDir, { recursive: true });
  const safeCallId = callId.replace(/[^A-Za-z0-9_.-]/g, "_");
  const spillPath = path.join(outDir, `${safeCallId}.txt`);
  fs.writeFileSync(spillPath, text, "utf8");

  const relSpillPath = `.openharness/outputs/${safeCallId}.txt`;
  const headLinesCount = Math.min(200, Math.floor(maxLines / 4));
  const tailLinesCount = Math.min(100, Math.floor(maxLines / 8));

  const head = lines.slice(0, headLinesCount).join("\n").slice(0, Math.floor(maxBytes * 0.45));
  const tail = lines.slice(-tailLinesCount).join("\n").slice(-Math.floor(maxBytes * 0.25));

  const summary = [
    head,
    "",
    `... [TRUNCATED: output was ${originalLines} lines / ${originalBytes} bytes, exceeding limit of ${maxLines} lines / ${maxBytes} bytes] ...`,
    `Full output saved to: ${relSpillPath}`,
    `To inspect further, use \`read_file\` with {"path": "${relSpillPath}", "offset": ${headLinesCount + 1}, "limit": 200} or \`search\` (grep) on "${relSpillPath}".`,
    "",
    tail,
  ].join("\n");

  return {
    output: summary,
    truncated: true,
    spillPath: relSpillPath,
    originalBytes,
    originalLines,
  };
}
