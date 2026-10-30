import { buildProviderWirePayload, ModelAgnosticProviderAdapter } from "./adapter.ts";
export { buildProviderWirePayload, ModelAgnosticProviderAdapter };

export function isBedrockModelId(modelId: string): boolean {
  return modelId.startsWith("anthropic.claude") || modelId.startsWith("meta.llama") || modelId.startsWith("amazon.");
}
