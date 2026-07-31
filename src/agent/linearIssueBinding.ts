/**
 * Linear issue identity binding: how the runner decides which exact issue id
 * a mission is bound to, from tool outputs, lineage fingerprints, and
 * host-verified readbacks. Extracted verbatim from AgentRunner.ts (Cluster D1
 * of the monolith extraction); bodies are byte-identical.
 */

import { type ModelChatMessage } from "../model/types";
import { PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME } from "../tools/researchProjectHierarchyTool";
import { type ToolExecutionContext } from "../tools/types";
import { extractExplicitLinearIssueReadIdentity } from "./linearIntent";
import { getProjectLineageFingerprintHistoryV1 } from "./projectLifecycle";
import { getString, isRecord } from "./recordUtils";
import type { AgentRunReceipt } from "../AgentRunner";

export function getLatestToolOutput(
  messages: readonly ModelChatMessage[],
  toolName: string,
): unknown {
  for (const message of [...messages].reverse()) {
    if (message.role !== "tool" || message.toolName !== toolName) {
      continue;
    }

    try {
      const parsed = JSON.parse(message.content) as unknown;
      if (isRecord(parsed) && "output" in parsed) {
        return parsed.output;
      }
    } catch {
      return null;
    }
  }

  return null;
}

export function getLatestToolOutputForPath(
  messages: readonly ModelChatMessage[],
  toolName: string,
  path: string,
): unknown {
  for (const message of [...messages].reverse()) {
    if (message.role !== "tool" || message.toolName !== toolName) continue;
    try {
      const parsed = JSON.parse(message.content) as unknown;
      const output = isRecord(parsed) && "output" in parsed
        ? parsed.output
        : null;
      if (isRecord(output) && getString(output.path) === path) return output;
    } catch {
      return null;
    }
  }
  return null;
}

export function getLatestLinearIssueReference(
  messages: readonly ModelChatMessage[],
): string | null {
  const output = getLatestToolOutput(messages, "linear_get_issue");
  const record = findNestedLinearIssueRecord(output, 0);
  if (!record) return null;
  const identifier = getString(record.identifier) ?? getString(record.id);
  const url = getString(record.url);
  if (!identifier && !url) return null;
  return [
    identifier ? `linearIssueIdentifier=${JSON.stringify(identifier)}` : "",
    url ? `linearIssueUrl=${JSON.stringify(url)}` : "",
  ].filter(Boolean).join("; ");
}

export function findNestedLinearIssueRecord(
  value: unknown,
  depth: number,
): Record<string, unknown> | null {
  if (depth > 6 || !isRecord(value)) return null;
  if (
    (typeof value.identifier === "string" || typeof value.id === "string") &&
    (typeof value.title === "string" || typeof value.url === "string")
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const entry of child) {
        const found = findNestedLinearIssueRecord(entry, depth + 1);
        if (found) return found;
      }
      continue;
    }
    const found = findNestedLinearIssueRecord(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function getVerifiedLinearHierarchyIssueId(
  context: Pick<
    ToolExecutionContext,
    "rootMissionId" | "runId" | "getProjectLineages"
  >,
): string | null {
  const rootMissionId = context.rootMissionId?.trim() || context.runId?.trim();
  if (!rootMissionId || !context.getProjectLineages) return null;
  let lineages: ReturnType<NonNullable<ToolExecutionContext["getProjectLineages"]>>;
  try {
    lineages = context.getProjectLineages();
  } catch {
    return null;
  }
  const issueIds = new Set<string>();
  for (const lineage of lineages) {
    if (lineage.runId !== rootMissionId || !Array.isArray(lineage.commits)) {
      continue;
    }
    for (const commit of lineage.commits) {
      if (
        commit.stage !== "linear_hierarchy" ||
        commit.proof.stage !== "linear_hierarchy" ||
        !Array.isArray(commit.proof.issueIds)
      ) {
        continue;
      }
      for (const issueId of commit.proof.issueIds) {
        if (typeof issueId === "string" && issueId.trim()) {
          issueIds.add(issueId.trim());
        }
      }
    }
  }
  return issueIds.size === 1 ? [...issueIds][0]! : null;
}

export function getCurrentProjectLineageFingerprints(
  context: Pick<
    ToolExecutionContext,
    "rootMissionId" | "runId" | "getProjectLineages"
  >,
  fallbackRunId: string,
): string[] {
  if (!context.getProjectLineages) return [];
  const acceptedRunIds = new Set(
    [context.rootMissionId, context.runId, fallbackRunId]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.trim()),
  );
  try {
    return [
      ...new Set(
        context.getProjectLineages()
          .filter((lineage) => acceptedRunIds.has(lineage.runId))
          .flatMap((lineage) =>
            getProjectLineageFingerprintHistoryV1(lineage),
          )
          .filter((value) => /^sha256:[a-f0-9]{64}$/u.test(value)),
      ),
    ].sort();
  } catch {
    return [];
  }
}

