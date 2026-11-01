import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILT_IN_MODEL_PROFILES, resolveModelProfile } from "../packages/core/src/provider/profiles.ts";
import { loadServerConfig } from "../packages/server/src/config.ts";
import { EncryptedSecretStore } from "../packages/server/src/secrets.ts";
import { OpenHarnessServer } from "../packages/server/src/server.ts";

test("Meta Model API profile, environment defaults, secret lookup, and model catalog use Meta", async () => {
  const profile = BUILT_IN_MODEL_PROFILES["meta-muse"]!;
  assert.equal(profile.wire, "openai-chat");
  assert.equal(profile.contextWindow, 128_000);
  assert.equal(profile.maxOutputTokens, 16_384);
  assert.equal(profile.parallelToolCalls, "supported");
  assert.equal(profile.promptCaching, "none");
  assert.equal(profile.baseUrl, "https://api.meta.ai/v1");
  assert.equal(profile.apiKeyEnv, "MODEL_API_KEY");
  for (const model of [
    "muse-wonder-1.0",
    "muse-spark-1.3",
    "muse-spark-1.3-contributor",
    "sam-3.1",
    "muse-image-1.0",
  ]) {
    assert.equal(resolveModelProfile(model).apiKeyEnv, "MODEL_API_KEY", model);
    assert.equal(resolveModelProfile(model, { [model]: { baseUrl: "https://api.fireworks.ai/inference/v1" } }).baseUrl, "https://api.meta.ai/v1", model);
  }

  assert.equal(loadServerConfig({ MODEL_API_KEY: "configured" }).defaultModel, "muse-spark-1.3");
  assert.equal(loadServerConfig({ MODEL_API_KEY: "configured" }).defaultBaseUrl, "https://api.meta.ai/v1");
  assert.equal(loadServerConfig({ META_API_KEY: "configured", OPENHARNESS_MODEL: "muse-wonder-1.0" }).defaultModel, "muse-wonder-1.0");
  assert.equal(loadServerConfig({ MODEL_API_KEY: "configured", OPENHARNESS_BASE_URL: "https://meta.example/v1" }).defaultBaseUrl, "https://meta.example/v1");

  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-meta-secret-"));
  try {
    const store = new EncryptedSecretStore({ dataDir: secretDir, masterKey: "a-test-secret-store-master-key" });
    store.set("META_API_KEY", "encrypted-meta-key");
    assert.equal(store.getProviderApiKey("meta"), "encrypted-meta-key");
  } finally {
    fs.rmSync(secretDir, { recursive: true, force: true });
  }

  const oldModelKey = process.env.MODEL_API_KEY;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-meta-server-"));
  process.env.MODEL_API_KEY = "test-meta-api-key";
  const app = new OpenHarnessServer({ ...loadServerConfig({ MODEL_API_KEY: "test-meta-api-key" }), dataDir: tmpDir });
  try {
    const models = await app.handleAuthenticatedRequest(
      { tenantId: "default", userId: "test", admin: false },
      "GET",
      new URL("http://localhost/v1/models")
    );
    assert.equal(models.status, 200);
    assert.ok((models.body as Array<{ id: string; provider: string }>).some((model) => model.id === "muse-spark-1.3" && model.provider === "Meta Model API"));
    const session = await app.handleAuthenticatedRequest(
      { tenantId: "default", userId: "test", admin: false },
      "POST",
      new URL("http://localhost/v1/sessions"),
      {},
      {}
    );
    assert.equal(session.status, 201);
    assert.equal((session.body as { model: string }).model, "muse-spark-1.3");
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (oldModelKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = oldModelKey;
  }
});
