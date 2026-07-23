/**
 * Set-loose Linear create recovery after ambiguous apply / reconciliation.
 *
 * When `linear_create_issue` may have applied but returns
 * `mutation_reconciliation_required` / uncertain readback, search Linear by
 * the intended title (and optional team) before blocking Continue.
 *
 * // INTEGRATOR (AgentRunner): After `executePreparedToolWithMetrics` for
 * // `linear_create_issue`, when set-loose is enabled and
 * // `needsLinearCreateReconciliationRecovery(result)` is true, call
 * // `recoverLinearCreateAfterReconciliation` with title/teamId from the
 * // prepared action args and a host `searchByTitle` that wraps
 * // `linear_search_issues` / `linear_list_issues` (see COMPOUND-REAL
 * // `findLinearIssueUrlByTitle`). On `recovered`, synthesize a successful
 * // tool result from `receipt` and clear the reconcile blocker; on failure,
 * // keep fail-closed (do not invent an issue or Node-create a replacement).
 */

export const LINEAR_CREATE_RECONCILE_ERROR_CODES = [
  "mutation_reconciliation_required",
  "linear_mutation_uncertain",
  "linear_readback_failed",
] as const;

export type LinearCreateReconcileErrorCode =
  (typeof LINEAR_CREATE_RECONCILE_ERROR_CODES)[number];

export type LinearTitleSearchQuery = {
  title: string;
  teamId?: string;
};

export type LinearTitleSearchResult = {
  found: boolean;
  issueId?: string;
  issueUrl?: string;
  identifier?: string;
};

export type LinearCreateReconcileRecoverReceipt = {
  ok: true;
  issueId?: string;
  issueUrl?: string;
  identifier?: string;
  recoveredBy: "title_search";
};

export type LinearCreateReconcileRecoverResult = {
  recovered: boolean;
  receipt?: LinearCreateReconcileRecoverReceipt;
  reason?: string;
};

export type LinearTitleSearchHit = {
  title?: unknown;
  name?: unknown;
  id?: unknown;
  issueId?: unknown;
  url?: unknown;
  issueUrl?: unknown;
  identifier?: unknown;
  attributes?: { url?: unknown } | null;
  issue?: {
    id?: unknown;
    url?: unknown;
    identifier?: unknown;
    title?: unknown;
  } | null;
};

/** True when a linear_create_issue result is an ambiguous-apply / reconcile blocker. */
export function needsLinearCreateReconciliationRecovery(input: {
  toolName?: string;
  ok?: boolean;
  mutationState?: string | null;
  errorCode?: string | null;
  reconcileOutcome?: string | null;
}): boolean {
  const toolName = (input.toolName ?? "linear_create_issue").trim();
  if (toolName !== "linear_create_issue") {
    return false;
  }
  if (input.ok === true && input.mutationState === "applied") {
    return false;
  }
  if (input.mutationState === "not_applied") {
    return false;
  }

  const code = (input.errorCode ?? "").trim();
  if (
    (LINEAR_CREATE_RECONCILE_ERROR_CODES as readonly string[]).includes(code)
  ) {
    return true;
  }
  if (input.reconcileOutcome === "still_uncertain") {
    return true;
  }
  if (input.mutationState === "may_have_applied") {
    return true;
  }
  return false;
}

/**
 * Pick at most one issue whose title equals (or contains) the intended title.
 * Zero or multiple matches fail closed — never invent an identity.
 */
export function matchLinearIssueByTitle(
  hits: readonly LinearTitleSearchHit[],
  title: string,
): LinearTitleSearchResult & { reason?: string } {
  const wanted = title.trim();
  if (!wanted) {
    return {
      found: false,
      reason: "Cannot recover Linear create: title is empty.",
    };
  }

  const matches = hits
    .map((hit) => normalizeSearchHit(hit))
    .filter((hit): hit is NormalizedHit => hit !== null)
    .filter((hit) => {
      return hit.title === wanted || hit.title.includes(wanted);
    });

  const exact = matches.filter((hit) => hit.title === wanted);
  const candidates = exact.length > 0 ? exact : matches;

  if (candidates.length === 0) {
    return {
      found: false,
      reason: `No Linear issue found with title matching "${wanted}".`,
    };
  }
  if (candidates.length > 1) {
    return {
      found: false,
      reason: `Ambiguous Linear title search: ${candidates.length} issues match "${wanted}".`,
    };
  }

  const only = candidates[0]!;
  if (!only.issueId && !only.issueUrl) {
    return {
      found: false,
      reason: `Linear title search matched "${wanted}" but returned no issue id or URL.`,
    };
  }

  return {
    found: true,
    ...(only.issueId ? { issueId: only.issueId } : {}),
    ...(only.issueUrl ? { issueUrl: only.issueUrl } : {}),
    ...(only.identifier ? { identifier: only.identifier } : {}),
  };
}

