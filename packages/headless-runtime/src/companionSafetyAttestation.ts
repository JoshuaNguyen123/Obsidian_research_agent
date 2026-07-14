import type { BootstrapTokenLeaseV1 } from "./backgroundContinuation";
import { canonicalJson, sha256Fingerprint } from "./canonicalize";
import type { MissionJsonValueV1 } from "./missionGraphV3";

export type CompanionBrowserActionV1 =
  | "navigate"
  | "observe"
  | "click"
  | "type"
  | "keypress"
  | "scroll"
  | "screenshot"
  | "extract";

export interface CompanionSafetyAttestationV1 {
  version: 1;
  decision: "allow";
  action: CompanionBrowserActionV1;
  payloadFingerprint: string;
  policyFingerprint: string;
  nonce: string;
  decidedAt: string;
  expiresAt: string;
  signature: string;
}

export async function createCompanionSafetyAttestationV1(input: {
  credential: BootstrapTokenLeaseV1;
  action: CompanionBrowserActionV1;
  payload: Record<string, MissionJsonValueV1>;
  policyDecision: {
    status: "allow";
    risk: string;
    reason: string;
    policyTags: string[];
  };
  now?: Date;
  ttlMs?: number;
}): Promise<CompanionSafetyAttestationV1> {
  if (input.policyDecision.status !== "allow") {
    throw new Error("Only an allow decision may be attested.");
  }
  const now = input.now ?? new Date();
  const ttl = Math.max(1_000, Math.min(30_000, Math.floor(input.ttlMs ?? 15_000)));
  const core = {
    version: 1 as const,
    decision: "allow" as const,
    action: input.action,
    payloadFingerprint: await sha256Fingerprint(input.payload),
    policyFingerprint: await sha256Fingerprint({
      version: 1,
      status: input.policyDecision.status,
      risk: input.policyDecision.risk,
      reason: input.policyDecision.reason,
      policyTags: [...input.policyDecision.policyTags].sort(),
    }),
    nonce: randomNonce(),
    decidedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  };
  const signature = await input.credential.withToken(async (token) => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error("Web Crypto HMAC is unavailable.");
    const key = await subtle.importKey(
      "raw",
      new TextEncoder().encode(token),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const bytes = await subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(canonicalJson(core)),
    );
    return `hmac-sha256:${[...new Uint8Array(bytes)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
  });
  return { ...core, signature };
}

function randomNonce(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new Error("Secure random is unavailable.");
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const packed = (a << 16) | (b << 8) | c;
    output += alphabet[(packed >>> 18) & 63];
    output += alphabet[(packed >>> 12) & 63];
    if (index + 1 < bytes.length) output += alphabet[(packed >>> 6) & 63];
    if (index + 2 < bytes.length) output += alphabet[packed & 63];
  }
  return output;
}