/**
 * Collect Linear issue id/identifier candidates from tool output + durable
 * receipts. Continue segments often lose in-memory tool messages, so receipts
 * (resource id/url/output) must be enough to rebind linear_get_issue.
 */
export function collectLinearIssueBindingCandidates(input: {
  messages: readonly ModelChatMessage[];
  durableReceipts?: readonly AgentRunReceipt[];
}): string[] {
  const candidates: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || candidates.includes(trimmed)) return;
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        trimmed,
      );
    const isIdentifier = /^[A-Z][A-Z0-9]+-\d+$/u.test(trimmed);
    if (isUuid || isIdentifier) {
      candidates.push(trimmed);
    }
  };
  const pushFromRecord = (record: Record<string, unknown> | null) => {
    if (!record) return;
    push(getString(record.id));
    push(getString(record.issueId));
    push(getString(record.identifier));
    const url = getString(record.url) ?? getString(record.issueUrl);
    const fromUrl = url?.match(
      /linear\.app\/[^/\s]+\/issue\/([A-Z0-9][A-Z0-9-]+)/iu,
    );
    if (fromUrl?.[1]) push(fromUrl[1]);
  };
  pushFromRecord(
    findNestedLinearIssueRecord(
      getLatestToolOutput(input.messages, "linear_create_issue"),
      0,
    ),
  );
  pushFromRecord(
    findNestedLinearIssueRecord(
      getLatestToolOutput(input.messages, "linear_get_issue"),
      0,
    ),
  );
  for (const receipt of [...(input.durableReceipts ?? [])].reverse()) {
    const toolName =
      typeof receipt.toolName === "string" ? receipt.toolName.trim() : "";
    const resourceSystem =
      typeof receipt.resource?.system === "string"
        ? receipt.resource.system.trim().toLowerCase()
        : "";
    const resourceType =
      typeof receipt.resource?.resourceType === "string"
        ? receipt.resource.resourceType.trim().toLowerCase()
        : "";
    const looksLinearIssue =
      toolName === "linear_create_issue" ||
      toolName === "linear_get_issue" ||
      toolName === "publish_research_to_linear" ||
      (resourceSystem === "linear" &&
        (resourceType === "issue" || resourceType === "" || !resourceType));
    if (!looksLinearIssue) continue;
    push(receipt.resource?.id);
    push(
      typeof receipt.resource?.identifier === "string"
        ? receipt.resource.identifier
        : null,
    );
    const resourceUrl =
      typeof receipt.resource?.url === "string" ? receipt.resource.url : "";
    const fromResourceUrl = resourceUrl.match(
      /linear\.app\/[^/\s]+\/issue\/([A-Z0-9][A-Z0-9-]+)/iu,
    );
    if (fromResourceUrl?.[1]) push(fromResourceUrl[1]);
    if (isRecord(receipt.output)) {
      pushFromRecord(receipt.output);
      if (isRecord(receipt.output.issue)) {
        pushFromRecord(receipt.output.issue);
      }
    }
    if (typeof receipt.message === "string") {
      const fromMessage = receipt.message.match(
        /linear\.app\/[^/\s]+\/issue\/([A-Z0-9][A-Z0-9-]+)/iu,
      );
      if (fromMessage?.[1]) push(fromMessage[1]);
    }
  }
  return candidates;
}

/**
 * Prefer a single provider UUID when UUID + human identifier both appear for
 * the same issue. Only return null when multiple distinct UUIDs remain.
 */
