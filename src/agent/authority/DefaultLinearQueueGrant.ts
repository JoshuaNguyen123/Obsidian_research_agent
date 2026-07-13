import type { AuthorityGrantLimits, AuthorityGrantV1, AuthorityRule } from "./types";
import {
  createBoundedGrant,
  verifyAuthorityGrantFingerprint,
} from "./grants";

export const DEFAULT_LINEAR_QUEUE_GRANT_TTL_MS = 4 * 60 * 60_000;
export const DEFAULT_LINEAR_QUEUE_DAILY_TICKET_LIMIT = 25;

/**
 * The queue's separate durable daily-start ledger enforces the 25-ticket cap.
 * These ceilings are sized for that cap's bounded code path: four Linear
 * lifecycle mutations plus a maximum of 24 profile-scoped workspace,
 * validation, checkpoint, and verified-commit actions per code ticket. A
 * vault-note or code-file create consumes the same bounded create pool.
 */
export const DEFAULT_LINEAR_QUEUE_GRANT_LIMITS: Readonly<AuthorityGrantLimits> =
  Object.freeze({
    maxActions: DEFAULT_LINEAR_QUEUE_DAILY_TICKET_LIMIT * 28,
    maxExternalMutations: DEFAULT_LINEAR_QUEUE_DAILY_TICKET_LIMIT * 4,
    maxCreates: DEFAULT_LINEAR_QUEUE_DAILY_TICKET_LIMIT * 12,
    maxDeletes: 0,
    maxOutboundBytes: DEFAULT_LINEAR_QUEUE_DAILY_TICKET_LIMIT * 400_000,
  });

export type LinearQueueExecutionClass = "research" | "vault" | "code" | "human";

export interface CreateDefaultLinearQueueGrantInput {
  id: string;
  queueProjectId: string;
  /** Must be the literal true from the host's explicit approval path. */
  userApproved: true;
  trustedVaultPathPrefixes?: readonly string[];
  repositoryProfileIds?: readonly string[];
  issuedAt?: Date;
}

export interface MatchDefaultLinearQueueGrantInput {
  grant: AuthorityGrantV1;
  queueProjectId: string;
  executionClass: LinearQueueExecutionClass;
  /** Host-resolved vault target. Ticket text must never populate this value. */
  trustedVaultPath?: string;
  /** Host-resolved repository profile id. Ticket text must never populate this value. */
  repositoryProfileId?: string;
  /** Prepared payload estimate when available; one byte keeps exhaustion fail-closed. */
  requiredOutboundBytes?: number;
  now?: Date;
}

export type DefaultLinearQueueGrantMismatchReason =
  | "human_execution"
  | "invalid_candidate_binding"
  | "wrong_grant_kind"
  | "not_user_issued"
  | "inactive"
  | "invalid_fingerprint"
  | "invalid_ttl"
  | "not_yet_active"
  | "expired"
  | "subject_mismatch"
  | "unsafe_rule"
  | "linear_lifecycle_not_covered"
  | "vault_scope_not_covered"
  | "repository_scope_not_covered"
  | "invalid_budget"
  | "budget_exhausted";

export type DefaultLinearQueueGrantMatch =
  | {
      matched: true;
      grantId: string;
      subjectId: string;
      remaining: AuthorityGrantLimits;
    }
  | {
      matched: false;
      reason: DefaultLinearQueueGrantMismatchReason;
      detail: string;
    };

