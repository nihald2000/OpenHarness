export interface DecodedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  repaired: boolean;
  fromTextFallback: boolean;
  validationError?: string;
}

/**
 * Synthesizes stable IDs (`call_<runId>_<n>`) for calls without one (§4 B.2).
 */
export function synthesizeToolCallId(runId: string, index: number, existingId?: string): string {
  if (existingId && typeof existingId === "string" && existingId.trim().length > 0) {
    return existingId.trim();
  }
  return `call_${runId}_${index}`;
}

/**
 * Repairs malformed JSON tool arguments emitted by Llama, Ollama, and OSS models (§4 B.2):
 * - Strips markdown code fences
 * - Unwraps double-encoded JSON strings
 * - Replaces Python literals (`True`, `False`, `None`) outside quotes
 * - Converts single-quoted keys/strings to double-quoted JSON
 * - Escapes raw unescaped newlines inside string values
 * - Strips trailing commas before `}` or `]`
 */
export function repairToolArgumentsJson(raw: unknown): {
  parsed: Record<string, unknown>;
  repaired: boolean;
  error?: string;
} {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return { parsed: raw as Record<string, unknown>, repaired: false };
  }
  if (typeof raw !== "string") {
    return { parsed: {}, repaired: false };
  }

  let text = raw.trim();
  if (!text) {
    return { parsed: {}, repaired: false };
  }

  // Try direct parse first
  try {
    const direct = JSON.parse(text);
    if (typeof direct === "string") {
      // Double-encoded JSON string
      const inner = JSON.parse(direct);
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        return { parsed: inner as Record<string, unknown>, repaired: true };
      }
    }
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return { parsed: direct as Record<string, unknown>, repaired: false };
    }
  } catch {
    // Proceed to repair pipeline
  }

  let candidate = text;

  // 1. Strip markdown code fences ```json ... ```
  candidate = candidate.replace(/^```(?:json|javascript|python)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // 2. Replace Python literals True / False / None outside strings
  candidate = replaceOutsideStrings(candidate, (seg) =>
    seg
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/\bNone\b/g, "null")
  );

  // 3. Convert single-quoted strings to double-quoted strings if needed
  candidate = normalizeSingleQuotesAndNewlines(candidate);

  // 4. Strip trailing commas before `}` or `]`
  candidate = candidate.replace(/,\s*([}\]])/g, "$1");

  try {
    const repairedObj = JSON.parse(candidate);
    if (typeof repairedObj === "string") {
      const inner = JSON.parse(repairedObj);
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        return { parsed: inner as Record<string, unknown>, repaired: true };
      }
    }
    if (repairedObj && typeof repairedObj === "object" && !Array.isArray(repairedObj)) {
      return { parsed: repairedObj as Record<string, unknown>, repaired: true };
    }
    return { parsed: { value: repairedObj }, repaired: true };
  } catch (err) {
    return {
      parsed: { _raw: raw },
      repaired: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function replaceOutsideStrings(input: string, fn: (seg: string) => string): string {
  let out = "";
  let last = 0;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"' || ch === "'") {
      out += fn(input.slice(last, i));
      const quote = ch;
      let j = i + 1;
      while (j < input.length) {
        if (input[j] === "\\") {
          j += 2;
          continue;
        }
        if (input[j] === quote) {
          j += 1;
          break;
        }
        j++;
      }
      out += input.slice(i, j);
      i = j;
      last = i;
    } else {
      i++;
    }
  }
  out += fn(input.slice(last));
  return out;
}

function normalizeSingleQuotesAndNewlines(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"') {
      out += '"';
      i++;
      while (i < input.length) {
        if (input[i] === "\\") {
          out += input.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (input[i] === "\n") {
          out += "\\n";
          i++;
          continue;
        }
        if (input[i] === "\r") {
          out += "\\r";
          i++;
          continue;
        }
        if (input[i] === '"') {
          out += '"';
          i++;
          break;
        }
        out += input[i];
        i++;
      }
      continue;
    }
    if (ch === "'") {
      out += '"';
      i++;
      while (i < input.length) {
        if (input[i] === "\\") {
          const next = input[i + 1];
          if (next === "'") {
            out += "'";
          } else {
            out += input.slice(i, i + 2);
          }
          i += 2;
          continue;
        }
        if (input[i] === '"') {
          out += '\\"';
          i++;
          continue;
        }
        if (input[i] === "\n") {
          out += "\\n";
          i++;
          continue;
        }
        if (input[i] === "'") {
          out += '"';
          i++;
          break;
        }
        out += input[i];
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Fallback text parser for tool calls emitted in plain text (§4 B.2):
 * Recognizes:
 * 1. Llama pythonic lists: `[fn(a=1, b="x"), other(k=True)]`
 * 2. `<function=name>{json}</function>`
 * 3. `<tool_call>{json}</tool_call>` (Hermes/Qwen)
 * 4. JSON blocks `{"name": "...", "arguments"|"parameters": ...}` (fenced or bare)
 * Only matches tool names in `advertisedToolNames`.
 */
export function parseTextToolCalls(
  text: string,
  advertisedToolNames: string[],
  runId: string,
  startIndex = 1
): DecodedToolCall[] {
  const allowed = new Set(advertisedToolNames);
  const calls: DecodedToolCall[] = [];
  let nextIdx = startIndex;

  if (!text || allowed.size === 0) return calls;

  // 1. `<function=name>{...}</function>`
  const fnTagRegex = /<function=([A-Za-z0-9_.-]+)\s*>([\s\S]*?)<\/function>/g;
  let match: RegExpExecArray | null;
  while ((match = fnTagRegex.exec(text)) !== null) {
    const name = match[1]!;
    if (allowed.has(name)) {
      const repaired = repairToolArgumentsJson(match[2]!);
      calls.push({
        id: synthesizeToolCallId(runId, nextIdx++),
        name,
        arguments: repaired.parsed,
        repaired: repaired.repaired,
        fromTextFallback: true,
        validationError: repaired.error,
      });
    }
  }
  if (calls.length > 0) return calls;

  // 2. `<tool_call>{...}</tool_call>`
  const toolCallTagRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  while ((match = toolCallTagRegex.exec(text)) !== null) {
    const repaired = repairToolArgumentsJson(match[1]!);
    const name = typeof repaired.parsed.name === "string" ? repaired.parsed.name : "";
    if (allowed.has(name)) {
      const rawArgs = repaired.parsed.arguments ?? repaired.parsed.parameters ?? {};
      const argsRepaired = repairToolArgumentsJson(rawArgs);
      calls.push({
        id: synthesizeToolCallId(runId, nextIdx++),
        name,
        arguments: argsRepaired.parsed,
        repaired: true,
        fromTextFallback: true,
        validationError: argsRepaired.error,
      });
    }
  }
  if (calls.length > 0) return calls;

  // 3. Llama pythonic list: `[fn(a=1, b="x")]`
  const pythonicListRegex = /\[\s*([A-Za-z0-9_.-]+\s*\([\s\S]*?\))\s*\]/g;
  while ((match = pythonicListRegex.exec(text)) !== null) {
    const parsedCalls = parsePythonicCallList(match[1]!, allowed, runId, nextIdx);
    if (parsedCalls.length > 0) {
      calls.push(...parsedCalls);
      nextIdx += parsedCalls.length;
    }
  }
  if (calls.length > 0) return calls;

  // 4. Fenced or bare JSON object `{"name": "...", "arguments"|"parameters": ...}`
  const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/g;
  while ((match = fencedRegex.exec(text)) !== null) {
    const repaired = repairToolArgumentsJson(match[1]!);
    const name = typeof repaired.parsed.name === "string" ? repaired.parsed.name : "";
    if (allowed.has(name)) {
      const rawArgs = repaired.parsed.arguments ?? repaired.parsed.parameters ?? {};
      const argsRepaired = repairToolArgumentsJson(rawArgs);
      calls.push({
        id: synthesizeToolCallId(runId, nextIdx++),
        name,
        arguments: argsRepaired.parsed,
        repaired: true,
        fromTextFallback: true,
      });
    }
  }
  if (calls.length > 0) return calls;

  const bareJsonMatch = text.match(new RegExp("\\{\\s*[\"']name[\"']\\s*:\\s*[\"']([A-Za-z0-9_.-]+)[\"'][\\s\\S]*\\}"));
  if (bareJsonMatch && allowed.has(bareJsonMatch[1]!)) {
    const repaired = repairToolArgumentsJson(bareJsonMatch[0]);
    const name = typeof repaired.parsed.name === "string" ? repaired.parsed.name : "";
    if (allowed.has(name)) {
      const rawArgs = repaired.parsed.arguments ?? repaired.parsed.parameters ?? {};
      const argsRepaired = repairToolArgumentsJson(rawArgs);
      calls.push({
        id: synthesizeToolCallId(runId, nextIdx++),
        name,
        arguments: argsRepaired.parsed,
        repaired: true,
        fromTextFallback: true,
      });
    }
  }

  return calls;
}

function parsePythonicCallList(
  inner: string,
  allowed: Set<string>,
  runId: string,
  startIdx: number
): DecodedToolCall[] {
  const results: DecodedToolCall[] = [];
  const callPattern = /([A-Za-z0-9_.-]+)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  let idx = startIdx;

  while ((m = callPattern.exec(inner)) !== null) {
    const fnName = m[1]!;
    if (!allowed.has(fnName)) continue;
    const argsStr = m[2]!.trim();
    const argsObj: Record<string, unknown> = {};
    if (argsStr) {
      // Split key=value pairs outside quotes
      const pairs = splitCommaOutsideQuotes(argsStr);
      for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx === -1) continue;
        const key = pair.slice(0, eqIdx).trim();
        const valRaw = pair.slice(eqIdx + 1).trim();
        argsObj[key] = parsePythonicValue(valRaw);
      }
    }
    results.push({
      id: synthesizeToolCallId(runId, idx++),
      name: fnName,
      arguments: argsObj,
      repaired: true,
      fromTextFallback: true,
    });
  }
  return results;
}

function splitCommaOutsideQuotes(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  let depth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuote) {
      current += ch;
      if (ch === "\\" && i + 1 < input.length) {
        current += input[++i]!;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      current += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parsePythonicValue(valRaw: string): unknown {
  if (valRaw === "True" || valRaw === "true") return true;
  if (valRaw === "False" || valRaw === "false") return false;
  if (valRaw === "None" || valRaw === "null") return null;
  if (/^-?\d+$/.test(valRaw)) return Number.parseInt(valRaw, 10);
  if (/^-?\d+\.\d+$/.test(valRaw)) return Number.parseFloat(valRaw);
  const repaired = repairToolArgumentsJson(valRaw);
  if (!repaired.error && Object.keys(repaired.parsed).length > 0 && !("_raw" in repaired.parsed)) {
    if ("value" in repaired.parsed && Object.keys(repaired.parsed).length === 1) {
      return repaired.parsed.value;
    }
    return repaired.parsed;
  }
  if (
    (valRaw.startsWith('"') && valRaw.endsWith('"')) ||
    (valRaw.startsWith("'") && valRaw.endsWith("'"))
  ) {
    return valRaw.slice(1, -1);
  }
  return valRaw;
}

/**
 * Validates decoded arguments against a tool's JSON Schema (§4 B.2).
 * On failure, returns a rich error message containing the expected schema so the model can retry.
 */
export function validateToolArgumentsAgainstSchema(
  args: Record<string, unknown>,
  schema: Record<string, unknown>
): { valid: boolean; error?: string } {
  if (!schema || typeof schema !== "object") {
    return { valid: true };
  }
  if ("_raw" in args && Object.keys(args).length === 1) {
    return {
      valid: false,
      error: `Invalid JSON arguments: could not parse "${String(args._raw).slice(0, 200)}". Expected schema: ${JSON.stringify(schema)}`,
    };
  }

  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const reqKey of required) {
    if (!(reqKey in args) || args[reqKey] === undefined) {
      return {
        valid: false,
        error: `Missing required parameter "${reqKey}". Expected schema: ${JSON.stringify(schema)}`,
      };
    }
  }

  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};

  for (const [key, propSchema] of Object.entries(properties)) {
    if (!(key in args) || args[key] === undefined || args[key] === null) continue;
    const val = args[key];
    const expectedType = propSchema.type;
    if (typeof expectedType === "string") {
      if (expectedType === "string" && typeof val !== "string") {
        return {
          valid: false,
          error: `Parameter "${key}" must be of type string, got ${typeof val}. Expected schema: ${JSON.stringify(schema)}`,
        };
      }
      if ((expectedType === "number" || expectedType === "integer") && typeof val !== "number") {
        return {
          valid: false,
          error: `Parameter "${key}" must be of type ${expectedType}, got ${typeof val}. Expected schema: ${JSON.stringify(schema)}`,
        };
      }
      if (expectedType === "boolean" && typeof val !== "boolean") {
        return {
          valid: false,
          error: `Parameter "${key}" must be of type boolean, got ${typeof val}. Expected schema: ${JSON.stringify(schema)}`,
        };
      }
      if (expectedType === "array" && !Array.isArray(val)) {
        return {
          valid: false,
          error: `Parameter "${key}" must be an array. Expected schema: ${JSON.stringify(schema)}`,
        };
      }
      if (expectedType === "object" && (typeof val !== "object" || Array.isArray(val))) {
        return {
          valid: false,
          error: `Parameter "${key}" must be an object. Expected schema: ${JSON.stringify(schema)}`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Renders tool definitions into the system prompt with a strict, example-driven format for `text` models (§4 B.2).
 */
export function renderToolsForTextModelPrompt(
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
): string {
  const lines: string[] = [
    "## Tool Calling Format",
    "When you need to invoke a tool, emit a `<tool_call>` block with valid JSON:",
    "```xml",
    '<tool_call>{"name": "read_file", "arguments": {"path": "README.md"}}</tool_call>',
    "```",
    "Available tools:",
  ];
  for (const t of tools) {
    lines.push(`- **${t.name}**: ${t.description}`);
    lines.push(`  Schema: \`${JSON.stringify(t.parameters)}\``);
  }
  return lines.join("\n");
}
