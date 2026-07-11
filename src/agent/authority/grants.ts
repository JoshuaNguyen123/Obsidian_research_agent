import {
  canonicalJson,
  sha256Fingerprint,
  verifyPreparedActionFingerprint,
  type PreparedAction,
  type ResourceRef,
  type ToolDescriptor,
} from "../actions";
import type {
  AuthorityEvaluation,
  AuthorityEvaluationInput,
  AuthorityGrantLimits,
  AuthorityGrantUsage,
  AuthorityGrantV1,
  AuthorityRule,
  AuthoritySelector,
  BoundedGrantInput,
  OneShotGrantInput,
} from "./types";

const DEFAULT_GRANT_TTL_MS = 5 * 60_000;
const READ_ACTIONS = new Set(["read", "list", "search"]);
const EXTERNAL_MUTATION_SYSTEMS = new Set(["linear", "github", "browser"]);

export async function createOneShotGrant({
  id,
  action,
  descriptor,
  issuer = "user_approval",
  issuedAt = new Date(),
  expiresAt,
}: OneShotGrantInput): Promise<AuthorityGrantV1> {
  assertDescriptorMatchesAction(descriptor, action);
  if (!descriptor.approval.allowPromptGrant) {
    throw new TypeError("This tool descriptor does not permit one-shot approval grants.");
  }
  if (!(await verifyPreparedActionFingerprint(action))) {
    throw new TypeError("Cannot grant authority to a tampered prepared action.");
  }
  const actionExpiry = new Date(action.expiresAt);
  const resolvedExpiry =
    expiresAt ??
    new Date(
      Math.min(
        issuedAt.getTime() + DEFAULT_GRANT_TTL_MS,
        actionExpiry.getTime(),
      ),
    );
  const cost = actionCost(action, descriptor);
  return finalizeGrant({
    version: 1,
    id,
    kind: "one_shot",
    issuer,
    subject: { type: "run", id: action.runId },
    rules: [
      {
        system: descriptor.capability.system,
        resourceTypes: [descriptor.capability.resourceType],
        actions: [descriptor.capability.action],
        selector: selectorForResource(action.target),
      },
    ],
    actionFingerprint: action.payloadFingerprint,
    limits: {
      maxActions: 1,
      maxExternalMutations: cost.externalMutations,
      maxCreates: cost.creates,
      maxDeletes: cost.deletes,
      maxOutboundBytes: cost.outboundBytes,
    },
    usage: emptyUsage(),
    state: "active",
    issuedAt: issuedAt.toISOString(),
    expiresAt: resolvedExpiry.toISOString(),
  });
}