export async function createDefaultLinearQueueGrant(
  input: CreateDefaultLinearQueueGrantInput,
): Promise<AuthorityGrantV1> {
  if (input.userApproved !== true) {
    throw new TypeError("A default Linear queue grant requires explicit user approval.");
  }
  const id = expectOpaqueId(input.id, "Authority grant id");
  const queueProjectId = expectOpaqueId(
    input.queueProjectId,
    "Linear queue project id",
  );
  const trustedVaultPathPrefixes = normalizeUnique(
    input.trustedVaultPathPrefixes ?? [],
    normalizeTrustedVaultPath,
  );
  const repositoryProfileIds = normalizeUnique(
    input.repositoryProfileIds ?? [],
    normalizeRepositoryProfileId,
  );
  const issuedAt = input.issuedAt ?? new Date();
  if (!(issuedAt instanceof Date) || !Number.isFinite(issuedAt.getTime())) {
    throw new TypeError("Linear queue grant issuance time is invalid.");
  }

  const rules: AuthorityRule[] = [
    {
      system: "linear",
      resourceTypes: ["issue"],
      actions: ["update"],
      selector: { projectIds: [queueProjectId] },
    },
    {
      system: "linear",
      resourceTypes: ["comment"],
      actions: ["create"],
      selector: { projectIds: [queueProjectId] },
    },
  ];
  if (trustedVaultPathPrefixes.length > 0) {
    rules.push({
      system: "vault",
      resourceTypes: ["markdown"],
      actions: ["create", "append"],
      selector: { pathPrefixes: trustedVaultPathPrefixes },
    });
  }
  if (repositoryProfileIds.length > 0) {
    rules.push({
      system: "workspace",
      resourceTypes: ["code_workspace"],
      actions: ["create", "update", "append", "move"],
      selector: { repositoryProfileIds },
    });
    rules.push({
      system: "workspace",
      resourceTypes: ["validation_run"],
      actions: ["validate"],
      selector: { repositoryProfileIds },
    });
    rules.push({
      system: "workspace",
      resourceTypes: ["code_repair_checkpoint"],
      actions: ["update"],
      selector: { repositoryProfileIds },
    });
    rules.push({
      system: "git",
      resourceTypes: ["verified_local_commit"],
      actions: ["commit"],
      selector: { repositoryProfileIds },
    });
  }

  return createBoundedGrant({
    id,
    kind: "scheduled_bounded",
    subject: {
      type: "schedule",
      id: linearQueueGrantSubjectId(queueProjectId),
    },
    rules,
    limits: { ...DEFAULT_LINEAR_QUEUE_GRANT_LIMITS },
    issuer: "user_approval",
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + DEFAULT_LINEAR_QUEUE_GRANT_TTL_MS),
  });
}

export function linearQueueGrantSubjectId(queueProjectId: string): string {
  return `linear-queue-project:${expectOpaqueId(
    queueProjectId,
    "Linear queue project id",
  )}`;
}

/**
 * Matches a live grant to one queue candidate without consuming it. The host
 * must still authorize and consume each prepared action atomically at dispatch.
 */
