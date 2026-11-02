import type { AttachmentPart, Message, ToolPart } from "@openharness/sdk";
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

const imageAttachments = (m: Message): AttachmentPart[] =>
  m.parts.filter(
    (p): p is AttachmentPart =>
      p.type === "attachment" &&
      Boolean(p.dataBase64) &&
      ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(p.mimeType.toLowerCase())
  );

const pdfAttachments = (m: Message): AttachmentPart[] =>
  m.parts.filter(
    (p): p is AttachmentPart =>
      p.type === "attachment" &&
      Boolean(p.dataBase64) &&
      p.mimeType.toLowerCase() === "application/pdf"
  );

const toolOf = (m: Message) => m.parts.filter((p): p is ToolPart => p.type === "tool");

const inputOf = (t: ToolPart) =>
  t.input && typeof t.input === "object" && !Array.isArray(t.input) ? t.input : {};

/* History -> provider messages. Every tool call is followed by its result, as the APIs require. */
export function toWireMessages(messages: Message[], profile: ModelProfile): Wire[] {
  if (profile.wire === "anthropic") return mergeSameRole(messages.flatMap((message) => anthropicMessages(message, profile)));
  if (profile.toolCalling === "text") return messages.flatMap(textModeMessages);
  return messages.flatMap((message) => openAIMessages(message, profile));
}

function extractVisionToolImages(t: ToolPart, supportsVision = false): { sanitizedText: string; images: Array<{ label: string; mimeType: string; dataBase64: string }> } {
  const out = t.output && typeof t.output === "object" && !Array.isArray(t.output) ? t.output as Record<string, unknown> : undefined;
  if (!out || t.state !== "completed") return { sanitizedText: toolResultText(t), images: [] };
  if (t.tool === "browser_screenshot" && typeof out.dataBase64 === "string") {
    const sanitizedText = JSON.stringify({ url: out.url, title: out.title, mimeType: out.mimeType, screenshotAttached: Boolean(supportsVision) });
    return { sanitizedText, images: supportsVision && out.mimeType === "image/png" ? [{ label: `Visual screenshot captured from ${String(out.url ?? "browser")}`, mimeType: "image/png", dataBase64: out.dataBase64 }] : [] };
  }
  if (t.tool === "render_document_preview" && Array.isArray(out.pages)) {
    const pages = out.pages.filter((page): page is Record<string, unknown> => Boolean(page && typeof page === "object" && !Array.isArray(page)));
    const images = supportsVision ? pages.slice(0, 4).filter((page) => typeof page.dataBase64 === "string" && typeof page.mimeType === "string").map((page) => ({ label: `Document preview page ${page.page ?? ""}`, mimeType: String(page.mimeType), dataBase64: String(page.dataBase64) })) : [];
    const sanitized = { ...out, pages: pages.map(({ page, mimeType }) => ({ page, mimeType, ...(supportsVision ? { attachedToVision: true } : {}) })) };
    return { sanitizedText: JSON.stringify(sanitized), images };
  }
  return { sanitizedText: toolResultText(t), images: [] };
}

export function supportsVisionModel(modelOrWire: string): boolean {
  const value = modelOrWire.toLowerCase();
  return value === "anthropic" || /muse-(?:glimmer|spark|wonder)|gpt-4o|gpt-4\.1|gpt-5|gpt-6|claude-|gemini-/.test(value);
}

function openAIMessages(m: Message, profile?: ModelProfile): Wire[] {
  const text = textOf(m);
  const tools = toolOf(m);
  const images = imageAttachments(m);
  if (m.info.role !== "assistant" || tools.length === 0) {
    if (images.length === 0) return [{ role: m.info.role, content: text }];
    return [{
      role: m.info.role,
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...images.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` },
        })),
      ],
    }];
  }
  const calls = tools.map((t, idx) => ({
    id: synthesizeToolCallId(m.info.id, idx, t.callId),
    type: "function",
    function: {
      name: t.tool,
      arguments: JSON.stringify(inputOf(t)),
    },
  }));
  const toolMessages = tools.map((t, idx) => {
    const extracted = extractVisionToolImages(t, Boolean(profile?.supportsVision));
    const validImages = extracted.images.filter((image) => image.dataBase64.length > 200);
    return {
      message: { role: "tool", tool_call_id: calls[idx]!.id, content: extracted.sanitizedText },
      images: validImages,
    };
  });
  return [
    { role: "assistant", content: text || null, tool_calls: calls },
    ...toolMessages.map((item) => item.message),
    ...toolMessages.flatMap((item) => item.images).map((out) => ({
      role: "user",
      content: [
        { type: "text", text: `[${out.label}]` },
        { type: "image_url", image_url: { url: `data:${out.mimeType};base64,${out.dataBase64}` } },
      ],
    })),
  ];
}

function anthropicMessages(m: Message, profile?: ModelProfile): Wire[] {
  const text = textOf(m);
  const tools = toolOf(m);
  const images = imageAttachments(m);
  const pdfs = pdfAttachments(m);
  if (m.info.role !== "assistant" || tools.length === 0) {
    if (!text && images.length === 0 && pdfs.length === 0) return [];
    return [{
      role: m.info.role,
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...images.map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType,
            data: image.dataBase64,
          },
        })),
        ...pdfs.map((pdf) => ({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: pdf.dataBase64,
          },
        })),
      ],
    }];
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
  const resultBlocks: Wire[] = tools.map((t, idx) => {
    const extracted = extractVisionToolImages(t, Boolean(profile?.supportsVision));
    return {
      type: "tool_result",
      tool_use_id: ids[idx]!,
      content: [
        { type: "text", text: extracted.sanitizedText },
        ...extracted.images.slice(0, 4).map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.dataBase64 } })),
      ],
      ...(t.state !== "completed" ? { is_error: true } : {}),
    };
  });
  return [
    { role: "assistant", content: assistantBlocks },
    { role: "user", content: resultBlocks },
  ];
}

function textModeMessages(m: Message): Wire[] {
  const text = textOf(m);
  const tools = toolOf(m);
  const images = imageAttachments(m);
  if (m.info.role !== "assistant" || tools.length === 0) {
    if (images.length === 0) return [{ role: m.info.role, content: text }];
    return [{
      role: m.info.role,
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...images.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` },
        })),
      ],
    }];
  }
  const callLines = tools
    .map((t) => `<tool_call>${JSON.stringify({ name: t.tool, arguments: inputOf(t) })}</tool_call>`)
    .join("\n");
  const resultLines = tools
    .map((t) => `<tool_result name="${t.tool}">${extractVisionToolImages(t, false).sanitizedText}</tool_result>`)
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
