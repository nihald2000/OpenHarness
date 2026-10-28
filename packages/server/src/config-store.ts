import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const CONFIG_SECTIONS = new Set(["model", "smallModel", "defaultAgent", "defaultRuntime", "providers", "mcp", "plugins", "codeMode", "permissions", "limits", "compaction", "verify", "guardrails", "advanced", "agents", "skills", "commands", "prompt", "hooks"]);
const SCALAR_SECTIONS = new Set(["model", "smallModel", "defaultAgent", "defaultRuntime"]);
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
type SecretRecord = { version: 1; iv: string; tag: string; ciphertext: string; updatedAt: number };

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("stored JSON must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function atomicJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

function validateConfigValue(value: unknown, depth = 0): string[] {
  if (depth > 12) throw new Error("configuration nesting exceeds 12 levels");
  const extracted: string[] = [];
  if (typeof value === "string") {
    if (/\{\s*(?:@?Env|file)\s*:/i.test(value)) throw new Error("environment and file interpolation are not accepted in web settings");
    for (const match of value.matchAll(/\{secret:([A-Z][A-Z0-9_]{0,63})\}/g)) extracted.push(match[1]!);
  } else if (Array.isArray(value)) {
    for (const item of value) extracted.push(...validateConfigValue(item, depth + 1));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("unsafe configuration key");
      extracted.push(...validateConfigValue(item, depth + 1));
    }
  } else if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("configuration numbers must be finite");
  }
  return extracted;
}

export async function getSettings(dataDir: string) {
  const file = resolve(dataDir, "config.json");
  const config = await readJson(file);
  let exists = true;
  try { await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
  return {
    config,
    effective: {
      ...config,
      model: config.model ?? process.env.OPENHARNESS_MODEL ?? (process.env.OPENHARNESS_PROVIDER && process.env.OPENHARNESS_PROVIDER !== "mock" ? "gpt-4o-mini" : "mock/demo"),
      defaultAgent: config.defaultAgent ?? "assistant",
      defaultRuntime: config.defaultRuntime ?? "local",
      providers: config.providers ?? {},
      agents: config.agents ?? {},
      skills: config.skills ?? { paths: [] },
      prompt: config.prompt ?? { includeRepositoryInstructions: false, includeSkills: true, includeCommands: true },
      compaction: config.compaction ?? { enabled: true, triggerTokens: 102_400, keepRecentMessages: 4 },
      limits: config.limits ?? { maxConcurrentRuns: 4, maxRunDurationSec: 600, maxSessionContextTokens: 128000, maxTokensPerTurn: 8192, maxToolOutputChars: 20_000, maxToolDepth: 3, maxIterations: 25, maxSubagents: 2 },
    },
    file,
    exists,
    sources: [file],
  };
}

export async function listConfiguredModels(dataDir: string) {
  const config = await readJson(resolve(dataDir, "config.json"));
  const providers = config.providers && typeof config.providers === "object" && !Array.isArray(config.providers) ? config.providers as Record<string, Record<string, unknown>> : {};
  const preferred = typeof config.model === "string" ? config.model : process.env.OPENHARNESS_MODEL ?? (process.env.OPENHARNESS_PROVIDER && process.env.OPENHARNESS_PROVIDER !== "mock" ? "gpt-4o-mini" : "mock/demo");
  const models = Object.entries(providers).flatMap(([providerId, raw]) => {
    const providerModels = raw.models && typeof raw.models === "object" && !Array.isArray(raw.models) ? raw.models as Record<string, Record<string, unknown>> : {};
    return Object.entries(providerModels).map(([modelId, model]) => {
      const id = `${providerId}/${modelId}`;
      return { id, name: typeof model.name === "string" ? model.name : modelId, provider: providerId, contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined, isDefault: preferred === id || preferred === modelId };
    });
  });
  if (models.length > 0) return models;
  const provider = process.env.OPENHARNESS_PROVIDER ?? "mock";
  return [{ id: preferred, name: provider === "mock" ? "Offline demo" : preferred, provider, contextWindow: 128000, isDefault: true }];
}

export async function runtimeProviderConfig(dataDir: string, requestedModel?: string): Promise<{ provider: string; model: string; baseUrl?: string; apiKey?: string; inputCostPerMillion?: number; outputCostPerMillion?: number }> {
  const config = await readJson(resolve(dataDir, "config.json"));
  const selected = requestedModel ?? (typeof config.model === "string" ? config.model : process.env.OPENHARNESS_MODEL) ?? (process.env.OPENHARNESS_PROVIDER === "mock" || !process.env.OPENHARNESS_PROVIDER ? "mock/demo" : "gpt-4o-mini");
  const providers = config.providers && typeof config.providers === "object" && !Array.isArray(config.providers) ? config.providers as Record<string, Record<string, unknown>> : {};
  for (const [providerId, raw] of Object.entries(providers)) {
    const modelId = selected.startsWith(`${providerId}/`) ? selected.slice(providerId.length + 1) : selected;
    const models = raw.models && typeof raw.models === "object" && !Array.isArray(raw.models) ? raw.models as Record<string, unknown> : {};
    if (!(modelId in models)) continue;
    const selectedModel = models[modelId] && typeof models[modelId] === "object" ? models[modelId] as Record<string, unknown> : {};
    const inputCostPerMillion = typeof selectedModel.inputCostPerMillion === "number" && Number.isFinite(selectedModel.inputCostPerMillion) && selectedModel.inputCostPerMillion >= 0 ? selectedModel.inputCostPerMillion : undefined;
    const outputCostPerMillion = typeof selectedModel.outputCostPerMillion === "number" && Number.isFinite(selectedModel.outputCostPerMillion) && selectedModel.outputCostPerMillion >= 0 ? selectedModel.outputCostPerMillion : undefined;
    if (raw.type !== "openai") throw new Error(`provider type "${String(raw.type)}" is not supported by this server`);
    let apiKey: string | undefined;
    if (typeof raw.apiKey === "string") {
      const secret = /^\{secret:([A-Z][A-Z0-9_]{0,63})\}$/.exec(raw.apiKey);
      if (secret) apiKey = await resolveSecret(dataDir, secret[1]!);
    }
    return { provider: "openai", model: modelId, baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : undefined, apiKey, inputCostPerMillion, outputCostPerMillion };
  }
  return { provider: process.env.OPENHARNESS_PROVIDER ?? "mock", model: selected };
}

export async function updateSettings(dataDir: string, section: string, value: unknown) {
  if (!CONFIG_SECTIONS.has(section)) throw new Error(`unknown settings section: ${section}`);
  if (value !== null && !SCALAR_SECTIONS.has(section) && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("settings value must be a JSON object or null");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 256_000) throw new Error("settings value exceeds 256 KB");
  validateConfigValue(value);
  const extractedSecrets: string[] = [];
  const normalized = await extractSecrets(dataDir, value, section.toUpperCase());
  extractedSecrets.push(...normalized.names);
  const file = resolve(dataDir, "config.json");
  const config = await readJson(file);
  if (value === null) delete config[section];
  else config[section] = normalized.value;
  await atomicJson(file, config);
  return { extractedSecrets: [...new Set(extractedSecrets)] };
}

async function extractSecrets(dataDir: string, value: unknown, prefix: string): Promise<{ value: unknown; names: string[] }> {
  if (Array.isArray(value)) {
    const entries = await Promise.all(value.map((item, index) => extractSecrets(dataDir, item, `${prefix}_${index + 1}`)));
    return { value: entries.map((entry) => entry.value), names: entries.flatMap((entry) => entry.names) };
  }
  if (!value || typeof value !== "object") return { value, names: [] };
  const result: Record<string, unknown> = {};
  const names: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && item && /auth|token|key|secret|password|credential/i.test(key) && !/^\{secret:[A-Z][A-Z0-9_]{0,63}\}$/.test(item)) {
      const suffix = key.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "VALUE";
      const secretName = `${prefix}_${suffix}`.slice(0, 64).replace(/_+$/g, "");
      if (!SECRET_NAME.test(secretName)) throw new Error(`cannot derive a valid secret name for ${key}`);
      await setSecret(dataDir, secretName, item);
      result[key] = `{secret:${secretName}}`;
      names.push(secretName);
    } else {
      const child = await extractSecrets(dataDir, item, `${prefix}_${key.toUpperCase().replace(/[^A-Z0-9_]+/g, "_")}`);
      result[key] = child.value;
      names.push(...child.names);
    }
  }
  return { value: result, names };
}

