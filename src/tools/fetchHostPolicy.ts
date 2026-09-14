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
 * - **Judge the spelling the URL parser emits, not the one a human types.**
 *   The first version of this guard matched an IPv4-mapped IPv6 address by its
 *   dotted-quad tail, and its tests passed that spelling in by hand. `new
 *   URL()` rewrites `::ffff:127.0.0.1` to `::ffff:7f00:1` before any tool sees
 *   the hostname, so that branch could never fire in production and
 *   `http://[::ffff:127.0.0.1]/` stayed reachable. Both IPv6 and IPv4 literals
 *   are now decoded to the address they name; the tests drive every case
 *   through `new URL()` so no spelling can be asserted that the product never
 *   receives.
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
 * An IPv6 literal as its eight 16-bit groups, or null when the host is not a
 * well-formed IPv6 literal.
 *
 * Handles `::` elision, an optional trailing dotted-quad (`::ffff:127.0.0.1`),
 * and a zone suffix (`%eth0`). The dotted-quad tail is parsed strictly here —
 * inside an IPv6 literal only the four-part decimal form is legal, so the
 * inet_aton shapes `parseIpv4LiteralV1` accepts are rejected rather than
 * silently reinterpreted.
 */
export function parseIpv6LiteralV1(hostname: string): number[] | null {
  const literal = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/%.*$/u, "");
  if (!literal || !literal.includes(":")) return null;
  if (!/^[0-9a-f:.]+$/u.test(literal)) return null;

  const halves = literal.split("::");
  if (halves.length > 2) return null;

  const expand = (half: string): number[] | null => {
    if (!half) return [];
    const parts = half.split(":");
    const groups: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      if (part.includes(".")) {
        // A dotted quad is only legal as the final 32 bits.
        if (index !== parts.length - 1) return null;
        const quad = part.split(".");
        if (quad.length !== 4) return null;
        const octets: number[] = [];
        for (const octet of quad) {
          if (!/^[0-9]{1,3}$/u.test(octet)) return null;
          const value = Number.parseInt(octet, 10);
          if (value > 0xff) return null;
          octets.push(value);
        }
        groups.push((octets[0]! << 8) | octets[1]!);
        groups.push((octets[2]! << 8) | octets[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/u.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = expand(halves[0] ?? "");
  const tail = halves.length === 2 ? expand(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const missing = 8 - (head.length + tail.length);
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * True when an IPv6 address does not name a public host.
 *
 * IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible (`::/96`) and the NAT64
 * well-known prefix (`64:ff9b::/96`) all reach an IPv4 destination, so the
 * embedded address is judged by the same IPv4 rules rather than by a second
 * table that could drift from them.
 */
function isPrivateIpv6Address(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];
  const embeddedIpv4 = (((g6 << 16) | g7) >>> 0);
  const topFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  if (topFiveZero && g5 === 0) {
    // :: (unspecified) and ::1 (loopback) are never public; anything else in
    // ::/96 is an IPv4-compatible address.
    if (embeddedIpv4 === 0 || embeddedIpv4 === 1) return true;
    return isPrivateIpv4Address(embeddedIpv4);
  }
  if (topFiveZero && g5 === 0xffff) return isPrivateIpv4Address(embeddedIpv4);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIpv4Address(embeddedIpv4);
  }

  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  return false;
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
    // Judge the address, never its spelling. `new URL()` rewrites
    // `::ffff:127.0.0.1` to `::ffff:7f00:1` before any tool sees it, so a
    // guard that looks for a dotted-quad tail never fires in production.
    const groups = parseIpv6LiteralV1(normalized);
    // A colon can only appear in a hostname as an IPv6 literal; one the
    // parser cannot make sense of is refused rather than waved through.
    if (!groups) return true;
    return isPrivateIpv6Address(groups);
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
