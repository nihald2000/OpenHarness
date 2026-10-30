import { buildProviderWirePayload, ModelAgnosticProviderAdapter } from "./adapter.ts";
export { buildProviderWirePayload, ModelAgnosticProviderAdapter };

export function usesMaxCompletionTokens(profile: { maxTokensField?: string }): boolean {
  return profile.maxTokensField === "max_completion_tokens";
}