export async function matchDefaultLinearQueueGrant(
  input: MatchDefaultLinearQueueGrantInput,
): Promise<DefaultLinearQueueGrantMatch> {
  if (input.executionClass === "human") {
    return mismatch("human_execution", "Human work is never queue-grant covered.");
  }

  let queueProjectId: string;
  let subjectId: string;
  let trustedVaultPath: string | undefined;
  let repositoryProfileId: string | undefined;
  let requiredOutboundBytes: number;
  try {
    queueProjectId = expectOpaqueId(input.queueProjectId, "Linear queue project id");
    subjectId = linearQueueGrantSubjectId(queueProjectId);
    trustedVaultPath = input.trustedVaultPath === undefined
      ? undefined
      : normalizeTrustedVaultPath(input.trustedVaultPath);
    repositoryProfileId = input.repositoryProfileId === undefined
      ? undefined
      : normalizeRepositoryProfileId(input.repositoryProfileId);
    requiredOutboundBytes = input.requiredOutboundBytes ?? 1;
    if (!Number.isSafeInteger(requiredOutboundBytes) || requiredOutboundBytes < 1) {
      throw new TypeError("Required outbound bytes must be a positive safe integer.");
    }
  } catch (error) {
    return mismatch("invalid_candidate_binding", errorMessage(error));
  }

  const { grant } = input;
  if (grant.kind !== "scheduled_bounded" || grant.subject.type !== "schedule") {
    return mismatch(
      "wrong_grant_kind",
      "Queue execution requires a scheduled_bounded schedule grant.",
    );
  }
  if (grant.issuer !== "user_approval") {
    return mismatch(
      "not_user_issued",
      "Queue execution requires authority issued by explicit user approval.",
    );
  }
  if (grant.state !== "active") {
    return mismatch("inactive", `Authority grant is ${grant.state}.`);
  }
  try {
    if (!(await verifyAuthorityGrantFingerprint(grant))) {
      return mismatch(
        "invalid_fingerprint",
        "Authority grant fingerprint does not match its immutable scope.",
      );
    }
  } catch {
    return mismatch(
      "invalid_fingerprint",
      "Authority grant cannot be canonically fingerprinted.",
    );
  }

  const issuedAt = canonicalTimestamp(grant.issuedAt);
  const expiresAt = canonicalTimestamp(grant.expiresAt);
  if (
    issuedAt === null ||
    expiresAt === null ||
    expiresAt - issuedAt !== DEFAULT_LINEAR_QUEUE_GRANT_TTL_MS
  ) {
    return mismatch("invalid_ttl", "Queue grants must have an exact four-hour TTL.");
  }
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return mismatch("invalid_candidate_binding", "Grant match time is invalid.");
  }
  if (now.getTime() < issuedAt) {
    return mismatch("not_yet_active", "Authority grant issuance time is in the future.");
  }
  if (now.getTime() >= expiresAt) {
    return mismatch("expired", "Authority grant has expired.");
  }
  if (grant.subject.id !== subjectId) {
    return mismatch(
      "subject_mismatch",
      "Authority grant belongs to a different Linear queue project.",
    );
  }

  if (!grant.rules.every((rule) => isSafeQueueRule(rule, queueProjectId))) {
    return mismatch(
      "unsafe_rule",
      "Authority grant contains an action or selector outside the default queue policy.",
    );
  }
  if (!hasLinearLifecycleCoverage(grant.rules, queueProjectId)) {
    return mismatch(
      "linear_lifecycle_not_covered",
      "Authority grant does not cover queue-project issue updates and comment creation.",
    );
  }
  if (
    input.executionClass === "vault" &&
    (!trustedVaultPath || !hasVaultCoverage(grant.rules, trustedVaultPath))
  ) {
    return mismatch(
      "vault_scope_not_covered",
      "Vault work requires a host-resolved path covered for create and append.",
    );
  }
  if (
    input.executionClass === "code" &&
    (!repositoryProfileId || !hasRepositoryCoverage(grant.rules, repositoryProfileId))
  ) {
    return mismatch(
      "repository_scope_not_covered",
      "Code work requires a host-resolved repository profile covered for bounded editing, sandbox validation, repair receipts, and one verified local commit.",
    );
  }

  const remaining = remainingBudget(grant);
  if (!remaining) {
    return mismatch(
      "invalid_budget",
      "Authority grant limits or usage are invalid or exceed queue ceilings.",
    );
  }
  const required = requiredBudget(
    input.executionClass,
    requiredOutboundBytes,
  );
  const exhausted = firstInsufficientBudget(remaining, required);
  if (exhausted) {
    return mismatch(
      "budget_exhausted",
      `Authority grant lacks remaining ${exhausted} budget for this candidate.`,
    );
  }

  return {
    matched: true,
    grantId: grant.id,
    subjectId,
    remaining,
  };
}

