/**
 * Secrets a lane created that its own data.json restore is about to orphan.
 *
 * Every lane launch seeds plaintext credentials (a model API key, a GitHub
 * token) into the core plugin's data.json; the plugin migrates each into
 * Obsidian SecretStorage and records the reference. Teardown then restores
 * the pre-lane data.json byte for byte, which forgets the reference while
 * the secret stays behind. Measured on 2026-09-07: 966 ids in the store,
 * 703 with a value — 308 GitHub device credentials, 292 + 42 model keys —
 * one or two per lane, for weeks. SecretStorage is one encrypted blob
 * rewritten whole on every write, so the growth makes every later write
 * (and its disk commit) slower, which is the window a rotated Linear pair
 * was lost in. The harness owns what it seeded; it removes those secrets
 * before the restore, from inside the still-running app.
 *
 * Only fields the restore actually overwrites are considered: a preserved
 * Linear or GitHub record is carried forward by the restore and its secrets
 * may be needed by the product's own recovery, so they are never touched.
 */
import type { App } from "obsidian";

const NATIVE_REFERENCE = /^secret-obsidian-[a-z0-9-]{16,48}$/u;
const NATIVE_REFERENCE_ANYWHERE = /secret-obsidian-[a-z0-9-]{16,48}/gu;

export interface DiscardedSecretReferenceOptions {
  preserveLinear: boolean;
  preserveGitHub: boolean;
}

export function discardedSecretReferencesV1(
  baselineContent: string | null,
  currentContent: string | null,
  options: DiscardedSecretReferenceOptions,
): string[] {
  const current = parseObject(currentContent);
  if (!current) return [];
  const baselineIds = new Set(
    (baselineContent ?? "").match(NATIVE_REFERENCE_ANYWHERE) ?? [],
  );
  const candidates: unknown[] = [];
  const models = current.modelCredentialReferences;
  if (isRecord(models)) {
    for (const slot of ["ollama", "openAiCompatible", "specialist"]) {
      const reference = models[slot];
      if (isRecord(reference)) candidates.push(reference.referenceId);
    }
  }
  if (!options.preserveGitHub && isRecord(current.githubCredential)) {
    candidates.push(current.githubCredential.tokenReferenceId);
  }
  if (!options.preserveLinear) {
    if (isRecord(current.linearCredentialReference)) {
      candidates.push(current.linearCredentialReference.referenceId);
    }
    const oauth = current.linearOAuthRuntimeState;
    if (isRecord(oauth) && isRecord(oauth.credential)) {
      candidates.push(oauth.credential.accessTokenReferenceId);
      candidates.push(oauth.credential.refreshTokenReferenceId);
    }
  }
  const discarded: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !NATIVE_REFERENCE.test(candidate)) continue;
    if (baselineIds.has(candidate) || discarded.includes(candidate)) continue;
    discarded.push(candidate);
  }
  return discarded;
}

export interface SecretRemovalPageLike {
  isClosed(): boolean;
  evaluate<R, A>(pageFunction: (arg: A) => R, arg: A): Promise<R>;
}

export const SECRET_REMOVAL_TIMEOUT_MS = 5_000;

/**
 * Slack on top of the in-page budget, for the round trip only. The page stops
 * itself at `budgetMs`; this is how long the fixture then waits for the answer
 * before giving up on hearing one at all.
 */
export const SECRET_REMOVAL_ABANDON_GRACE_MS = 500;

export interface NativeSecretRemovalRequestV1 {
  targets: string[];
  /** Wall-clock the page may spend deleting, measured from its own entry. */
  budgetMs: number;
}

/**
 * Runs inside the app: delete each secret, prove it gone, and ask Chromium to
 * commit before returning how many are provably gone.
 *
 * Playwright serializes this function into the page, so it may reference
 * nothing but its own argument and page globals. It is exported so the
 * deadline, the count and the commit request can be tested directly instead of
 * through a stubbed `evaluate` that never runs the body that matters.
 */
export function deleteNativeSecretsInPageV1(
  request: NativeSecretRemovalRequestV1,
): number {
  const deadline = Date.now() + request.budgetMs;
  const runtime = window as Window & {
    app?: App;
    require?: (moduleId: string) => unknown;
  };
  const storage = runtime.app?.secretStorage;
  if (!storage || typeof storage.getSecret !== "function") return 0;
  let removed = 0;
  let mutated = false;
  for (const id of request.targets) {
    // The fixture stops waiting at this same deadline. A delete that lands
    // after it is a write nobody counted and nobody committed, which is the
    // exact shape of the 2026-09-07 loss; stop instead, and let the caller
    // report only the ids this loop proved gone.
    if (Date.now() >= deadline) break;
    try {
      if (typeof storage.deleteSecret === "function") {
        storage.deleteSecret(id);
      } else if (typeof storage.setSecret === "function") {
        storage.setSecret(id, "");
      } else {
        // Neither write exists on this build, so no later id can fare better.
        break;
      }
      mutated = true;
      if (!storage.getSecret(id)) removed += 1;
    } catch {
      // Leave it; the count tells the log what happened.
    }
  }
  if (mutated) {
    try {
      const remote = runtime.require?.("@electron/remote") as
        | { session?: { defaultSession?: { flushStorageData?: () => void } } }
        | undefined;
      remote?.session?.defaultSession?.flushStorageData?.();
    } catch {
      // Best effort, exactly as on the product's own write path: SecretStorage
      // is DOMStorage, so these deletions are committed on Chromium's delay,
      // and the harness kills the process moments from here.
    }
  }
  return removed;
}

/**
 * Remove the given native secrets from inside the running app. Returns how
 * many the app proved gone; never throws — a failed cleanup leaves exactly
 * the residue every lane left before this existed.
 *
 * `timeoutMs` bounds the work, not just the waiting: it is handed to the page
 * as the budget it must stop at, so an abandoned round trip cannot leave
 * deletions landing after teardown has moved on.
 */
export async function removeDiscardedSecretsV1(
  page: SecretRemovalPageLike | null,
  referenceIds: readonly string[],
  timeoutMs: number = SECRET_REMOVAL_TIMEOUT_MS,
): Promise<number> {
  const ids = referenceIds.filter((id) => NATIVE_REFERENCE.test(id));
  if (ids.length === 0 || !page || page.isClosed()) return 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const outcome = await Promise.race([
      page.evaluate(deleteNativeSecretsInPageV1, {
        targets: ids,
        budgetMs: timeoutMs,
      }),
      new Promise<"abandoned">((resolve) => {
        timer = setTimeout(
          () => resolve("abandoned"),
          timeoutMs + SECRET_REMOVAL_ABANDON_GRACE_MS,
        );
      }),
    ]);
    // An abandoned round trip proves nothing: the page bounded itself at the
    // same deadline, so whatever it removed it has already stopped removing,
    // and this fixture reports only what it can prove.
    return typeof outcome === "number" ? outcome : 0;
  } catch {
    return 0;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function parseObject(content: string | null): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
