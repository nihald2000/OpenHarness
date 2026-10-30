import { buildProviderWirePayload, ModelAgnosticProviderAdapter } from "./adapter.ts";
export { buildProviderWirePayload, ModelAgnosticProviderAdapter };

export function isAnthropicWireModel(modelId: string): boolean {
  return modelId.startsWith("claude-") || modelId.includes("anthropic");
}