/**
 * Host-search recovery after `linear_create_issue` reconciliation / ambiguous apply.
 * Pure helper: the caller gates set-loose and supplies `searchByTitle`.
 */
export async function recoverLinearCreateAfterReconciliation(input: {
  title: string;
  teamId?: string;
  searchByTitle: (
    query: LinearTitleSearchQuery,
  ) => Promise<LinearTitleSearchResult>;
  /** Optional original tool error code / outcome for clearer fail-closed reasons. */
  errorCode?: string;
  reconcileOutcome?: string;
}): Promise<LinearCreateReconcileRecoverResult> {
  const title = input.title.trim();
  if (!title) {
    return {
      recovered: false,
      reason: "Cannot recover Linear create: title is empty.",
    };
  }

  const teamId =
    typeof input.teamId === "string" && input.teamId.trim()
      ? input.teamId.trim()
      : undefined;

  let search: LinearTitleSearchResult;
  try {
    search = await input.searchByTitle({ title, ...(teamId ? { teamId } : {}) });
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "Linear title search failed.";
    return {
      recovered: false,
      reason: `Cannot recover Linear create by title search: ${message}`,
    };
  }

  if (!search?.found) {
    const codeHint = formatBlockerHint(input.errorCode, input.reconcileOutcome);
    return {
      recovered: false,
      reason:
        `Linear create remains unresolved after title search for "${title}"` +
        (teamId ? ` (team ${teamId})` : "") +
        `${codeHint}. Issue was not found; refusing to invent a receipt.`,
    };
  }

  const issueId =
    typeof search.issueId === "string" && search.issueId.trim()
      ? search.issueId.trim()
      : undefined;
  const issueUrl =
    typeof search.issueUrl === "string" && search.issueUrl.trim()
      ? search.issueUrl.trim()
      : undefined;
  const identifier =
    typeof search.identifier === "string" && search.identifier.trim()
      ? search.identifier.trim()
      : undefined;

  if (!issueId && !issueUrl) {
    return {
      recovered: false,
      reason:
        `Linear title search claimed a match for "${title}" without an issue id or URL. ` +
        "Refusing to invent a receipt.",
    };
  }

  if (issueUrl && !/^https:\/\/linear\.app\//iu.test(issueUrl)) {
    return {
      recovered: false,
      reason:
        `Linear title search returned a non-Linear URL for "${title}". ` +
        "Refusing to invent a receipt.",
    };
  }

  return {
    recovered: true,
    receipt: {
      ok: true,
      ...(issueId ? { issueId } : {}),
      ...(issueUrl ? { issueUrl } : {}),
      ...(identifier ? { identifier } : {}),
      recoveredBy: "title_search",
    },
  };
}

type NormalizedHit = {
  title: string;
  issueId?: string;
  issueUrl?: string;
  identifier?: string;
};

function normalizeSearchHit(hit: LinearTitleSearchHit): NormalizedHit | null {
  const title = firstNonEmptyString(
    hit.title,
    hit.name,
    hit.issue?.title,
  );
  if (!title) return null;

  const issueId = firstNonEmptyString(hit.issueId, hit.id, hit.issue?.id);
  const issueUrl = firstNonEmptyString(
    hit.issueUrl,
    hit.url,
    hit.issue?.url,
    hit.attributes?.url,
  );
  const identifier = firstNonEmptyString(
    hit.identifier,
    hit.issue?.identifier,
  );

  return {
    title,
    ...(issueId ? { issueId } : {}),
    ...(issueUrl ? { issueUrl } : {}),
    ...(identifier ? { identifier } : {}),
  };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function formatBlockerHint(
  errorCode?: string,
  reconcileOutcome?: string,
): string {
  const parts: string[] = [];
  if (typeof errorCode === "string" && errorCode.trim()) {
    parts.push(`error=${errorCode.trim()}`);
  }
  if (typeof reconcileOutcome === "string" && reconcileOutcome.trim()) {
    parts.push(`outcome=${reconcileOutcome.trim()}`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}
