/**
 * The proof debt a vault answer owes before it may be written.
 *
 * A vault search returns paths, titles, scores, and a short snippet. That is
 * enough for a model to write a confident-sounding answer without ever opening
 * a note, and the host had no way to tell the difference: `planReadOnlyFollowups`
 * auto-read semantic hits only when the mission text happened to say "my notes"
 * or acceptance happened to already name vault evidence, and it never handled
 * `search_markdown_files` at all. A keyword-searched vault answer could be
 * written entirely from snippets.
 *
 * This module makes "did anyone actually read a note?" a first-class,
 * host-owned question:
 *
 *  - `extractVaultSearchResultPathsV1` reads the surfaced paths out of any
 *    vault search payload, semantic or keyword, in ranked order.
 *  - `evaluateVaultBodyReadDebtV1` compares what a search surfaced against what
 *    was actually read back, and reports the debt.
 *
 * The debt is deliberately tri-state rather than a boolean. "Nothing was
 * surfaced" and "several notes were surfaced and read" are both non-blocking,
 * but only the second is evidence. Collapsing them into one `true` is exactly
 * the vacuous-perfect-score hole that lets an ungrounded answer look grounded,
 * so callers get `vacuous` and must not report it as vault grounding.
 *
 * Pure and I/O-free so the same verdict replays identically from a durable
 * ledger.
 */

/** Vault searches whose results are candidate notes to open. */
export const VAULT_SEARCH_TOOL_NAMES_V1 = Object.freeze([
  "semantic_search_notes",
  "search_markdown_files",
  "find_related_notes",
] as const);

export type VaultSearchToolNameV1 =
  (typeof VAULT_SEARCH_TOOL_NAMES_V1)[number];

/** The acceptance token an unpaid vault body read contributes. */
export const VAULT_BODY_READ_PROOF_V1 = "vault_note_body_read";

/**
 * `vacuous` covers both "nothing was surfaced" and "everything surfaced was
 * tried and could not be opened". Neither is vault evidence, and neither may
 * block: a debt nothing can pay is a stranded mission, not a safeguard.
 */
export type VaultBodyReadStatusV1 = "paid" | "unpaid" | "vacuous";

export interface VaultBodyReadDebtV1 {
  status: VaultBodyReadStatusV1;
  /** False only when the answer must not be written yet. */
  satisfied: boolean;
  /** Acceptance tokens still owed. Empty unless `status` is `unpaid`. */
  missing: string[];
  surfacedCount: number;
  readCount: number;
  /** Surfaced-but-unread paths, best candidates first. */
  unreadPaths: string[];
  /**
   * True when this run produced real vault evidence: at least one note that a
   * search surfaced was opened and read. Never true for `vacuous`.
   */
  countsAsVaultEvidence: boolean;
  reason: string;
}

export function isVaultSearchToolNameV1(
  name: string,
): name is VaultSearchToolNameV1 {
  return (VAULT_SEARCH_TOOL_NAMES_V1 as readonly string[]).includes(name);
}

/**
 * Ranked markdown paths a vault search surfaced. Order is preserved because
 * these tools already rank by score, so the first entries are the ones worth
 * opening first.
 */
export function extractVaultSearchResultPathsV1(output: unknown): string[] {
  const payload = unwrapToolOutput(output);
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return [];
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const item of payload.results) {
    if (!isRecord(item)) continue;
    const path = typeof item.path === "string" ? item.path.trim() : "";
    if (!path.toLowerCase().endsWith(".md")) continue;
    const key = normalizeVaultPathV1(path);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
}

/**
 * Vault tools whose payload carries note bodies rather than search snippets.
 *
 * The distinction is the entire point of the debt. A search result and a read
 * receipt both name a path, so a caller that collects "every path this run
 * touched" pays the debt with the very search that created it and the gate
 * becomes a no-op.
 */
export const VAULT_BODY_READ_TOOL_NAMES_V1 = Object.freeze([
  "read_file",
  "read_current_file",
  "read_markdown_files",
  "inspect_vault_context",
] as const);

export type VaultBodyReadToolNameV1 =
  (typeof VAULT_BODY_READ_TOOL_NAMES_V1)[number];

export function isVaultBodyReadToolNameV1(
  name: string,
): name is VaultBodyReadToolNameV1 {
  return (VAULT_BODY_READ_TOOL_NAMES_V1 as readonly string[]).includes(name);
}

/**
 * Markdown paths whose body this read actually returned.
 *
 * Covers the single-note shape (`read_file`, `read_current_file`) and the
 * batch shape (`read_markdown_files`, `inspect_vault_context`), which also
 * reports what it could *not* open under `skipped`. A returned `content`
 * string is what separates the two, so a skipped note never counts.
 *
 * An empty `content` still counts: the note was opened and it was empty. That
 * is a truthful read, and refusing it would leave a mission whose only match is
 * an empty note owing a debt nothing can pay.
 */
