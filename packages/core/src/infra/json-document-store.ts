import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Minimal local persistence port for legacy JSON documents during migration. */
export interface LocalDocumentStore<T> {
  load(): Promise<T>;
  save(value: T): Promise<void>;
}

/** Atomic JSON-file adapter used only by the single-process local deployment. */
export class JsonDocumentStore<T> implements LocalDocumentStore<T> {
  constructor(
    private readonly file: string,
    private readonly fallback: T,
    private readonly normalize: (value: unknown) => T = (value) => value as T,
  ) {}

  async load(): Promise<T> {
    try {
      return this.normalize(JSON.parse(await readFile(this.file, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(this.fallback);
      throw error;
    }
  }

  async save(value: T): Promise<void> {
    const document = `${JSON.stringify(value)}\n`;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, document, { encoding: "utf8", mode: 0o600 });
    try {
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, this.file); return; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(code ?? "") || attempt >= 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        }
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