function isSafeQueueRule(rule: AuthorityRule, queueProjectId: string): boolean {
  if (rule.system === "linear") {
    if (!hasExactSelectorKeys(rule, ["projectIds"])) return false;
    if (!sameValues(rule.selector.projectIds, [queueProjectId])) return false;
    return (
      (sameValues(rule.resourceTypes, ["issue"]) &&
        sameValues(rule.actions, ["update"])) ||
      (sameValues(rule.resourceTypes, ["comment"]) &&
        sameValues(rule.actions, ["create"]))
    );
  }
  if (rule.system === "vault") {
    if (!hasExactSelectorKeys(rule, ["pathPrefixes"])) return false;
    if (!sameValues(rule.resourceTypes, ["markdown"])) return false;
    if (!sameValues(rule.actions, ["create", "append"])) return false;
    const prefixes = rule.selector.pathPrefixes;
    return (
      Array.isArray(prefixes) &&
      prefixes.length > 0 &&
      prefixes.every((prefix) => {
        try {
          return normalizeTrustedVaultPath(prefix) === prefix;
        } catch {
          return false;
        }
      }) &&
      new Set(prefixes).size === prefixes.length
    );
  }
  if (rule.system === "workspace") {
    if (!hasExactSelectorKeys(rule, ["repositoryProfileIds"])) return false;
    const safeShape =
      (sameValues(rule.resourceTypes, ["code_workspace"]) &&
        sameValues(rule.actions, ["create", "update", "append", "move"])) ||
      (sameValues(rule.resourceTypes, ["validation_run"]) &&
        sameValues(rule.actions, ["validate"])) ||
      (sameValues(rule.resourceTypes, ["code_repair_checkpoint"]) &&
        sameValues(rule.actions, ["update"]));
    if (!safeShape) return false;
    return hasSafeRepositoryProfileSelector(rule);
  }
  if (rule.system === "git") {
    if (!hasExactSelectorKeys(rule, ["repositoryProfileIds"])) return false;
    if (!sameValues(rule.resourceTypes, ["verified_local_commit"])) return false;
    if (!sameValues(rule.actions, ["commit"])) return false;
    return hasSafeRepositoryProfileSelector(rule);
  }
  return false;
}

function hasSafeRepositoryProfileSelector(rule: AuthorityRule): boolean {
  const ids = rule.selector.repositoryProfileIds;
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.every((id) => {
      try {
        return normalizeRepositoryProfileId(id) === id;
      } catch {
        return false;
      }
    }) &&
    new Set(ids).size === ids.length
  );
}

function hasLinearLifecycleCoverage(
  rules: AuthorityRule[],
  queueProjectId: string,
): boolean {
  return (
    rules.some(
      (rule) =>
        rule.system === "linear" &&
        rule.resourceTypes.includes("issue") &&
        rule.actions.includes("update") &&
        sameValues(rule.selector.projectIds, [queueProjectId]),
    ) &&
    rules.some(
      (rule) =>
        rule.system === "linear" &&
        rule.resourceTypes.includes("comment") &&
        rule.actions.includes("create") &&
        sameValues(rule.selector.projectIds, [queueProjectId]),
    )
  );
}

function hasVaultCoverage(rules: AuthorityRule[], trustedVaultPath: string): boolean {
  return rules.some(
    (rule) =>
      rule.system === "vault" &&
      rule.resourceTypes.includes("markdown") &&
      rule.actions.includes("create") &&
      rule.actions.includes("append") &&
      rule.selector.pathPrefixes?.some((prefix) =>
        pathHasPrefix(trustedVaultPath, prefix),
      ) === true,
  );
}

function hasRepositoryCoverage(
  rules: AuthorityRule[],
  repositoryProfileId: string,
): boolean {
  const covered = (
    system: "workspace" | "git",
    resourceType: string,
    action: AuthorityRule["actions"][number],
  ) =>
    rules.some(
      (rule) =>
        rule.system === system &&
        rule.resourceTypes.includes(resourceType) &&
        rule.actions.includes(action) &&
        rule.selector.repositoryProfileIds?.includes(repositoryProfileId) === true,
    );
  return (
    covered("workspace", "code_workspace", "create") &&
    covered("workspace", "code_workspace", "update") &&
    covered("workspace", "validation_run", "validate") &&
    covered("workspace", "code_repair_checkpoint", "update") &&
    covered("git", "verified_local_commit", "commit")
  );
}