export function extractVaultBodyReadPathsV1(output: unknown): string[] {
  const payload = unwrapToolOutput(output);
  if (!isRecord(payload)) {
    return [];
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  const take = (candidate: unknown): void => {
    if (!isRecord(candidate)) return;
    if (typeof candidate.content !== "string") return;
    const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
    if (!path.toLowerCase().endsWith(".md")) return;
    const key = normalizeVaultPathV1(path);
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(path);
  };
  take(payload);
  if (Array.isArray(payload.files)) {
    for (const file of payload.files) {
      take(file);
    }
  }
  return paths;
}

export function evaluateVaultBodyReadDebtV1(input: {
  surfacedPaths: readonly string[];
  readPaths: readonly string[];
  /** False for missions that owe no vault grounding at all. */
  requiresBodyRead: boolean;
  /** How many surfaced notes must be read. Clamped to what was surfaced. */
  minimumReads?: number;
  /**
   * Paths a read was actually attempted on, whether or not it succeeded.
   * Defaults to `readPaths`, so a caller that does not track attempts keeps
   * the previous behaviour exactly.
   *
   * This is what separates "nobody opened it" from "it could not be opened".
   * Only the first is a debt the run can still pay, and only the first may
   * hold a write.
   */
  attemptedPaths?: readonly string[];
}): VaultBodyReadDebtV1 {
  const surfaced = dedupeNormalized(input.surfacedPaths);
  const read = new Set(dedupeNormalized(input.readPaths).map(normalizeVaultPathV1));
  const attempted = new Set(
    dedupeNormalized(input.attemptedPaths ?? input.readPaths).map(
      normalizeVaultPathV1,
    ),
  );
  const readSurfaced = surfaced.filter((path) => read.has(normalizeVaultPathV1(path)));
  const unreadPaths = surfaced.filter(
    (path) => !read.has(normalizeVaultPathV1(path)),
  );

  if (!input.requiresBodyRead) {
    return {
      status: "paid",
      satisfied: true,
      missing: [],
      surfacedCount: surfaced.length,
      readCount: readSurfaced.length,
      unreadPaths,
      countsAsVaultEvidence: readSurfaced.length > 0,
      reason: "vault_body_read_not_required",
    };
  }

  if (surfaced.length === 0) {
    // Nothing to open. Reporting "no matching notes" is a legitimate answer and
    // must not be blocked -- but it is not vault evidence, and saying so is the
    // whole point of the tri-state.
    return {
      status: "vacuous",
      satisfied: true,
      missing: [],
      surfacedCount: 0,
      readCount: 0,
      unreadPaths: [],
      countsAsVaultEvidence: false,
      reason: "no_vault_results_surfaced",
    };
  }

  const required = Math.max(
    1,
    Math.min(
      surfaced.length,
      Math.trunc(
        typeof input.minimumReads === "number" &&
          Number.isFinite(input.minimumReads)
          ? input.minimumReads
          : 1,
      ) || 1,
    ),
  );

  if (readSurfaced.length >= required) {
    return {
      status: "paid",
      satisfied: true,
      missing: [],
      surfacedCount: surfaced.length,
      readCount: readSurfaced.length,
      unreadPaths,
      countsAsVaultEvidence: true,
      reason: "vault_note_bodies_read",
    };
  }

  if (unreadPaths.every((path) => attempted.has(normalizeVaultPathV1(path)))) {
    // Every surfaced note was tried and none of the tries returned a body.
    // There is no further tool call that would discharge this, so holding the
    // answer would only burn the step budget. Report it as non-evidence and
    // let the run finish saying what it actually had.
    return {
      status: "vacuous",
      satisfied: true,
      missing: [],
      surfacedCount: surfaced.length,
      readCount: readSurfaced.length,
      unreadPaths,
      countsAsVaultEvidence: readSurfaced.length > 0,
      reason: "vault_search_results_unreadable",
    };
  }

  return {
    status: "unpaid",
    satisfied: false,
    missing: [VAULT_BODY_READ_PROOF_V1],
    surfacedCount: surfaced.length,
    readCount: readSurfaced.length,
    unreadPaths,
    countsAsVaultEvidence: false,
    reason:
      readSurfaced.length === 0
        ? "vault_search_results_never_opened"
        : "vault_body_reads_below_minimum",
  };
}

/**
 * Vault paths are compared case-insensitively with separators normalized: the
 * same note reached through a search result and through a read receipt must
 * not look like two different notes and silently leave the debt unpaid.
 */
export function normalizeVaultPathV1(path: string): string {
  return path
    .trim()
    .split("\\")
    .join("/")
    .replace(/^\.[/]/u, "")
    .toLowerCase();
}

/**
 * The markdown paths a read tool was *asked* for, read off the call arguments
 * rather than the result, so a read that failed still counts as attempted.
 */
export function extractRequestedVaultReadPathsV1(
  args: Record<string, unknown> | undefined,
): string[] {
  if (!args) return [];
  const candidates: unknown[] = [args.path];
  if (Array.isArray(args.paths)) candidates.push(...args.paths);
  return dedupeNormalized(
    candidates.filter(
      (value): value is string =>
        typeof value === "string" && value.trim().toLowerCase().endsWith(".md"),
    ),
  );
}

function dedupeNormalized(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const path = raw.trim();
    if (!path) continue;
    const key = normalizeVaultPathV1(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

function unwrapToolOutput(value: unknown): unknown {
  return isRecord(value) && "output" in value ? value.output : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
