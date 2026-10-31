import type { Message, ToolPart } from "@openharness/sdk";
import type { ModelProfile } from "./profiles.ts";
import { synthesizeToolCallId } from "./toolcall.ts";

type Wire = Record<string, unknown>;
const MAX_RESULT_CHARS = 30_000;

export function toolResultText(p: ToolPart): string {
  if (p.state === "error" || p.state === "denied") return `ERROR: ${p.error ?? p.state}`;
  if (p.state === "interrupted") return `INTERRUPTED: ${p.error ?? "the tool did not finish"}`;
  if (p.state !== "completed") return `ERROR: the tool call did not complete`;
  const s = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? null);
  return s.length > MAX_RESULT_CHARS
    ? `${s.slice(0, MAX_RESULT_CHARS)}\n[truncated ${s.length - MAX_RESULT_CHARS} chars]`
    : s;
}

const textOf = (m: Message) =>
  m.parts
    .flatMap((p) =>
      p.type === "text" ? [p.text] : p.type === "compaction" && p.summary ? [p.summary] : []
    )
    .join("\n");

const toolOf = (m: Message) => m.parts.filter((p): p is ToolPart => p.type === "tool");

const inputOf = (t: ToolPart) =>
  t.input && typeof t.input === "object" && !Array.isArray(t.input) ? t.input : {};

/* History -> provider messages. Every tool call is followed by its result, as the APIs require. */
export function toWireMessages(messages: Message[], profile: ModelProfile): Wire[] {
  if (profile.wire === "anthropic") return mergeSameRole(messages.flatMap(anthropicMessages));
  if (profile.toolCalling === "text") return messages.flatMap(textModeMessages);
  return messages.flatMap(openAIMessages);
}

function openAIMessages(m: Message): Wire[] {
  const text = textOf(m);
  const tools = toolOf(m);
  if (m.info.role !== "assistant" || tools.length === 0) {
    return [{ role: m.info.role, content: text }];
  }
  const calls = tools.map((t, idx) => ({
    id: synthesizeToolCallId(m.info.id, idx, t.callId),
    type: "function",
    function: {
      name: t.tool,
      arguments: JSON.stringify(inputOf(t)),
    },
  }));
  return [
    { role: "assistant", content: text || null, tool_calls: calls },
    ...tools.map((t, idx) => ({
      role: "tool",
      tool_call_id: calls[idx]!.id,
      content: toolResultText(t),
    })),
  ];
}

function anthropicMessages(m: Message): Wire[] {
  const text = textOf(m);
  const tools = toolOf(m);
  if (m.info.role !== "assistant" || tools.length === 0) {
    return text ? [{ role: m.info.role, content: [{ type: "text", text }] }] : [];
  }
  const assistantBlocks: Wire[] = [];
  if (text) assistantBlocks.push({ type: "text", text });
  const ids = tools.map((t, idx) => synthesizeToolCallId(m.info.id, idx, t.callId));
  tools.forEach((t, idx) => {
    assistantBlocks.push({
      type: "tool_use",
      id: ids[idx]!,
      name: t.tool,
      input: inputOf(t),
    });
  });
  const resultBlocks: Wire[] = tools.map((t, idx) => ({
    type: "tool_result",
    tool_use_id: ids[idx]!,
    content: toolResultText(t),
    ...(t.state !== "completed" ? { is_error: true } : {}),
  }));
  return [
    { role: "assistant", content: assistantBlocks },
    { role: "user", content: resultBlocks },
  ];
}

function textModeMessages(m: Message): Wire[] {
  const text = textOf(m);
  const tools = toolOf(m);
  if (m.info.role !== "assistant" || tools.length === 0) {
    return [{ role: m.info.role, content: text }];
  }
  const callLines = tools
    .map((t) => `<tool_call>${JSON.stringify({ name: t.tool, arguments: inputOf(t) })}</tool_call>`)
    .join("\n");
  const resultLines = tools
    .map((t) => `<tool_result name="${t.tool}">${toolResultText(t)}</tool_result>`)
    .join("\n");
  return [
    { role: "assistant", content: [text, callLines].filter(Boolean).join("\n") },
    { role: "user", content: resultLines },
  ];
}

export function mergeSameRole(msgs: Wire[]): Wire[] {
  const out: Wire[] = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.role === m.role &&
      Array.isArray(prev.content) &&
      Array.isArray(m.content)
    ) {
      prev.content = [...(prev.content as unknown[]), ...(m.content as unknown[])];
    } else {
      out.push({ ...m });
    }
  }
  return out;
}
