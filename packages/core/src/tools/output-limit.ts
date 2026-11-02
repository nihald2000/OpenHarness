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
  limits?: { maxBytes?: number; maxLines?: number; maxChars?: number; style?: "head-tail" | "tail" }
): TruncatedToolOutput {
  const maxBytes = limits?.maxBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES;
  const maxLines = limits?.maxLines ?? DEFAULT_MAX_TOOL_OUTPUT_LINES;
  const maxChars = limits?.maxChars;

  const text =
    typeof rawOutput === "string"
      ? rawOutput
      : JSON.stringify(rawOutput, null, 2) ?? "";

  const originalBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n");
  const originalLines = lines.length;

  if (originalBytes <= maxBytes && originalLines <= maxLines && (maxChars === undefined || text.length <= maxChars)) {
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
  const charLimit = maxChars ?? maxBytes;
  const style = limits?.style ?? "head-tail";
  const headChars = style === "tail" ? 0 : maxChars ? Math.min(3000, Math.floor(charLimit / 4)) : Math.floor(maxBytes * 0.45);
  const tailChars = maxChars ? charLimit - headChars : Math.floor(maxBytes * 0.25);
  const head = style === "tail" ? "" : text.slice(0, headChars);
  const tail = text.slice(-tailChars);

  const notice = [
    `[TRUNCATED: output was ${originalLines} lines / ${originalBytes} bytes, exceeding the tool output limit]`,
    `Full output saved to: ${relSpillPath}`,
    `Use read_file or search on ${relSpillPath} for more.`,
  ].join("\n");

  return {
    output: style === "tail" ? `${notice}\n${tail}` : `${head}\n${notice}\n${tail}`,
    truncated: true,
    spillPath: relSpillPath,
    originalBytes,
    originalLines,
  };
}
