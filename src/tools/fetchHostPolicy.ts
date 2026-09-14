/**
 * One host policy for every tool that fetches a URL the model chose.
 *
 * `web_fetch` and `document_extract` each carried their own copy, and both
 * copies recognised an IP address only in dotted-quad form. That is not how a
 * URL names an address. `http://2130706433/`, `http://0x7f000001/` and
 * `http://127.1/` are all 127.0.0.1 to the resolver and none of them matched
 * the guard, and `[::ffff:127.0.0.1]` reached the same place through the IPv6
 * bracket form. document_extract fetches from the user's own machine, where
 * the companion service listens on 127.0.0.1:8765 and the LAN is reachable, so
 * the gap was a real path from a page's suggested link to a local endpoint.
 *
 * Two rules:
 *
 * - **Parse the way a resolver does, not the way a regex does.** Every IPv4
 *   literal form browsers accept (dotted-quad, dotted-triple, dotted-pair,
 *   bare integer; each part decimal, hex or octal) is normalised to one 32-bit
 *   address before any range is checked.
 * - **Unparseable means unsafe is unknown, not proven absent.** A hostname
 *   that is not an IP literal is allowed — it is a DNS name, and this guard
 *   cannot resolve it — but any literal the parser cannot make sense of is
 *   refused rather than waved through.
 *
 * This deliberately does not defend against DNS rebinding or a public name
 * that resolves to a private address: both need resolution the plugin does not
 * perform. The guard covers the literal forms, which is what a link in a page
 * can carry.
 */

/** Suffixes that never name a public host. */
const PRIVATE_HOST_SUFFIXES_V1 = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
];

const PRIVATE_HOST_NAMES_V1 = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/** Parse one IPv4 literal part: decimal, `0x`-hex, or leading-zero octal. */
function parseIpv4Part(part: string): number | null {
  if (!part) return null;
  let value: number;
  if (/^0[xX][0-9a-fA-F]+$/u.test(part)) {
    value = Number.parseInt(part.slice(2), 16);
  } else if (/^0[0-7]+$/u.test(part)) {
    value = Number.parseInt(part.slice(1), 8);
  } else if (/^[0-9]+$/u.test(part)) {
    value = Number.parseInt(part, 10);
  } else {
    return null;
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Any IPv4 literal form as one 32-bit address, or null when the host is not an
 * IPv4 literal at all.
 *
 * `a.b.c.d`, `a.b.c` (c spans 16 bits), `a.b` (b spans 24 bits) and `a` (a
 * spans 32 bits) are the four inet_aton shapes, and they are what makes
 * `http://127.1/` reach the loopback interface.
 */
export function parseIpv4LiteralV1(hostname: string): number | null {
  const parts = hostname.split(".");
  if (parts.length > 4) return null;
  // A name is only an IPv4 literal candidate if every part is numeric in one
  // of the accepted bases; "example.com" exits here.
  const values: number[] = [];
  for (const part of parts) {
    const value = parseIpv4Part(part);
    if (value === null) return null;
    values.push(value);
  }
  const last = values[values.length - 1]!;
  const leading = values.slice(0, -1);
  if (leading.some((value) => value > 0xff)) return null;
  const remainingBits = 8 * (4 - leading.length);
  if (last >= 2 ** remainingBits) return null;
  let address = last;
  for (let index = 0; index < leading.length; index += 1) {
    address += leading[index]! * 2 ** (8 * (3 - index));
  }
  return address >>> 0;
}

function isPrivateIpv4Address(address: number): boolean {
  const first = (address >>> 24) & 0xff;
  const second = (address >>> 16) & 0xff;
  return (
    first === 0 || // "this network", and 0.0.0.0 which routes to localhost
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) || // CGNAT 100.64/10
    (first === 169 && second === 254) || // link-local, incl. cloud metadata
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0) || // 192.0.0/24 protocol assignments
    (first === 198 && (second === 18 || second === 19)) || // benchmarking
    address === 0xffffffff // broadcast
  );
}

/**
 * True when this host must not be fetched: a loopback, link-local, private, or
 * otherwise non-public address in any literal spelling, or a name that always
 * resolves to one.
 */
export function isUnsafeFetchHostV1(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  if (!normalized) return true;
  if (PRIVATE_HOST_NAMES_V1.has(normalized)) return true;
  if (PRIVATE_HOST_SUFFIXES_V1.some((suffix) => normalized.endsWith(suffix))) {
    return true;
  }

  if (normalized.includes(":")) {
    // An IPv4-mapped or IPv4-compatible IPv6 address carries a dotted-quad
    // tail: judge it by the address it actually reaches.
    const mapped = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/u.exec(normalized);
    if (mapped) {
      const address = parseIpv4LiteralV1(mapped[1]!);
      if (address === null || isPrivateIpv4Address(address)) return true;
      // A mapped public address is still only reachable as IPv6; allow it.
      return false;
    }
    const compact = normalized.replace(/%.*$/u, "");
    if (
      compact === "::" ||
      compact === "::1" ||
      /^0*:(?:0*:)*0*1?$/u.test(compact) ||
      /^f[cd][0-9a-f]{0,2}:/u.test(compact) || // unique local fc00::/7
      /^fe[89ab][0-9a-f]?:/u.test(compact) // link-local fe80::/10
    ) {
      return true;
    }
    // Anything else with a colon must at least look like an IPv6 literal.
    return !/^[0-9a-f:]+$/u.test(compact);
  }

  const ipv4 = parseIpv4LiteralV1(normalized);
  if (ipv4 !== null) return isPrivateIpv4Address(ipv4);

  // Numeric-looking hosts that are not valid IPv4 literals (an overflowing
  // integer, a malformed octal) are refused: they are not DNS names either.
  if (/^[0-9]+$/u.test(normalized) || /^0[xX][0-9a-fA-F]+$/u.test(normalized)) {
    return true;
  }
  return false;
}

export interface SafeFetchUrlErrorsV1 {
  invalid: string;
  scheme: string;
  credentials: string;
  privateHost: string;
}

/**
 * Normalize and validate a URL a tool is about to fetch. Returns the string to
 * request; throws through `raise` with the caller's own message so each tool
 * keeps the error text (and error code) its callers already match on.
 */
export function normalizePublicFetchUrlV1(
  rawUrl: string,
  errors: SafeFetchUrlErrorsV1,
  raise: (message: string) => never,
): string {
  const trimmed = (rawUrl ?? "").trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    raise(errors.invalid);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    raise(errors.scheme);
  }
  if (url.username || url.password) {
    raise(errors.credentials);
  }
  if (isUnsafeFetchHostV1(url.hostname)) {
    raise(errors.privateHost);
  }
  url.hash = "";
  return url.toString();
}
