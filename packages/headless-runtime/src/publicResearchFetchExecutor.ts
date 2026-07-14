import {
  buildCompanionReceiptV1,
  type HeadlessDomainExecutorV1,
} from "./backgroundContinuation";
import { sha256Fingerprint } from "./canonicalize";

export interface PublicResearchFetchDependenciesV1 {
  requestPinned(url: URL, address: string, signal: AbortSignal): Promise<Response>;
  resolveHost(hostname: string): Promise<string[]>;
  now?: () => Date;
}

export function createPublicResearchFetchExecutorV1(
  dependencies: PublicResearchFetchDependenciesV1,
): HeadlessDomainExecutorV1 {
  const now = dependencies.now ?? (() => new Date());
  return async (job, context) => {
    if (job.domain !== "research" || !job.allowedTools.includes("web_fetch")) {
      return {
        status: "blocked",
        blocker: {
          code: "executor_scope_mismatch",
          message: "Public research fetch requires an authorized research web_fetch node.",
          requiredAction: null,
        },
      };
    }
    const urls = extractAuthorizedUrls(job.inputs);
    if (urls.length === 0 || urls.length > 5) {
      return {
        status: "blocked",
        blocker: {
          code: "invalid_research_urls",
          message: "Public research fetch requires between one and five authorized HTTP(S) URLs.",
          requiredAction: "Provide a bounded set of explicit public source URLs.",
        },
      };
    }
    const sources: Array<{
      url: string;
      status: number;
      contentType: string;
      text: string;
      fingerprint: string;
    }> = [];
    for (const url of urls) {
      if (context.signal.aborted) return { status: "cancelled" };
      await context.reportProgress(`Fetching authorized public source ${sources.length + 1}/${urls.length}.`);
      sources.push(await fetchPublicText(url, dependencies, context.signal));
    }
    const sourceUrls = sources.map((source) => source.url);
    const evidenceFingerprint = await sha256Fingerprint(
      sources.map((source) => ({
        url: source.url,
        status: source.status,
        contentType: source.contentType,
        fingerprint: source.fingerprint,
      })),
    );
    const committedAt = now().toISOString();
    const receipt = await buildCompanionReceiptV1({
      job,
      id: `research-${job.id}`,
      provider: "research",
      operation: "public_research_fetch",
      status: "verified",
      payload: {
        evidenceFingerprint,
        sourceCount: sources.length,
        sourceUrls,
      },
      committedAt,
    });
    return {
      status: "complete",
      outputs: {
        summary: sources
          .map((source) => `Source: ${source.url}\n${source.text.slice(0, 20_000)}`)
          .join("\n\n")
          .slice(0, 80_000),
        sourceCount: sources.length,
        evidenceFingerprint,
      },
      evidence: sources.map((source) => ({
        kind: "public_web_source",
        url: source.url,
        fingerprint: source.fingerprint,
      })),
      receipts: [receipt],
    };
  };
}

async function fetchPublicText(
  initialUrl: string,
  dependencies: PublicResearchFetchDependenciesV1,
  signal: AbortSignal,
) {
  let current = normalizePublicUrl(initialUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const addresses = await publicDestinationAddresses(current, dependencies.resolveHost);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = globalThis.setTimeout(() => controller.abort("fetch_timeout"), 15_000);
    let response: Response;
    try {
      response = await dependencies.requestPinned(
        current,
        [...addresses].sort()[0],
        controller.signal,
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirects === 5) throw new Error("Public source redirect limit exceeded.");
        current = normalizePublicUrl(new URL(location, current).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Public source returned HTTP ${response.status}.`);
      }
      const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
      if (
        !contentType.startsWith("text/") &&
        !["application/json", "application/xml", "application/xhtml+xml"].includes(contentType)
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Public source content type is not text: ${contentType || "unknown"}.`);
      }
      const text = await readTextBounded(response, 1_048_576);
      return {
        url: current.href,
        status: response.status,
        contentType,
        text,
        fingerprint: await sha256Fingerprint({
          url: current.href,
          status: response.status,
          contentType,
          text,
        }),
      };
    } finally {
      signal.removeEventListener("abort", abort);
      globalThis.clearTimeout(timer);
    }
  }
  throw new Error("Public source redirect limit exceeded.");
}

