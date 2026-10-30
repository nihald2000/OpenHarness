import { wrapUntrustedContent, RiskPolicyGate } from "./risk.ts";
export { wrapUntrustedContent, RiskPolicyGate };

export function isUntrustedWrapped(text: string): boolean {
  return text.includes("<untrusted_data ") && text.includes("</untrusted_data>");
}
