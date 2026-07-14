import type { BootstrapTokenLeaseV1 } from "./backgroundContinuation";

const COMPANION_SESSION_SYMBOL = Symbol.for(
  "agentic-researcher.companion-bootstrap-session.v1",
);

export interface CompanionBootstrapSessionV1 {
  version: 1;
  baseUrl: string;
  credential: BootstrapTokenLeaseV1;
  connectedAt: string;
}

/**
 * Installs an in-memory credential capability shared by the independently
 * bundled Obsidian core and companion extension. The token itself remains
 * closure-backed and cannot be serialized from this registry.
 */
export function installCompanionBootstrapSessionV1(
  session: CompanionBootstrapSessionV1,
): () => void {
  if (session.version !== 1 || session.credential.disposed) {
    throw new Error("A live companion bootstrap credential is required.");
  }
  const normalized = normalizeCompanionBaseUrlV1(session.baseUrl);
  const registry = readRegistry();
  const previous = registry.get(normalized);
  registry.set(normalized, Object.freeze({ ...session, baseUrl: normalized }));
  return () => {
    if (registry.get(normalized)?.credential === session.credential) {
      registry.delete(normalized);
      session.credential.dispose();
      if (previous && !previous.credential.disposed) {
        registry.set(normalized, previous);
      }
    }
  };
}

export function resolveCompanionBootstrapSessionV1(
  baseUrl: string,
): CompanionBootstrapSessionV1 | null {
  const session = readRegistry().get(normalizeCompanionBaseUrlV1(baseUrl)) ?? null;
  return session && !session.credential.disposed ? session : null;
}

export function clearCompanionBootstrapSessionV1(baseUrl: string): boolean {
  const normalized = normalizeCompanionBaseUrlV1(baseUrl);
  const registry = readRegistry();
  const session = registry.get(normalized);
  if (!session) return false;
  registry.delete(normalized);
  session.credential.dispose();
  return true;
}

export function normalizeCompanionBaseUrlV1(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Companion base URL is invalid.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  if (
    !loopback ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "Companion base URL must be an HTTP(S) loopback origin without credentials, path, query, or fragment.",
    );
  }
  return url.origin;
}

function readRegistry(): Map<string, CompanionBootstrapSessionV1> {
  const scope = globalThis as typeof globalThis & {
    [COMPANION_SESSION_SYMBOL]?: Map<string, CompanionBootstrapSessionV1>;
  };
  const existing = scope[COMPANION_SESSION_SYMBOL];
  if (existing) return existing;
  const created = new Map<string, CompanionBootstrapSessionV1>();
  Object.defineProperty(scope, COMPANION_SESSION_SYMBOL, {
    value: created,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return created;
}
