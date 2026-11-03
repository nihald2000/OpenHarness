import dns from "node:dns";
import { isIP } from "node:net";

/**
 * Returns true if the given hostname or IP literal resolves to or represents
 * a loopback, link-local, cloud metadata, RFC1918 private, CGNAT, or reserved address.
 */
export function isPrivateOrLoopbackHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".arpa") ||
    host === "metadata.google.internal" ||
    host === "metadata"
  ) {
    return true;
  }

  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
    const [a, b] = octets as [number, number, number, number];
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    ) {
      return true;
    }
    return false;
  }

  if (isIP(host) === 6) {
    if (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      /^fe[89ab]/i.test(host) ||
      host.startsWith("ff")
    ) {
      return true;
    }
    const v4Mapped = host.match(/^::(?:ffff:)?(?:0+:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (v4Mapped?.[1]) {
      return isPrivateOrLoopbackHost(v4Mapped[1]);
    }
    const v4Hex = host.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (v4Hex?.[1] && v4Hex?.[2]) {
      const hi = parseInt(v4Hex[1], 16);
      const lo = parseInt(v4Hex[2], 16);
      const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateOrLoopbackHost(dotted);
    }
  }

  return false;
}

/**
 * Validates that a URL uses HTTP/HTTPS, contains no embedded credentials,
 * and does not target loopback, RFC1918 private, or cloud metadata hosts.
 */
export function assertSafeExternalUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid external URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("External URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("External URL must not contain embedded credentials");
  }
  if (isPrivateOrLoopbackHost(url.hostname)) {
    throw new Error(`Blocked request to private, loopback, or metadata host: ${url.hostname}`);
  }
  return url;
}

/**
 * Resolves DNS for a public URL and verifies that none of its resolved addresses
 * point to loopback, private, link-local, or cloud metadata networks.
 */
export async function assertSafeResolvedExternalUrl(rawUrl: string | URL): Promise<URL> {
  const url = typeof rawUrl === "string" ? assertSafeExternalUrl(rawUrl) : assertSafeExternalUrl(rawUrl.toString());
  const cleanHost = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(cleanHost) === 0 && process.env.OH_SKIP_DNS_SSRF_CHECK !== "1") {
    try {
      const records = await dns.promises.lookup(cleanHost, { all: true });
      for (const rec of records) {
        if (isPrivateOrLoopbackHost(rec.address)) {
          throw new Error(`Host "${cleanHost}" resolved to blocked internal IP ${rec.address}`);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("resolved to blocked internal IP")) {
        throw err;
      }
      // Let fetch surface network resolution errors if DNS is offline
    }
  }
  return url;
}

/**
 * Fetches an external HTTP/HTTPS URL while validating every redirect hop against
 * loopback, private-IP, and cloud metadata SSRF targets.
 */
export async function fetchSafeExternal(
  rawUrl: string | URL,
  init: RequestInit = {},
  maxRedirects = 3
): Promise<Response> {
  let currentUrl = await assertSafeResolvedExternalUrl(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetch(currentUrl, {
      ...init,
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    if (hop === maxRedirects) {
      throw new Error("External fetch exceeded maximum redirect limit");
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Redirect response did not include a Location header");
    }
    currentUrl = await assertSafeResolvedExternalUrl(new URL(location, currentUrl));
  }
  throw new Error("External fetch failed");
}
