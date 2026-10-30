import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SecretItem } from "@openharness/sdk";

interface StoredCiphertextRecord {
  iv: string;
  tag: string;
  ciphertext: string;
  updatedAt: number;
}

/**
 * AES-256-GCM authenticated encrypted secret store (§0.1 Secrets).
 * Write-only plaintext; masked in every read, log, and event.
 */
export class EncryptedSecretStore {
  private key: Buffer;
  private filePath: string | null;
  private records: Record<string, StoredCiphertextRecord> = {};

  constructor(opts?: { dataDir?: string; masterKey?: string }) {
    const rawKey = opts?.masterKey || process.env.OPENHARNESS_SECRET_KEY || "openharness-default-local-dev-key-32b";
    this.key = crypto.createHash("sha256").update(rawKey).digest();

    if (opts?.dataDir) {
      fs.mkdirSync(opts.dataDir, { recursive: true });
      this.filePath = path.join(opts.dataDir, "secrets.json");
      this.loadFromDisk();
    } else {
      this.filePath = null;
    }
  }

  private loadFromDisk(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      this.records = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<
        string,
        StoredCiphertextRecord
      >;
    } catch {
      this.records = {};
    }
  }

  private saveToDisk(): void {
    if (!this.filePath) return;
    fs.writeFileSync(this.filePath, JSON.stringify(this.records, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  set(name: string, plaintext: string): void {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.records[name] = {
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: encrypted.toString("base64"),
      updatedAt: Date.now(),
    };
    this.saveToDisk();
  }

  getDecrypted(name: string): string | null {
    const rec = this.records[name];
    if (!rec) return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(rec.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(rec.tag, "base64"));
    const out = Buffer.concat([
      decipher.update(Buffer.from(rec.ciphertext, "base64")),
      decipher.final(),
    ]);
    return out.toString("utf8");
  }

  delete(name: string): boolean {
    if (!(name in this.records)) return false;
    delete this.records[name];
    this.saveToDisk();
    return true;
  }

  listMetadata(): SecretItem[] {
    return Object.entries(this.records).map(([name, rec]) => ({
      name,
      updatedAt: rec.updatedAt,
    }));
  }

  listAllDecryptedValues(): string[] {
    const values: string[] = [];
    for (const name of Object.keys(this.records)) {
      const val = this.getDecrypted(name);
      if (val) values.push(val);
    }
    return values;
  }
}
