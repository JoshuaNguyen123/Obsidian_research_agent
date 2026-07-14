import {
  buildBackgroundAuthorizationV1,
  type BackgroundAuthorizationV1,
  type BackgroundExecutionDomainV1,
  type CompanionJobV1,
  type CompanionRemoteJobV1,
  type MissionBindingGrantV1,
  type MissionGraphV3,
} from "../../packages/headless-runtime/src";
import type { MissionGraphSession } from "./missionGraphSession";
import type { PreparedExternalActionHandoffV1 } from "../../packages/core-api/src/preparedExternalActionHandoffV1";
import type { PreparedBackgroundCodeActionV1 } from "../../packages/core-api/src/preparedBackgroundCodeActionV1";
import type { PreparedBackgroundCodePackageIdentityV1 } from "../../packages/core-api/src/preparedBackgroundCodePackageIdentityV1";
import type { ConsumedBackgroundCodeGrantV1 } from "../../packages/core-api/src/preparedBackgroundCodeActionV1";
import type {
  ConsumedBackgroundGitHubGrantV1,
  PreparedBackgroundGitHubActionV1,
} from "../../packages/core-api/src/preparedBackgroundGitHubActionV1";
import type { PreparedBackgroundGitHubPackageIdentityV1 } from "../../packages/core-api/src/preparedBackgroundGitHubPackageIdentityV1";
import type {
  HostApprovalReceiptEvidenceV1,
  HostApprovalReceiptV1,
} from "../../packages/core-api/src/hostApprovalReceiptV1";
import type { PreparedAction } from "./actions";

export interface BackgroundMissionCapabilitySnapshotV1 {
  configured: boolean;
  backgroundEnabled: boolean;
  installedDomains: BackgroundExecutionDomainV1[];
  blocker: string | null;
}

export type BackgroundMissionDispatchPortResultV1 =
  | { status: "submitted"; job: CompanionRemoteJobV1 }
  | { status: "waiting_obsidian"; nodeId: string; reason: string }
  | {
      status: "blocked";
      nodeId: string;
      code: string;
      reason: string;
      requiredAction: string | null;
    };

export type SealBackgroundCodePackagePortResultV1 =
  | {
      status: "ready";
      handoff: PreparedBackgroundCodeActionV1;
      packageIdentity: PreparedBackgroundCodePackageIdentityV1;
      packagePersistenceReceipt: {
        fingerprint: string;
        readbackVerified: true;
      };
    }
  | {
      status: "blocked";
      code: string;
      message: string;
      requiredAction: string | null;
    };

export type SealBackgroundGitHubPackagePortResultV1 =
  | {
      status: "ready";
      action: PreparedBackgroundGitHubActionV1;
      packageIdentity: PreparedBackgroundGitHubPackageIdentityV1;
      packagePersistenceReceipt: {
        fingerprint: string;
        readbackVerified: true;
      };
    }
  | {
      status: "blocked";
      code: string;
      message: string;
      requiredAction: string | null;
    };

/** Optional core-to-companion boundary. It contains no vault or model handles. */
export interface BackgroundMissionDispatchPortV1 {
  readCapabilities(): Promise<BackgroundMissionCapabilitySnapshotV1>;
  /**
   * Resolve logical mission text to exact host-trusted bindings before the
   * canonical graph is persisted. Returned values are extension-owned
   * readbacks; model-supplied paths, commands, or fingerprints are forbidden.
   */
  resolveMissionBindingOverrides?(input: {
    objective: string;
    toolNames: string[];
  }): Promise<Record<string, MissionBindingGrantV1>>;
  readHostApprovalSignerIdentity?(): Promise<{
    signingKeyFingerprint: string;
  } | null>;
  sealHostApprovalReceipt?(
    evidence: HostApprovalReceiptEvidenceV1,
  ): Promise<HostApprovalReceiptV1>;
  submitAuthorizedNode(input: {
    graph: MissionGraphV3;
    nodeId: string;
    authorization: BackgroundAuthorizationV1;
    hostRuntimeRunId?: string | null;
    preparedExternalActionHandoff?: PreparedExternalActionHandoffV1 | null;
    preparedBackgroundCodeAction?: PreparedBackgroundCodeActionV1 | null;
    preparedBackgroundCodePackage?: PreparedBackgroundCodePackageIdentityV1 | null;
    preparedBackgroundGitHubAction?: PreparedBackgroundGitHubActionV1 | null;
    preparedBackgroundGitHubPackage?: PreparedBackgroundGitHubPackageIdentityV1 | null;
    beforeSubmit?(job: CompanionJobV1): Promise<void>;
    now?: Date;
  }): Promise<BackgroundMissionDispatchPortResultV1>;
  sealBackgroundValidationCommitPackage?(input: {
    graph: MissionGraphV3;
    authorization: BackgroundAuthorizationV1;
    preparedAction: PreparedAction;
    authority: ConsumedBackgroundCodeGrantV1;
  }): Promise<SealBackgroundCodePackagePortResultV1>;
  sealBackgroundGitHubPackage?(input: {
    graph: MissionGraphV3;
    authorization: BackgroundAuthorizationV1;
    preparedAction: PreparedAction;
    authority: Omit<
      ConsumedBackgroundGitHubGrantV1,
      "requiredConfirmations" | "confirmationReceipts"
    >;
    hostApprovalReceipts: HostApprovalReceiptV1[];
  }): Promise<SealBackgroundGitHubPackagePortResultV1>;
  resolveCredentialReferenceId?(provider: "linear"): Promise<string | null>;
}

