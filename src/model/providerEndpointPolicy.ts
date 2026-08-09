/**
 * Model credentials may be sent only to HTTPS endpoints or to an explicitly
 * local loopback development endpoint. This check lives at client creation as
 * well as Settings normalization so persisted/tampered data cannot bypass the
 * UI gate.
 */
export function normalizeSecureProviderBaseUrlV1(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === "https:") {
      return parsed.toString().replace(/\/+$/u, "");
    }
    if (parsed.protocol !== "http:" || !isLoopbackHostnameV1(parsed.hostname)) {
      return null;
    }
    return parsed.toString().replace(/\/+$/u, "");
  } catch {
    return null;
  }
}

export function requireSecureProviderBaseUrlV1(value: unknown): string {
  const normalized = normalizeSecureProviderBaseUrlV1(value);
  if (!normalized) {
    throw new Error(
      "Model provider endpoints must use HTTPS; plain HTTP is allowed only for localhost or IP loopback development endpoints.",
    );
  }
  return normalized;
}

export function isLoopbackHostnameV1(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}
