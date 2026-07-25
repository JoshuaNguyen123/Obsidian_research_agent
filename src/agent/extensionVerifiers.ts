import type {
  ExtensionMissionSnapshotV1,
  ExtensionRegistrationTokenV1,
  MissionVerifierContributionV1,
  MissionVerifierInputV1,
  MissionVerifierResultV1,
  RegisteredContributionV1,
  ScopedExtensionContextV1,
} from "../../packages/core-api/src";
import type { VerificationCheck } from "./verifiers";

/**
 * Host-side consumer for the mission_verifier extension slot. The slot has
 * been defined, validated, and surfaced on ExtensionMissionSnapshotV1 since
 * the contribution API landed, but nothing read snapshot.verifiers — this
 * closes that gap at the verify node.
 *
 * Fail-closed: a verifier that throws, times out, or returns an unusable
 * result yields a blocked check rather than being skipped, so a registered
 * verifier can never be silently bypassed. ScopedExtensionContextV1 carries no
 * ModelClient, so contributions here are deterministic checks; the model-backed
 * independent critic is the core-side criticWorker.
 */

const DEFAULT_VERIFIER_TIMEOUT_MS = 30_000;
const MAX_MISSING_ENTRIES = 32;
const MAX_MESSAGE_CHARS = 2_000;

export interface RunExtensionVerifiersOptions {
  isTokenActive(token: ExtensionRegistrationTokenV1): boolean;
  timeoutMs?: number;
  now?: () => Date;
  signal?: AbortSignal;
}

export async function runExtensionVerifiers(
  snapshot: Pick<ExtensionMissionSnapshotV1, "verifiers">,
  input: MissionVerifierInputV1,
  options: RunExtensionVerifiersOptions,
): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  for (const registered of snapshot.verifiers) {
    checks.push(await runOneVerifier(registered, input, options));
  }
  return checks;
}

async function runOneVerifier(
  registered: RegisteredContributionV1<MissionVerifierContributionV1>,
  input: MissionVerifierInputV1,
  options: RunExtensionVerifiersOptions,
): Promise<VerificationCheck> {
  const now = options.now ?? (() => new Date());
  const verifierId = `extension:${registered.extensionId}:${registered.contribution.descriptor.id}`;
  const base = {
    id: verifierId,
    kind: "extension" as const,
    targetNodeId: input.nodeId,
    checkedAt: now().toISOString(),
  };
  if (registered.token.signal.aborted || !options.isTokenActive(registered.token)) {
    return {
      ...base,
      status: "blocked",
      confidence: 1,
      missing: [`Extension verifier is unavailable: ${registered.extensionId}`],
      evidenceIds: [],
      receiptIds: [],
      message: `Registered mission verifier ${verifierId} is revoked or unloaded; failing closed.`,
    };
  }

  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS);
  try {
    const result = await withTimeout(
      registered.contribution.verify(input, scopedContext(registered.token, options)),
      timeoutMs,
      verifierId,
    );
    return {
      ...base,
      status: normalizeStatus(result.status),
      confidence: 1,
      missing: normalizeStrings(result.missing),
      evidenceIds: normalizeStrings(result.evidenceIds),
      receiptIds: normalizeStrings(result.receiptIds),
      message: String(result.message ?? "").slice(0, MAX_MESSAGE_CHARS) ||
        `Extension verifier ${verifierId} returned no message.`,
    };
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      confidence: 1,
      missing: [
        `Extension verifier ${verifierId} did not complete: ${
          error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400)
        }`,
      ],
      evidenceIds: [],
      receiptIds: [],
      message: `Extension verifier ${verifierId} threw or timed out; failing closed.`,
    };
  }
}

function normalizeStatus(
  value: MissionVerifierResultV1["status"],
): VerificationCheck["status"] {
  return value === "pass" ||
    value === "fail" ||
    value === "needs_more_work" ||
    value === "blocked"
    ? value
    : "blocked";
}

function normalizeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .slice(0, MAX_MISSING_ENTRIES)
    .map((entry) => entry.slice(0, 400));
}

function scopedContext(
  token: ExtensionRegistrationTokenV1,
  options: RunExtensionVerifiersOptions,
): ScopedExtensionContextV1 {
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    version: 1,
    extensionId: token.extensionId,
    abortSignal: options.signal ?? token.signal,
    now: () => new Date(now().getTime()),
    reportProgress: () => {},
  });
}

async function withTimeout<TResult>(
  promise: Promise<TResult>,
  timeoutMs: number,
  label: string,
): Promise<TResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