function remainingBudget(grant: AuthorityGrantV1): AuthorityGrantLimits | null {
  type UsageCounterKey =
    | "actions"
    | "externalMutations"
    | "creates"
    | "deletes"
    | "outboundBytes";
  const fields: Array<
    [keyof AuthorityGrantLimits, UsageCounterKey]
  > = [
    ["maxActions", "actions"],
    ["maxExternalMutations", "externalMutations"],
    ["maxCreates", "creates"],
    ["maxDeletes", "deletes"],
    ["maxOutboundBytes", "outboundBytes"],
  ];
  const remaining = {} as AuthorityGrantLimits;
  for (const [limitKey, usageKey] of fields) {
    const limit = grant.limits[limitKey];
    const usage = grant.usage[usageKey];
    const ceiling = DEFAULT_LINEAR_QUEUE_GRANT_LIMITS[limitKey];
    if (
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      limit > ceiling ||
      !Number.isSafeInteger(usage) ||
      usage < 0 ||
      usage > limit
    ) {
      return null;
    }
    remaining[limitKey] = limit - usage;
  }
  if (grant.limits.maxDeletes !== 0 || grant.usage.deletes !== 0) {
    return null;
  }
  if (
    grant.usage.lastUsedAt !== undefined &&
    canonicalTimestamp(grant.usage.lastUsedAt) === null
  ) {
    return null;
  }
  return remaining;
}

function requiredBudget(
  executionClass: Exclude<LinearQueueExecutionClass, "human">,
  outboundBytes: number,
): AuthorityGrantLimits {
  const localActions = executionClass === "vault" ? 1 : executionClass === "code" ? 24 : 0;
  return {
    // Claim comment, started update, result comment, and completed/blocked update.
    maxActions: 4 + localActions,
    maxExternalMutations: 4,
    // Two lifecycle comments plus a possible vault create.
    maxCreates: 2 + (executionClass === "vault" ? 1 : 0),
    maxDeletes: 0,
    maxOutboundBytes: outboundBytes,
  };
}

function firstInsufficientBudget(
  remaining: AuthorityGrantLimits,
  required: AuthorityGrantLimits,
): keyof AuthorityGrantLimits | null {
  for (const key of Object.keys(required) as Array<keyof AuthorityGrantLimits>) {
    if (remaining[key] < required[key]) return key;
  }
  return null;
}

function hasExactSelectorKeys(rule: AuthorityRule, expected: string[]): boolean {
  return sameValues(Object.keys(rule.selector), expected);
}

function sameValues<T extends string>(
  actual: readonly T[] | undefined,
  expected: readonly T[],
): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

function pathHasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function normalizeTrustedVaultPath(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("Trusted vault path must be a string.");
  }
  const normalized = value.trim().replace(/\/$/, "");
  const parts = normalized.split("/");
  const first = parts[0]?.toLowerCase();
  if (
    !normalized ||
    normalized.length > 500 ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    /^[a-zA-Z]:/.test(normalized) ||
    /[\0\r\n]/.test(normalized) ||
    parts.some((part) => !part || part === "." || part === "..") ||
    first === ".obsidian" ||
    first === ".git" ||
    first === ".trash" ||
    first === ".agent-backups"
  ) {
    throw new TypeError("Trusted vault path must be a safe vault-relative path.");
  }
  return normalized;
}

function normalizeRepositoryProfileId(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value) ||
    value === "__proto__" ||
    value === "prototype" ||
    value === "constructor"
  ) {
    throw new TypeError("Repository profile id is invalid.");
  }
  return value;
}

function expectOpaqueId(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function normalizeUnique(
  values: readonly string[],
  normalize: (value: string) => string,
): string[] {
  if (!Array.isArray(values) || values.length > 256) {
    throw new TypeError("Queue grant selector exceeds its bounded entry count.");
  }
  const normalized = values.map(normalize);
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("Queue grant selectors must not contain duplicates.");
  }
  return normalized;
}

function canonicalTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function mismatch(
  reason: DefaultLinearQueueGrantMismatchReason,
  detail: string,
): DefaultLinearQueueGrantMatch {
  return { matched: false, reason, detail };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
