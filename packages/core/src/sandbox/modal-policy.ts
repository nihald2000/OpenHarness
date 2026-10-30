import type { CompiledSandboxPolicy } from "./policy.ts";
import type { ModalCreateParams } from "./modal-api.ts";

const DOMAIN = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Modal enforces coarse egress (TLS/SNI domain allowlist, port 443 only); srt inside enforces the fine policy. */
export function toModalNetwork(
  p: CompiledSandboxPolicy
): Pick<ModalCreateParams, "outboundDomainAllowlist" | "outboundCidrAllowlist"> {
  if (p.network.mode === "open") {
    throw new Error("Open egress is not allowed for Modal sandboxes");
  }
  if (p.network.mode === "none") {
    return { outboundDomainAllowlist: [], outboundCidrAllowlist: [] };
  }
  const domains = [
    ...new Set(p.network.allowedDomains.map((d) => d.trim().toLowerCase())),
  ];
  for (const d of domains) {
    if (!DOMAIN.test(d)) {
      throw new Error(`invalid allowlisted domain: ${d}`);
    }
  }
  return { outboundDomainAllowlist: domains, outboundCidrAllowlist: [] };
}

export const SETUP_DOMAINS = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
  "index.crates.io",
  "static.crates.io",
  "repo.maven.apache.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
];