export interface BackgroundMissionDispatchSummaryV1 {
  handled: number;
  submitted: string[];
  waitingObsidian: string[];
  awaitingPreparedAction: string[];
  blocked: Array<{ nodeId: string; code: string; message: string }>;
}

/**
 * Dispatches only nodes already committed to the canonical graph. The graph's
 * capability envelope is the exact read authorization; effectful work cannot
 * be converted into background authority by this bridge.
 */
export async function dispatchPersistedBackgroundNodesV1(input: {
  session: MissionGraphSession;
  port: BackgroundMissionDispatchPortV1;
  now?: () => Date;
}): Promise<BackgroundMissionDispatchSummaryV1> {
  const now = input.now ?? (() => new Date());
  await input.session.promoteReadyNodes();
  const summary: BackgroundMissionDispatchSummaryV1 = {
    handled: 0,
    submitted: [],
    waitingObsidian: [],
    awaitingPreparedAction: [],
    blocked: [],
  };
  const candidateIds = Object.values(input.session.graph.nodes)
    .filter(
      (node) =>
        node.status === "ready" &&
        (node.executionHost === "companion" ||
          node.executionHost === "headless_runtime"),
    )
    .map((node) => node.id)
    .sort();

  for (const nodeId of candidateIds) {
    const graph = input.session.graph;
    const node = graph.nodes[nodeId];
    if (!node || node.status !== "ready") continue;
    summary.handled += 1;
    if (node.effect !== "read") {
      // Effectful nodes remain ready until the normal prepared-action path has
      // produced exact approval, a consumed grant, and a journaled handoff.
      // Read dispatch must never manufacture that authority.
      summary.awaitingPreparedAction.push(node.id);
      continue;
    }

    const authorizedAt = now().toISOString();
    const authorization = await buildBackgroundAuthorizationV1({
      graph,
      nodeId: node.id,
      grantId: capabilityGrantId(graph),
      authorizedAt,
      expiresAt: null,
      authorizedGraphRevision: graph.revision,
    });
    let result: BackgroundMissionDispatchPortResultV1;
    try {
      result = await input.port.submitAuthorizedNode({
        graph,
        nodeId: node.id,
        authorization,
        now: new Date(authorizedAt),
      });
    } catch (error) {
      const message = safeError(error);
      await input.session.transitionNode(node.id, "blocked", {
        code: "background_dispatch_failed",
        message,
        requiredAction:
          "Reconnect the companion, inspect Run Details, and resume after its health is green.",
      });
      summary.blocked.push({
        nodeId: node.id,
        code: "background_dispatch_failed",
        message,
      });
      continue;
    }
    if (result.status === "submitted") {
      await input.session.transitionNode(node.id, "running", null);
      summary.submitted.push(node.id);
      continue;
    }
    if (result.status === "waiting_obsidian") {
      await input.session.transitionNode(node.id, "waiting_obsidian", {
        code: "waiting_obsidian",
        message: result.reason,
        requiredAction:
          "Reconnect Obsidian and resume so the vault operation runs through the Obsidian API.",
      });
      summary.waitingObsidian.push(node.id);
      continue;
    }
    await input.session.transitionNode(node.id, "blocked", {
      code: result.code,
      message: result.reason,
      requiredAction: result.requiredAction,
    });
    summary.blocked.push({
      nodeId: node.id,
      code: result.code,
      message: result.reason,
    });
  }
  return summary;
}

export function hasExplicitBackgroundContinuationIntent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    /\b(?:continue|run|work|research|check)\b[\s\S]{0,80}\b(?:in the background|after (?:i )?close obsidian|while obsidian is closed)\b/.test(
      normalized,
    ) ||
    /\b(?:background continuation|continue in background|companion worker)\b/.test(
      normalized,
    )
  );
}

function capabilityGrantId(graph: MissionGraphV3): string {
  return `mission-capability-${graph.capabilityEnvelope.fingerprint.slice("sha256:".length, 40)}`;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Background dispatch failed.")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /(token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;}]+/gi,
      "$1=[REDACTED]",
    )
    .slice(0, 4_096);
}