async function loadSecretKey(dataDir: string): Promise<Buffer> {
  const configured = process.env.OPENHARNESS_SECRET_KEY;
  if (configured) return createHash("sha256").update(configured).digest();
  const keyFile = resolve(dataDir, "secret.key");
  try {
    const key = await readFile(keyFile);
    if (key.length !== 32) throw new Error("local secret key has invalid length");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(keyFile), { recursive: true });
    const key = randomBytes(32);
    try { await writeFile(keyFile, key, { flag: "wx", mode: 0o600 }); return key; }
    catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      const created = await readFile(keyFile);
      if (created.length !== 32) throw new Error("local secret key has invalid length");
      return created;
    }
  }
}

export async function listSecrets(dataDir: string) {
  const records = await readJson(resolve(dataDir, "secrets.json"));
  return Object.entries(records).filter(([, record]) => record && typeof record === "object").map(([name, record]) => ({ name, updatedAt: (record as SecretRecord).updatedAt }));
}

export async function setSecret(dataDir: string, name: string, value: string) {
  if (!SECRET_NAME.test(name)) throw new Error("secret name must match ^[A-Z][A-Z0-9_]{0,63}$");
  if (!value) throw new Error("secret value is required");
  if (Buffer.byteLength(value, "utf8") > 16_000) throw new Error("secret value exceeds 16 KB");
  const key = await loadSecretKey(dataDir);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`openharness-secret-v1:${name}`));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const record: SecretRecord = { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"), updatedAt: Date.now() };
  const file = resolve(dataDir, "secrets.json");
  const records = await readJson(file);
  records[name] = record;
  await atomicJson(file, records);
}

export async function deleteSecret(dataDir: string, name: string) {
  if (!SECRET_NAME.test(name)) throw new Error("invalid secret name");
  const file = resolve(dataDir, "secrets.json");
  const records = await readJson(file);
  if (!(name in records)) return false;
  delete records[name];
  await atomicJson(file, records);
  return true;
}

export async function resolveSecret(dataDir: string, name: string): Promise<string | undefined> {
  if (!SECRET_NAME.test(name)) return undefined;
  const record = (await readJson(resolve(dataDir, "secrets.json")))[name] as SecretRecord | undefined;
  if (!record || record.version !== 1) return undefined;
  const key = await loadSecretKey(dataDir);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAAD(Buffer.from(`openharness-secret-v1:${name}`));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