async function publicDestinationAddresses(
  url: URL,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<string[]> {
  const addresses = isIpLiteral(url.hostname)
    ? [url.hostname.replace(/^\[|\]$/g, "")]
    : await resolveHost(url.hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicIp(address))) {
    throw new Error("Public research fetch rejected a private or non-public destination.");
  }
  return addresses;
}

function normalizePublicUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  ) {
    throw new Error("Public research fetch accepts only credential-free HTTP(S) URLs on standard ports.");
  }
  let secretQueryParameter = false;
  url.searchParams.forEach((_value, key) => {
    if (/(token|secret|password|passwd|api[_-]?key|authorization|credential|code)/i.test(key)) {
      secretQueryParameter = true;
    }
  });
  if (secretQueryParameter) {
    throw new Error("Public research fetch rejects secret-bearing query parameters.");
  }
  url.hash = "";
  return url;
}

function extractAuthorizedUrls(inputs: Record<string, unknown>): string[] {
  const candidates = [inputs.url, inputs.urls, inputs.sourceUrl, inputs.sourceUrls]
    .flatMap((value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]))
    .filter((value): value is string => typeof value === "string");
  return [...new Set(candidates)];
}

function isIpLiteral(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "");
  return ipv4Bytes(value) !== null || ipv6Bytes(value) !== null;
}

function isPublicIp(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = ipv4Bytes(value);
  if (ipv4) return isPublicIpv4Bytes(ipv4);
  const bytes = ipv6Bytes(value);
  if (!bytes) return false;

  // Only global-unicast space can be public. This rejects unspecified,
  // loopback, multicast, link-local, ULA, mapped/compatible IPv4, and both
  // well-known and local-use NAT64 translation prefixes.
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  // Teredo 2001:0000::/32 and documentation 2001:db8::/32 are never direct
  // public destinations. ORCHIDv1/v2 are identifiers, not routable locators.
  if (
    hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00], 32) ||
    hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32) ||
    hasPrefix(bytes, [0x20, 0x01, 0x00, 0x10], 28) ||
    hasPrefix(bytes, [0x20, 0x01, 0x00, 0x20], 28) ||
    hasPrefix(bytes, [0x3f, 0xff], 20)
  ) {
    return false;
  }
  // 6to4 exposes an embedded IPv4 destination; accept it only when that
  // embedded address is independently public.
  if (hasPrefix(bytes, [0x20, 0x02], 16)) {
    return isPublicIpv4Bytes(bytes.slice(2, 6));
  }
  return true;
}

function ipv4Bytes(value: string): number[] | null {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/u.test(part))
  ) {
    return null;
  }
  const bytes = parts.map(Number);
  return bytes.some((part) => part < 0 || part > 255) ? null : bytes;
}

function isPublicIpv4Bytes(bytes: number[]): boolean {
  if (
    bytes.length !== 4 ||
    bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b, c, d] = bytes;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 255 && b === 255 && c === 255 && d === 255)
  );
}

function ipv6Bytes(value: string): number[] | null {
  if (!value || value.includes("%")) return null;
  const dottedIndex = value.lastIndexOf(":");
  let normalized = value;
  if (value.includes(".")) {
    if (dottedIndex < 0) return null;
    const dotted = ipv4Bytes(value.slice(dottedIndex + 1));
    if (!dotted) return null;
    normalized = `${value.slice(0, dottedIndex)}:${((dotted[0] << 8) | dotted[1]).toString(16)}:${((dotted[2] << 8) | dotted[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (
    [...left, ...right].some((group) => !/^[0-9a-f]{1,4}$/iu.test(group))
  ) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((group) => Number.parseInt(group || "0", 16));
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return null;
  }
  return groups.flatMap((group) => [(group >>> 8) & 0xff, group & 0xff]);
}

function hasPrefix(bytes: number[], prefix: number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remainder = bits % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[fullBytes] & mask) === ((prefix[fullBytes] ?? 0) & mask);
}

async function readTextBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Public source exceeded the 1 MiB response limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
