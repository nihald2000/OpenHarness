import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_PROMPT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_PROMPT_ATTACHMENTS = 100;
const MAX_SESSION_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface StoredAttachmentInfo {
  id: string;
  groupId: string;
  name: string;
  relativePath: string;
  workspacePath: string;
  mimeType: string;
  size: number;
}

interface AttachmentRecord extends StoredAttachmentInfo {
  tenantId: string;
  sessionId: string;
}

function safeRelativePath(input: string): string {
  const normalized = input.replace(/\\/g, "/").normalize("NFC");
  if (
    !normalized ||
    normalized.length > 1024 ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes("\0")
  ) {
    throw new Error("Invalid attachment path");
  }
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) =>
      segment === "." ||
      segment === ".." ||
      segment.length > 255 ||
      /[<>:"|?*\x00-\x1f]/.test(segment) ||
      /[. ]$/.test(segment) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(segment)
    )
  ) {
    throw new Error("Invalid attachment path");
  }
  if (segments.some((segment) =>
    /^(?:\.env(?:\..*)?|\.git|\.openharness|\.ssh|\.aws|\.npmrc|\.pypirc|credentials(?:\..*)?)$/i.test(segment)
  )) {
    throw new Error("Protected configuration and credential files cannot be attached");
  }
  return segments.join("/");
}

function scopeKey(tenantId: string, sessionId: string): string {
  return crypto.createHash("sha256").update(`${tenantId}\0${sessionId}`).digest("hex");
}

export class AttachmentStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "attachments");
    fs.mkdirSync(this.root, { recursive: true });
  }

  save(input: {
    tenantId: string;
    sessionId: string;
    groupId: string;
    relativePath: string;
    mimeType: string;
    data: Buffer;
  }): StoredAttachmentInfo {
    if (input.data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Files must be ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB or smaller`);
    }
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.groupId)) {
      throw new Error("Invalid attachment group");
    }
    const relativePath = safeRelativePath(input.relativePath);
    const id = crypto.randomUUID();
    const name = relativePath.split("/").at(-1)!;
    const workspacePath = `attachments/${input.groupId}/${relativePath}`;
    const info: StoredAttachmentInfo = {
      id,
      groupId: input.groupId,
      name,
      relativePath,
      workspacePath,
      mimeType: input.mimeType.slice(0, 255) || "application/octet-stream",
      size: input.data.byteLength,
    };
    const dir = path.join(this.root, scopeKey(input.tenantId, input.sessionId));
    fs.mkdirSync(dir, { recursive: true });
    const existingRecords = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
    const existingBytes = existingRecords.reduce((sum, file) => {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { size?: number };
        return sum + (Number(rec.size) || 0);
      } catch {
        return sum;
      }
    }, 0);
    if (existingRecords.length >= 500 || existingBytes + input.data.byteLength > MAX_SESSION_ATTACHMENT_BYTES) {
      throw new Error("This chat has reached its 100 MB attachment storage limit");
    }
    const record: AttachmentRecord = {
      ...info,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
    };
    fs.writeFileSync(path.join(dir, `${id}.bin`), input.data, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record), {
      mode: 0o600,
      flag: "wx",
    });
    return info;
  }

  get(tenantId: string, sessionId: string, id: string): {
    info: StoredAttachmentInfo;
    data: Buffer;
  } | null {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const dir = path.join(this.root, scopeKey(tenantId, sessionId));
    try {
      const record = JSON.parse(
        fs.readFileSync(path.join(dir, `${id}.json`), "utf8")
      ) as AttachmentRecord;
      if (record.tenantId !== tenantId || record.sessionId !== sessionId || record.id !== id) {
        return null;
      }
      const { tenantId: _tenant, sessionId: _session, ...info } = record;
      return { info, data: fs.readFileSync(path.join(dir, `${id}.bin`)) };
    } catch {
      return null;
    }
  }

  removeSession(tenantId: string, sessionId: string): void {
    fs.rmSync(path.join(this.root, scopeKey(tenantId, sessionId)), {
      recursive: true,
      force: true,
    });
  }

  removeAttachment(tenantId: string, sessionId: string, id: string): void {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return;
    const dir = path.join(this.root, scopeKey(tenantId, sessionId));
    fs.rmSync(path.join(dir, `${id}.bin`), { force: true });
    fs.rmSync(path.join(dir, `${id}.json`), { force: true });
  }

  copyAttachment(
    tenantId: string,
    fromSessionId: string,
    toSessionId: string,
    id: string
  ): StoredAttachmentInfo | null {
    const existing = this.get(tenantId, fromSessionId, id);
    if (!existing) return null;
    return this.save({
      tenantId,
      sessionId: toSessionId,
      groupId: existing.info.groupId,
      relativePath: existing.info.relativePath,
      mimeType: existing.info.mimeType,
      data: existing.data,
    });
  }
}

export function isTextAttachment(mimeType: string, name: string): boolean {
  if (mimeType.startsWith("text/")) return true;
  return /\.(?:txt|md|markdown|rst|csv|tsv|json|jsonc|jsonl|xml|html?|css|scss|less|ya?ml|toml|ini|conf|log|sql|sh|bash|zsh|ps1|bat|cmd|c|h|cc|cpp|hpp|cs|go|rs|java|kt|swift|rb|php|pyi?|ipynb|js|jsx|mjs|cjs|ts|tsx|vue|svelte|astro|graphql|proto|dockerfile|makefile)$/i.test(
    name
  );
}
