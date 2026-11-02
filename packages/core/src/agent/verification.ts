export function formatBrowserEvidence(name: string, total: number, value: any, backendUrl: string): string {
  if (value?.passed) return `Browser check "${name}" passed (${total} steps).`;
  return [
    `Browser check "${name}" failed at step ${Number(value?.failedStep ?? 0) + 1}/${total}: ${JSON.stringify(value?.step ?? {})},`,
    `error: ${String(value?.error ?? "Browser check failed")},`,
    `url: ${String(value?.url ?? "about:blank")},`,
    `visible text: ${String(value?.text || "(empty)")},`,
    `console/page errors: ${Array.isArray(value?.errors) && value.errors.length ? value.errors.join(" | ") : "none"},`,
    `page log: ${Array.isArray(value?.log) ? JSON.stringify(value.log).slice(0, 1200) : String(value?.log || "(empty)")},`,
    `failed requests: ${Array.isArray(value?.failedRequests) && value.failedRequests.length ? value.failedRequests.join(" | ") : "none"},`,
    `backend: ${backendUrl} (last 20 lines)\n${String(value?.backendUrl ?? "")}`,
  ].filter(Boolean).join("\n");
}

export const browserSignature = (name: string, value: any) =>
  `browser:${name}:${value?.failedStep ?? -1}:${String(value?.error ?? "failed")
    .replace(/\d+/g, "#")
    .replace(/https?:\/\/[^\s]+/g, "<url>")
    .slice(0, 120)}`;
