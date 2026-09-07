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
 * Remove the given native secrets from inside the running app. Returns how
 * many the app reported gone; never throws — a failed cleanup leaves exactly
 * the residue every lane left before this existed.
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
    const removed = await Promise.race([
      page.evaluate((targets: string[]) => {
        const storage = (window as Window & { app?: { secretStorage?: any } }).app
          ?.secretStorage;
        if (!storage || typeof storage.getSecret !== "function") return 0;
        let count = 0;
        for (const id of targets) {
          try {
            if (typeof storage.deleteSecret === "function") {
              storage.deleteSecret(id);
            } else if (typeof storage.setSecret === "function") {
              storage.setSecret(id, "");
            } else {
              continue;
            }
            if (!storage.getSecret(id)) count += 1;
          } catch {
            // Leave it; the count tells the log what happened.
          }
        }
        return count;
      }, ids),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    return removed === "timeout" ? 0 : removed;
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