export function pickCanonicalLinearIssueId(
  candidates: readonly string[],
): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const uuids = candidates.filter((value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    ),
  );
  if (uuids.length === 1) return uuids[0]!;
  if (uuids.length > 1) return null;
  // Identifiers only — newest-first collector already ordered receipts.
  return candidates[0] ?? null;
}

export function resolveLinearIssueReadbackBinding(input: {
  dependencyToolNames: readonly string[];
  context: Pick<
    ToolExecutionContext,
    "rootMissionId" | "runId" | "getProjectLineages"
  >;
  messages: readonly ModelChatMessage[];
  durableReceipts?: readonly AgentRunReceipt[];
}): {
  required: boolean;
  issueId: string | null;
  source: "linear_hierarchy" | "linear_create_issue" | null;
} {
  const dependencies = new Set(input.dependencyToolNames);
  const durableCreateIssueId = pickCanonicalLinearIssueId(
    collectLinearIssueBindingCandidates({
      messages: input.messages,
      durableReceipts: input.durableReceipts,
    }),
  );
  if (dependencies.has(PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME)) {
    const hierarchyId = getVerifiedLinearHierarchyIssueId(input.context);
    if (hierarchyId) {
      return {
        required: true,
        issueId: hierarchyId,
        source: "linear_hierarchy",
      };
    }
    // Set-loose Soft-union often pays Linear via linear_create_issue while the
    // MissionGraph still projects publish_research_project_to_linear as the
    // dependency. Prefer the durable create receipt over a hard-stop.
    if (durableCreateIssueId) {
      return {
        required: true,
        issueId: durableCreateIssueId,
        source: "linear_create_issue",
      };
    }
    return {
      required: true,
      issueId: null,
      source: "linear_hierarchy",
    };
  }
  if (dependencies.has("linear_create_issue")) {
    return {
      required: true,
      issueId: durableCreateIssueId,
      source: "linear_create_issue",
    };
  }
  return { required: false, issueId: null, source: null };
}

export type LinearGetIssueHostBindingDecisionV1 = {
  action: "bind" | "pass" | "soft_skip" | "block";
  issueId: string | null;
  source:
    | "linear_hierarchy"
    | "linear_create_issue"
    | "set_loose_durable"
    | "explicit_mission_identity"
    | null;
};

/**
 * Host decision for MissionGraph linear_get_issue binding under set-loose
 * Soft-union. When Linear delivery is already paid, never hard-stop the whole
 * graph solely because the exact dependency projection lagged.
 */
export function decideLinearGetIssueHostBindingV1(input: {
  dependencyToolNames: readonly string[];
  context: Pick<
    ToolExecutionContext,
    "rootMissionId" | "runId" | "getProjectLineages"
  >;
  messages: readonly ModelChatMessage[];
  durableReceipts?: readonly AgentRunReceipt[];
  setLooseCompoundEnabled: boolean;
  linearDeliveryPaid: boolean;
  activeIntentPrompt?: string;
}): LinearGetIssueHostBindingDecisionV1 {
  const binding = resolveLinearIssueReadbackBinding({
    dependencyToolNames: input.dependencyToolNames,
    context: input.context,
    messages: input.messages,
    durableReceipts: input.durableReceipts,
  });
  if (binding.issueId) {
    return {
      action: "bind",
      issueId: binding.issueId,
      source: binding.source,
    };
  }
  const explicitMissionIssueIdentity = input.activeIntentPrompt
    ? extractExplicitLinearIssueReadIdentity(input.activeIntentPrompt)
    : null;
  if (explicitMissionIssueIdentity) {
    return {
      action: "bind",
      issueId: explicitMissionIssueIdentity,
      source: "explicit_mission_identity",
    };
  }
  const durableIssueId = pickCanonicalLinearIssueId(
    collectLinearIssueBindingCandidates({
      messages: input.messages,
      durableReceipts: input.durableReceipts,
    }),
  );
  if (
    durableIssueId &&
    (binding.required || input.setLooseCompoundEnabled)
  ) {
    return {
      action: "bind",
      issueId: durableIssueId,
      source: "set_loose_durable",
    };
  }
  if (!binding.required) {
    return { action: "pass", issueId: null, source: null };
  }
  if (input.setLooseCompoundEnabled && input.linearDeliveryPaid) {
    return { action: "soft_skip", issueId: null, source: null };
  }
  return {
    action: "block",
    issueId: null,
    source: binding.source,
  };
}
