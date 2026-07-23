/**
 * Optional AuthorityGrantV1 minting for an approved bundled Bound preview.
 *
 * The host-side BundledStageGrantV1 (fingerprint families) is enough to skip
 * Chat Approve for related Bound steps. When concrete Linear team / GitHub
 * repository selectors are already known at preview time, also mint a
 * run_bounded AuthorityGrantV1 so prepared-action evaluate/consume paths can
 * bind to the same user approval.
 *
 * Hard / delete actions are never included in the rules.
 */

import type { BundledApprovalPreviewV1 } from "../bundledApprovalPreview";
import { createBoundedGrant } from "./grants";
import type {
  AuthorityGrantLimits,
  AuthorityGrantV1,
  AuthorityRule,
  AuthoritySelector,
} from "./types";

export const BUNDLED_COMPOUND_AUTHORITY_GRANT_LIMITS: Readonly<AuthorityGrantLimits> =
  Object.freeze({
    maxActions: 48,
    maxExternalMutations: 24,
    maxCreates: 16,
    maxDeletes: 0,
    maxOutboundBytes: 2_000_000,
  });

export interface CreateBundledCompoundAuthorityGrantInput {
  id: string;
  preview: BundledApprovalPreviewV1;
  /** Must be the literal true from the host's explicit approval path. */
  userApproved: true;
  /** Host-resolved Linear team id (ticket text must never populate this). */
  teamId?: string;
  /** Host-resolved Linear project id. */
  projectId?: string;
  /** Host-resolved repository profile id. */
  repositoryProfileId?: string;
  /** Trusted vault path prefixes for note replace companions. */
  trustedVaultPathPrefixes?: readonly string[];
  issuedAt?: Date;
  limits?: AuthorityGrantLimits;
}

/**
 * Mint a run_bounded AuthorityGrant covering Bound Linear / GitHub / vault
 * families from an approved bundle. Returns null when no concrete external
 * selector is available yet (caller should still keep BundledStageGrantV1).
 */
export async function createBundledCompoundAuthorityGrant(
  input: CreateBundledCompoundAuthorityGrantInput,
): Promise<AuthorityGrantV1 | null> {
  if (input.userApproved !== true) {
    throw new TypeError(
      "Bundled compound authority grant requires explicit user approval.",
    );
  }
  const rules = buildBundledCompoundRules(input);
  if (rules.length === 0) {
    return null;
  }
  const issuedAt = input.issuedAt ?? new Date();
  return createBoundedGrant({
    id: input.id,
    kind: "run_bounded",
    subject: { type: "run", id: input.preview.runId },
    rules,
    limits: { ...(input.limits ?? BUNDLED_COMPOUND_AUTHORITY_GRANT_LIMITS) },
    issuer: "user_approval",
    issuedAt,
    expiresAt: new Date(Date.parse(input.preview.expiresAt)),
  });
}

function buildBundledCompoundRules(
  input: CreateBundledCompoundAuthorityGrantInput,
): AuthorityRule[] {
  const families = new Set(input.preview.items.map((item) => item.familyId));
  const rules: AuthorityRule[] = [];

  const linearSelector = compactSelector({
    teamIds: optionalSingleton(input.teamId),
    projectIds: optionalSingleton(input.projectId),
  });
  if (
    (families.has("linear_publish") || families.has("linear_issues")) &&
    hasConcreteSelector(linearSelector)
  ) {
    if (families.has("linear_publish") || families.has("linear_issues")) {
      rules.push({
        system: "linear",
        resourceTypes: ["issue", "project", "initiative", "comment"],
        actions: ["create", "update", "publish", "link", "read", "list", "search"],
        selector: linearSelector,
      });
    }
  }

  const githubSelector = compactSelector({
    repositoryProfileIds: optionalSingleton(input.repositoryProfileId),
  });
  if (families.has("github_publish") && hasConcreteSelector(githubSelector)) {
    rules.push({
      system: "github",
      resourceTypes: ["repository", "pull_request", "branch"],
      actions: ["create", "publish", "update", "read", "list"],
      selector: githubSelector,
    });
  }

  const vaultPrefixes = normalizePrefixes(input.trustedVaultPathPrefixes ?? []);
  if (families.has("vault_replace") && vaultPrefixes.length > 0) {
    rules.push({
      system: "vault",
      resourceTypes: ["markdown_file"],
      actions: ["replace", "append", "read"],
      selector: { pathPrefixes: vaultPrefixes },
    });
  }

  // Workspace / git Bound families stay on BundledStageGrantV1 until sandbox
  // preparation produces exact prepared-action fingerprints.
  return rules;
}

function compactSelector(selector: AuthoritySelector): AuthoritySelector {
  return Object.fromEntries(
    Object.entries(selector).filter(([, values]) => values !== undefined),
  ) as AuthoritySelector;
}

function optionalSingleton(value: string | undefined): string[] | undefined {
  const trimmed = value?.trim();
  return trimmed ? [trimmed] : undefined;
}

function hasConcreteSelector(selector: AuthoritySelector): boolean {
  return Object.values(selector).some(
    (values) => Array.isArray(values) && values.some((value) => value.trim()),
  );
}

function normalizePrefixes(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim())
        .filter(Boolean),
    ),
  ];
}
