/**
 * One redactor for every seat that puts an error, a diagnostic, or a receipt
 * somewhere a person or a model can read it.
 *
 * Before this module there were twelve independent implementations, and their
 * vocabularies did not agree. `linearQueueVaultTool` redacted `token=...` and
 * nothing else — not even `Bearer` — while it is the seat closest to a Linear
 * API key. `CompanionClient` knew `ghp_`, `github_pat_` and `sk-` but not
 * `lin_api_`; the Linear client knew `lin_api_` but neither GitHub shape nor
 * `sk-`; `jupyterReflectionTool`, `projectResultsTool`,
 * `backgroundMissionDispatch` and `BundledCapabilityRuntime` knew no bare
 * token prefix at all. A credential therefore survived exactly in the seats
 * that had never heard of its shape, and those seats write into run notes and
 * receipts that live in the user's vault.
 *
 * That is the project's recurring failure shape — two subsystems answering the
 * same question differently — and the fix is the usual one: a single
 * predicate every seat consumes, never a twelfth copy with one more prefix.
 *
 * Deliberately free of any `obsidian` import so the headless runtime, the MCP
 * server and the tool layer can all use it.
 */

export const REDACTED_PLACEHOLDER_V1 = "[REDACTED]";

/**
 * Credential prefixes this project can actually hold, plus the generic
 * `sk-` family (OpenAI, Anthropic, most OpenAI-compatible providers).
 *
 * A prefix list is not a guess about entropy: each of these is issued by a
 * provider this codebase authenticates against, so a match is a credential,
 * never prose. The suffix is therefore unbounded rather than length-gated — a
 * short or placeholder-looking tail is still the shape of a secret, and a
 * minimum length only means the redactor misses the tokens nobody anticipated.
 * `sk-` keeps a floor, because two letters and a hyphen do occur in prose.
 */
const PREFIXED_CREDENTIAL_PATTERN_V1 =
  /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|lin_api_[A-Za-z0-9_-]+|lin_oauth_[A-Za-z0-9_-]+|sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{12,}|xox[bpasr]-[A-Za-z0-9-]+)/gu;

/** `Authorization: Bearer <token>` in any casing, header or prose. */
const BEARER_PATTERN_V1 = /Bearer\s+\S+/giu;

/** `token=...`, `api_key: ...`, `client_secret = ...`, and friends. */
const LABELLED_SECRET_PATTERN_V1 =
  /\b(token|secret|password|passwd|credential|authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?id)\b\s*[=:]\s*["']?[^\s,;}"']+["']?/giu;

/** `?token=...`, `&code=...` — the OAuth shapes that ride in URLs. */
const QUERY_SECRET_PATTERN_V1 =
  /([?&](?:token|key|api[_-]?key|secret|code|state|access[_-]?token|refresh[_-]?token|signature)=)[^&\s]+/giu;

/** `https://user:token@host` — git remotes carry credentials this way. */
const URL_USERINFO_PATTERN_V1 = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/giu;

/**
 * A long opaque run with no provider prefix: the shape of an Ollama cloud key
 * or a bare OAuth access token.
 *
 * Off by default. Hex-only runs are excluded whatever the setting, because
 * this project states sha256 fingerprints in error messages as proof — a
 * redactor that eats them removes evidence instead of secrets.
 */
const OPAQUE_CREDENTIAL_PATTERN_V1 = /\b(?![A-Fa-f0-9]+\b)[A-Za-z0-9_-]{48,}\b/gu;

export interface RedactSecretsOptionsV1 {
  /**
   * Values known to be secret at the call site (a configured API key, a token
   * about to be written to a git remote). Replaced literally, so a credential
   * in a shape nobody anticipated still never survives the seat that holds it.
   */
  knownSecrets?: readonly (string | null | undefined)[];
  /**
   * Also redact long unprefixed opaque runs. For diagnostics that leave the
   * process (terminal error projections, anything a model reads back), where
   * an unrecognised token shape is likelier than a false positive.
   */
  redactOpaqueRuns?: boolean;
}

/**
 * Redact every credential shape this project can hold.
 *
 * Order matters: literal known secrets first (they may be substrings of a
 * larger match), then userinfo, then prefixed credentials, then the labelled
 * and query forms that would otherwise consume a following token.
 */
export function redactSecretsV1(
  value: string,
  options: RedactSecretsOptionsV1 = {},
): string {
  if (!value) return value;
  let redacted = value;
  const knownSecrets = (options.knownSecrets ?? [])
    .map((secret) => (typeof secret === "string" ? secret.trim() : ""))
    // Longest first: a key that contains another key's prefix must not be
    // half-replaced into an unrecognisable remainder.
    .filter((secret) => secret.length >= 8)
    .sort((left, right) => right.length - left.length);
  for (const secret of knownSecrets) {
    redacted = redacted.split(secret).join(REDACTED_PLACEHOLDER_V1);
  }
  redacted = redacted
    .replace(URL_USERINFO_PATTERN_V1, `$1${REDACTED_PLACEHOLDER_V1}@`)
    .replace(BEARER_PATTERN_V1, `Bearer ${REDACTED_PLACEHOLDER_V1}`)
    .replace(PREFIXED_CREDENTIAL_PATTERN_V1, REDACTED_PLACEHOLDER_V1)
    .replace(LABELLED_SECRET_PATTERN_V1, `$1=${REDACTED_PLACEHOLDER_V1}`)
    .replace(QUERY_SECRET_PATTERN_V1, `$1${REDACTED_PLACEHOLDER_V1}`);
  if (options.redactOpaqueRuns) {
    redacted = redacted.replace(
      OPAQUE_CREDENTIAL_PATTERN_V1,
      REDACTED_PLACEHOLDER_V1,
    );
  }
  return redacted;
}

/**
 * The message of an error, redacted and bounded.
 *
 * Every seat that used to hand-roll `error instanceof Error ? … : "…"`
 * followed by its own two or three `replace` calls and a `slice` now calls
 * this, so the fallback text stays local while the redaction stays shared.
 */
export function redactedErrorMessageV1(
  error: unknown,
  fallback: string,
  maxChars: number,
  options: RedactSecretsOptionsV1 = {},
): string {
  const message = error instanceof Error ? error.message : fallback;
  return redactSecretsV1(message, options).slice(0, Math.max(0, maxChars));
}