export async function createBoundedGrant({
  id,
  kind,
  subject,
  rules,
  limits,
  issuer = "user_approval",
  issuedAt = new Date(),
  expiresAt = new Date(issuedAt.getTime() + DEFAULT_GRANT_TTL_MS),
}: BoundedGrantInput): Promise<AuthorityGrantV1> {
  if (
    (kind === "run_bounded" && subject.type !== "run") ||
    (kind === "scheduled_bounded" && subject.type !== "schedule")
  ) {
    throw new TypeError("Grant kind and subject type must agree.");
  }
  for (const rule of rules) {
    if (
      EXTERNAL_MUTATION_SYSTEMS.has(rule.system) &&
      rule.actions.some((action) => !READ_ACTIONS.has(action)) &&
      !hasConcreteSelector(rule.selector)
    ) {
      throw new TypeError(
        `External mutation authority for ${rule.system} requires a bounded selector.`,
      );
    }
  }
  return finalizeGrant({
    version: 1,
    id,
    kind,
    issuer,
    subject,
    rules: cloneJson(rules),
    limits: { ...limits },
    usage: emptyUsage(),
    state: "active",
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
}

export async function computeAuthorityGrantFingerprint(
  grant: Omit<AuthorityGrantV1, "authorityFingerprint"> | AuthorityGrantV1,
): Promise<string> {
  return sha256Fingerprint({
    version: grant.version,
    id: grant.id,
    kind: grant.kind,
    issuer: grant.issuer,
    subject: grant.subject,
    rules: grant.rules,
    actionFingerprint: grant.actionFingerprint ?? null,
    limits: grant.limits,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  });
}

export async function verifyAuthorityGrantFingerprint(
  grant: AuthorityGrantV1,
): Promise<boolean> {
  return (
    grant.authorityFingerprint ===
    (await computeAuthorityGrantFingerprint(grant))
  );
}

export async function evaluateAuthorityGrant({
  grant,
  action,
  descriptor,
  subject = { type: "run", id: action.runId },
  now = new Date(),
}: AuthorityEvaluationInput): Promise<AuthorityEvaluation> {
  if (grant.state !== "active") {
    return denied(`Authority grant is ${grant.state}.`);
  }
  if (!isValidDate(grant.expiresAt) || now.getTime() >= Date.parse(grant.expiresAt)) {
    return denied("Authority grant has expired.");
  }
  try {
    if (!(await verifyAuthorityGrantFingerprint(grant))) {
      return denied("Authority grant fingerprint is invalid.");
    }
    if (!(await verifyPreparedActionFingerprint(action))) {
      return denied("Prepared action fingerprint is invalid.");
    }
  } catch {
    return denied("Authority grant or prepared action cannot be canonically verified.");
  }
  if (!isValidDate(action.expiresAt) || now.getTime() >= Date.parse(action.expiresAt)) {
    return denied("Prepared action has expired.");
  }
  try {
    assertDescriptorMatchesAction(descriptor, action);
  } catch (error) {
    return denied(error instanceof Error ? error.message : String(error));
  }
  if (grant.subject.type !== subject.type || grant.subject.id !== subject.id) {
    return denied("Authority grant subject does not match this execution.");
  }
  if (
    grant.actionFingerprint !== undefined &&
    grant.actionFingerprint !== action.payloadFingerprint
  ) {
    return denied("Authority grant is bound to a different prepared action.");
  }
  if (!grant.rules.some((rule) => ruleMatches(rule, action, descriptor))) {
    return denied("Prepared action is outside the authority grant scope.");
  }

  const cost = actionCost(action, descriptor);
  const exceeded = firstExceededLimit(grant.limits, grant.usage, cost);
  if (exceeded) {
    return denied(`Authority grant limit exceeded: ${exceeded}.`);
  }
  return { allowed: true, grant: cloneJson(grant) };
}

export async function consumeAuthorityGrant(
  input: AuthorityEvaluationInput,
): Promise<AuthorityEvaluation> {
  const evaluation = await evaluateAuthorityGrant(input);
  if (!evaluation.allowed) {
    return evaluation;
  }
  const now = input.now ?? new Date();
  const cost = actionCost(input.action, input.descriptor);
  const grant = cloneJson(evaluation.grant);
  grant.usage = {
    actions: grant.usage.actions + cost.actions,
    externalMutations:
      grant.usage.externalMutations + cost.externalMutations,
    creates: grant.usage.creates + cost.creates,
    deletes: grant.usage.deletes + cost.deletes,
    outboundBytes: grant.usage.outboundBytes + cost.outboundBytes,
    lastUsedAt: now.toISOString(),
  };
  if (grant.kind === "one_shot" || grant.usage.actions >= grant.limits.maxActions) {
    grant.state = "exhausted";
  }
  return { allowed: true, grant };
}

export function revokeAuthorityGrant(
  grant: AuthorityGrantV1,
  revokedAt = new Date(),
): AuthorityGrantV1 {
  const revoked = cloneJson(grant);
  revoked.state = "revoked";
  revoked.revokedAt = revokedAt.toISOString();
  return revoked;
}

function finalizeGrant(
  grant: Omit<AuthorityGrantV1, "authorityFingerprint">,
): Promise<AuthorityGrantV1> {
  assertGrantShape(grant);
  return computeAuthorityGrantFingerprint(grant).then((authorityFingerprint) => ({
    ...grant,
    authorityFingerprint,
  }));
}

function assertGrantShape(
  grant: Omit<AuthorityGrantV1, "authorityFingerprint">,
): void {
  if (!grant.id.trim() || !grant.subject.id.trim() || grant.rules.length === 0) {
    throw new TypeError("Authority grant id, subject, and rules are required.");
  }
  if (
    !isValidDate(grant.issuedAt) ||
    !isValidDate(grant.expiresAt) ||
    Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)
  ) {
    throw new TypeError("Authority grant expiry must be after issuance.");
  }
  for (const [key, value] of Object.entries(grant.limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Authority grant limit ${key} must be a non-negative integer.`);
    }
  }
  if (grant.limits.maxActions < 1) {
    throw new TypeError("Authority grant maxActions must be at least 1.");
  }
  for (const rule of grant.rules) {
    if (rule.resourceTypes.length === 0 || rule.actions.length === 0) {
      throw new TypeError("Authority rules require resource types and actions.");
    }
  }
}

function assertDescriptorMatchesAction(
  descriptor: ToolDescriptor,
  action: PreparedAction,
): void {
  if (
    descriptor.version !== 1 ||
    descriptor.name !== action.toolName ||
    descriptor.capability.system !== action.target.system ||
    descriptor.capability.resourceType !== action.target.resourceType
  ) {
    throw new TypeError("Tool descriptor does not match the prepared action target.");
  }
  if (
    !Number.isSafeInteger(action.preview.outboundBytes) ||
    action.preview.outboundBytes < 0
  ) {
    throw new TypeError("Prepared action outbound byte count is invalid.");
  }
}

function selectorForResource(resource: ResourceRef): AuthoritySelector {
  return compactSelector({
    resourceIds: [resource.id],
    accountIds: optionalSingleton(resource.accountId),
    workspaceIds: optionalSingleton(resource.workspaceId),
    teamIds: optionalSingleton(resource.teamId),
    projectIds: optionalSingleton(resource.projectId),
    repositoryIds: optionalSingleton(resource.repositoryId),
    repositoryProfileIds: optionalSingleton(resource.repositoryProfileId),
    containerIds: optionalSingleton(resource.containerId),
    pathPrefixes: optionalSingleton(resource.path),
  });
}

function ruleMatches(
  rule: AuthorityRule,
  action: PreparedAction,
  descriptor: ToolDescriptor,
): boolean {
  return (
    rule.system === descriptor.capability.system &&
    rule.resourceTypes.includes(descriptor.capability.resourceType) &&
    rule.actions.includes(descriptor.capability.action) &&
    selectorMatches(rule.selector, action.target)
  );
}

function selectorMatches(selector: AuthoritySelector, resource: ResourceRef): boolean {
  const exact: Array<[string[] | undefined, string | undefined]> = [
    [selector.accountIds, resource.accountId],
    [selector.workspaceIds, resource.workspaceId],
    [selector.teamIds, resource.teamId],
    [selector.projectIds, resource.projectId],
    [selector.repositoryIds, resource.repositoryId],
    [selector.repositoryProfileIds, resource.repositoryProfileId],
    [selector.containerIds, resource.containerId],
    [selector.resourceIds, resource.id],
  ];
  if (
    exact.some(
      ([allowed, actual]) =>
        allowed !== undefined &&
        (actual === undefined || !allowed.includes(actual)),
    )
  ) {
    return false;
  }
  if (selector.pathPrefixes !== undefined) {
    if (
      resource.path === undefined ||
      !selector.pathPrefixes.some((prefix) => pathHasPrefix(resource.path!, prefix))
    ) {
      return false;
    }
  }
  return true;
}

function pathHasPrefix(path: string, prefix: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const normalizedPrefix = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return (
    normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(`${normalizedPrefix}/`)
  );
}

function actionCost(
  action: PreparedAction,
  descriptor: ToolDescriptor,
): AuthorityGrantUsage {
  const mutation = descriptor.effect !== "read";
  return {
    actions: 1,
    externalMutations:
      mutation && EXTERNAL_MUTATION_SYSTEMS.has(descriptor.capability.system)
        ? 1
        : 0,
    creates: descriptor.capability.action === "create" ? 1 : 0,
    deletes: descriptor.capability.action === "delete" ? 1 : 0,
    outboundBytes: action.preview.outboundBytes,
  };
}

function firstExceededLimit(
  limits: AuthorityGrantLimits,
  usage: AuthorityGrantUsage,
  cost: AuthorityGrantUsage,
): keyof AuthorityGrantLimits | null {
  const fields: Array<
    [keyof AuthorityGrantLimits, keyof AuthorityGrantUsage]
  > = [
    ["maxActions", "actions"],
    ["maxExternalMutations", "externalMutations"],
    ["maxCreates", "creates"],
    ["maxDeletes", "deletes"],
    ["maxOutboundBytes", "outboundBytes"],
  ];
  for (const [limitKey, usageKey] of fields) {
    const current = usage[usageKey];
    const increment = cost[usageKey];
    if (
      typeof current === "number" &&
      typeof increment === "number" &&
      current + increment > limits[limitKey]
    ) {
      return limitKey;
    }
  }
  return null;
}

function emptyUsage(): AuthorityGrantUsage {
  return {
    actions: 0,
    externalMutations: 0,
    creates: 0,
    deletes: 0,
    outboundBytes: 0,
  };
}

function hasConcreteSelector(selector: AuthoritySelector): boolean {
  return Object.values(selector).some(
    (values) => Array.isArray(values) && values.some((value) => value.trim()),
  );
}

function compactSelector(selector: AuthoritySelector): AuthoritySelector {
  return Object.fromEntries(
    Object.entries(selector).filter(([, values]) => values !== undefined),
  ) as AuthoritySelector;
}

function optionalSingleton(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : [value];
}

function isValidDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function denied(reason: string): AuthorityEvaluation {
  return { allowed: false, reason };
}
