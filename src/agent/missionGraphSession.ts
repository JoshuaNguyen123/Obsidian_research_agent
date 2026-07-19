import type { ToolExecutionContext } from "../tools/types";
import {
  acquireResourceLocks,
  releaseResourceLocks,
} from "./queue/resourceLocks";
import {
  getCurrentMissionCompositeLifecycleActionV1,
  getMissionCompositeLifecycleSpecV1,
  getMissionCompositeLifecycleStateV1,
  type MissionBlockerV1,
  type MissionCompositeLifecycleActionV1,
  type MissionEvidenceRefV1,
  type MissionGraphPatchOperationV1,
  type MissionGraphPatchV1,
  type MissionGraphV3,
  type MissionNodeBudgetV1,
  type MissionNodeV3,
  type MissionNodeStatusV3,
  type MissionReceiptRefV1,
} from "./missionGraphV3";
import {
  canPersistMissionGraphStore,
  persistInitialMissionGraph,
  persistMissionGraphPatchTransaction,
  persistMissionGraphResourceLocks,
  readMissionGraphStoreRecord,
  recoverFinalPreparedMissionGraphPatch,
  type MissionGraphStoreRecordV1,
} from "./missionGraphStore";
import type { MissionGraphStoreReferenceV1 } from "./runStore";
import { missionGraphToolNodeWallClockMs } from "./missionGraphHost";

export interface MissionGraphSessionEvents {
  onGraphUpdate?: (
    graph: MissionGraphV3,
    patch?: MissionGraphPatchV1,
  ) => void;
}

export interface OpenMissionGraphSessionInput {
  context: ToolExecutionContext;
  initialGraph: MissionGraphV3;
  events?: MissionGraphSessionEvents;
  /** Existing state wins only when this is an explicit continuation. */
  resume?: boolean;
}

export interface ResumeMissionGraphSessionInput {
  context: ToolExecutionContext;
  missionId: string;
  events?: MissionGraphSessionEvents;
}

export interface MissionGraphLockLease {
  nodeId: string;
  ownerId: string;
  token: string;
  resourceKeys: string[];
}

export interface MissionGraphToolExecution {
  nodeId: string;
  toolName: string;
  lockLease: MissionGraphLockLease | null;
  lifecycleActionId?: string | null;
}

/**
 * Adapts the canonical mission-ledger evidence vocabulary (for example,
 * `vault_note`) to the exact kind required by the authoritative graph node
 * (`vault-note`). A host-planned generic `tool-result` contract remains
 * generic even when the ledger can classify the result more specifically.
 */
export function resolveMissionGraphEvidenceKind(
  observedKind: string | null | undefined,
  requiredKinds: readonly string[],
): string {
  const observed = normalizeEvidenceKindToken(observedKind ?? "tool-result");
  const exactContractKind = requiredKinds.find(
    (kind) => normalizeEvidenceKindToken(kind) === observed,
  );
  if (exactContractKind) return exactContractKind;

  const genericContractKind = requiredKinds.find(
    (kind) => normalizeEvidenceKindToken(kind) === "tool-result",
  );
  return genericContractKind ?? observed;
}

export type MissionGraphToolStartResult =
  | { ok: true; execution: MissionGraphToolExecution }
  | {
      ok: false;
      reason: string;
      code?: "budget_exhausted";
    };

const READ_NODE_LOCK_LEASE_MS = 60_000;
/** Longer than the runner's 120-second approval window. */
const EFFECTFUL_NODE_LOCK_LEASE_MS = 180_000;

/**
 * Serial host adapter for the canonical graph. Every graph change passes
 * through the store's prepared/applied CAS transaction before observers see
 * it. Model workers never receive this object or direct persistence access.
 */
export class MissionGraphSession {
  private patchSequence = 0;
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly context: ToolExecutionContext,
    private record: MissionGraphStoreRecordV1,
    private readonly events: MissionGraphSessionEvents,
  ) {}

  static async open(
    input: OpenMissionGraphSessionInput,
  ): Promise<MissionGraphSession> {
    if (!canPersistMissionGraphStore(input.context)) {
      throw new Error(
        "Canonical mission graph persistence is unavailable; refusing to execute tools without a durable graph.",
      );
    }

    const existing = await readMissionGraphStoreRecord(
      input.context,
      input.initialGraph.missionId,
    );
    let record: MissionGraphStoreRecordV1;
    if (existing) {
      if (!input.resume) {
        throw new Error(
          `Mission graph ${input.initialGraph.missionId} already exists; explicit continuation is required.`,
        );
      }
      if (
        existing.record.graph.capabilityEnvelope.fingerprint !==
        input.initialGraph.capabilityEnvelope.fingerprint
      ) {
        throw new Error(
          "Persisted mission capability envelope differs from the continuation request.",
        );
      }
      const recovered = await recoverFinalPreparedMissionGraphPatch(
        input.context,
        input.initialGraph.missionId,
        { expectedStoreRevision: existing.record.storeRevision },
      );
      record = recovered.record;
    } else {
      const persisted = await persistInitialMissionGraph(
        input.context,
        input.initialGraph,
      );
      record = persisted.record;
    }

    const session = new MissionGraphSession(
      input.context,
      record,
      input.events ?? {},
    );
    session.emit();
    return session;
  }

  static async resume(
    input: ResumeMissionGraphSessionInput,
  ): Promise<MissionGraphSession> {
    if (!canPersistMissionGraphStore(input.context)) {
      throw new Error(
        "Canonical mission graph persistence is unavailable; refusing to resume without durable state.",
      );
    }
    const existing = await readMissionGraphStoreRecord(
      input.context,
      input.missionId,
    );
    if (!existing) {
      throw new Error(`Mission graph ${input.missionId} is unavailable.`);
    }
    const recovered = await recoverFinalPreparedMissionGraphPatch(
      input.context,
      input.missionId,
      { expectedStoreRevision: existing.record.storeRevision },
    );
    const session = new MissionGraphSession(
      input.context,
      recovered.record,
      input.events ?? {},
    );
    session.emit();
    return session;
  }

  get graph(): MissionGraphV3 {
    return clone(this.record.graph);
  }

  get storeRevision(): number {
    return this.record.storeRevision;
  }

  get reference(): MissionGraphStoreReferenceV1 {
    return {
      version: 1,
      missionId: this.record.missionId,
      path: `Agent Runs/Mission Graphs/${sanitizeMissionId(this.record.missionId)}.md`,
      storeRevision: this.record.storeRevision,
      graphRevision: this.record.graph.revision,
      recordFingerprint: this.record.recordFingerprint,
      journalHeadFingerprint: this.record.graph.journalHeadFingerprint,
    };
  }

  getActiveNodeId(): string | null {
    const priority: MissionNodeStatusV3[] = [
      "running",
      "waiting_approval",
      "waiting_obsidian",
      "verifying",
      "ready",
      "blocked",
      "queued",
    ];
    const nodes = Object.values(this.record.graph.nodes);
    for (const status of priority) {
      const node = nodes.find((candidate) => candidate.status === status);
      if (node) return node.id;
    }
    return null;
  }

  async beginToolExecution(
    toolName: string,
    options: { allowDynamicReadContinuation?: boolean } = {},
  ): Promise<MissionGraphToolStartResult> {
    return this.enqueueMutation(async () => {
      let node = Object.values(this.record.graph.nodes).find(
        (candidate) =>
          candidate.status === "ready" &&
          missionNodeExpectsToolV1(candidate, toolName),
      );
      if (!node) {
        const terminalFailure = Object.values(this.record.graph.nodes).find(
          (candidate) =>
            candidate.status === "blocked" &&
            missionNodeExpectsToolV1(candidate, toolName) &&
            (candidate.blocker?.code === "tool_failure_repeated" ||
              candidate.retries.attempts >= candidate.retries.maxAttempts ||
              candidate.retries.consecutiveFailureCount >= 2),
        );
        if (terminalFailure) {
          return {
            ok: false as const,
            reason: `Tool ${toolName} is blocked after repeated unchanged failures in mission node ${terminalFailure.id}.`,
          };
        }
        const lifecycleNode = Object.values(this.record.graph.nodes).find(
          (candidate) => missionNodeContainsLifecycleToolV1(candidate, toolName),
        );
        if (lifecycleNode) {
          const expected = getCurrentMissionCompositeLifecycleActionV1(lifecycleNode);
          const state = getMissionCompositeLifecycleStateV1(lifecycleNode);
          const replayed = state && getMissionCompositeLifecycleSpecV1(lifecycleNode)
            ?.actions.slice(0, state.actionCursor)
            .some((action) => action.toolName === toolName);
          return {
            ok: false as const,
            reason: replayed
              ? `Tool ${toolName} already completed in composite lifecycle node ${lifecycleNode.id} and cannot be replayed.`
              : expected
                ? `Tool ${toolName} is not the current action in composite lifecycle node ${lifecycleNode.id}; expected ${expected.toolName}.`
                : `Tool ${toolName} cannot continue after composite lifecycle node ${lifecycleNode.id} completed.`,
          };
        }
        const grant = this.record.graph.capabilityEnvelope.tools[toolName];
        const template = Object.values(this.record.graph.nodes).find(
          (candidate) =>
            !getMissionCompositeLifecycleSpecV1(candidate) &&
            candidate.allowedTools.includes(toolName),
        );
        if (!grant) {
          return {
            ok: false as const,
            reason: `Tool ${toolName} is not ready in the authoritative mission graph.`,
          };
        }
        if (grant.effect !== "read") {
          const nonterminalTemplate = Object.values(this.record.graph.nodes).find(
            (candidate) =>
              candidate.allowedTools.includes(toolName) &&
              candidate.status !== "complete" &&
              candidate.status !== "cancelled",
          );
          if (nonterminalTemplate || !template || template.status !== "complete") {
            return {
              ok: false as const,
              reason: `Tool ${toolName} is not ready in the authoritative mission graph.`,
            };
          }
          const continuationNode = findContinuationReserveNode(this.record.graph);
          if (!continuationNode || continuationNode.status === "complete") {
            return {
              ok: false as const,
              reason: `Tool ${toolName} cannot continue after final mission completion.`,
            };
          }
          const dynamicId = `retry-${this.record.graph.revision + 1}-${sanitizeMissionId(
            toolName,
          )}`;
          let dynamicNode = {
            ...clone(template),
            id: dynamicId,
            outputs: {},
            retries: {
              maxAttempts: template.retries.maxAttempts,
              attempts: 0,
              failureFingerprints: [],
              consecutiveFailureFingerprint: null,
              consecutiveFailureCount: 0,
            },
            status: "ready" as const,
            evidence: [],
            receipts: [],
            verification: null,
            blocker: null,
          };
          let continuationBudget: MissionNodeBudgetV1;
          try {
            const allocation = transferReservedBudgetForContinuation(
              this.record.graph,
              continuationNode,
              dynamicNode.budget,
            );
            dynamicNode = {
              ...dynamicNode,
              budget: allocation.addedNodeBudget,
            };
            continuationBudget = allocation.reserveNodeBudget;
          } catch (error) {
            return {
              ok: false as const,
              reason: `Tool ${toolName} cannot be repeated within the graph budget: ${
                error instanceof Error ? error.message : String(error)
              }`,
              code: "budget_exhausted" as const,
            };
          }
          const nextFinalDependencies = [
            ...new Set([...continuationNode.dependencyIds, dynamicId]),
          ].sort();
          const finalDependencyOperations: MissionGraphPatchOperationV1[] =
            continuationNode.status === "ready"
              ? [
                  { op: "remove_node", nodeId: continuationNode.id },
                  {
                    op: "add_node",
                    node: {
                      ...clone(continuationNode),
                      dependencyIds: nextFinalDependencies,
                      budget: continuationBudget,
                      status: "queued" as const,
                    },
                  },
                ]
              : [
                  {
                    op: "update_node",
                    nodeId: continuationNode.id,
                    changes: {
                      dependencyIds: nextFinalDependencies,
                      budget: continuationBudget,
                    },
                  },
                ];
          try {
            await this.applyUnlocked(
              `Add bounded effectful continuation for ${toolName}.`,
              [
                { op: "add_node", node: dynamicNode },
                ...finalDependencyOperations,
              ],
            );
          } catch (error) {
            return {
              ok: false as const,
              reason: `Tool ${toolName} cannot be repeated within the graph budget: ${
                error instanceof Error ? error.message : String(error)
              }`,
              code: "budget_exhausted" as const,
            };
          }
          node = this.record.graph.nodes[dynamicId];
        } else {
        if (options.allowDynamicReadContinuation === false) {
          return {
            ok: false as const,
            reason: `Tool ${toolName} is not ready in the exact authoritative mission graph.`,
          };
        }
        const dynamicId = `retry-${this.record.graph.revision + 1}-${sanitizeMissionId(
          toolName,
        )}`;
        const readExecutor = Object.values(
          this.record.graph.capabilityEnvelope.executors,
        ).find(
          (executor) =>
            executor.allowedEffects.includes("read") &&
            executor.executionHosts.some((host) =>
              grant.executionHosts.includes(host),
            ),
        );
        if (!readExecutor) {
          return {
            ok: false as const,
            reason: `Tool ${toolName} has no installed read executor.`,
          };
        }
        const dynamicReadWallClockMs = missionGraphToolNodeWallClockMs(
          this.record.graph.capabilityEnvelope.budgets.maxWallClockMs,
          this.record.graph.capabilityEnvelope.budgets.maxTotalToolCalls,
        );
        const baseTemplate = template ?? {
          id: dynamicId,
          dependencyIds: [],
          objective: `Run bounded host-approved read ${toolName}.`,
          executorId: readExecutor.id,
          executionHost: grant.executionHosts[0],
          effect: "read" as const,
          inputs: {},
          outputs: {},
          requiredCapabilities: [...grant.capabilityIds],
          allowedTools: [toolName],
          destination: null,
          resourceLocks: [],
          budget: {
            toolCalls: 1,
            externalActions: 0,
            wallClockMs: dynamicReadWallClockMs,
          },
          retries: {
            maxAttempts:
              this.record.graph.capabilityEnvelope.budgets.maxAttemptsPerNode,
            attempts: 0,
            failureFingerprints: [],
            consecutiveFailureFingerprint: null,
            consecutiveFailureCount: 0,
          },
          status: "ready" as const,
          evidence: [],
          receipts: [],
          verification: null,
          completionContract: {
            criteria: [`${toolName} produced an observable accepted result.`],
            minimumEvidence: 1,
            requiredEvidenceKinds: ["tool-result"],
            minimumReceipts: 0,
            requiredReceiptKinds: [],
            verifierId: null,
          },
          blocker: null,
        };
        let dynamicNode = {
          ...clone(baseTemplate),
          id: dynamicId,
          dependencyIds: [],
          outputs: {},
          retries: {
            maxAttempts: baseTemplate.retries.maxAttempts,
            attempts: 0,
            failureFingerprints: [],
            consecutiveFailureFingerprint: null,
            consecutiveFailureCount: 0,
          },
          status: "ready" as const,
          evidence: [],
          receipts: [],
          verification: null,
          blocker: null,
        };
        const continuationNode = findContinuationReserveNode(this.record.graph);
        if (continuationNode?.status === "complete") {
          return {
            ok: false as const,
            reason: `Tool ${toolName} cannot continue after final mission completion.`,
          };
        }
        let continuationBudget: MissionNodeBudgetV1 | null = null;
        if (continuationNode) {
          try {
            const allocation = transferReservedBudgetForContinuation(
              this.record.graph,
              continuationNode,
              dynamicNode.budget,
            );
            dynamicNode = {
              ...dynamicNode,
              budget: allocation.addedNodeBudget,
            };
            continuationBudget = allocation.reserveNodeBudget;
          } catch (error) {
            return {
              ok: false as const,
              reason: `Tool ${toolName} cannot be added within the graph budget: ${
                error instanceof Error ? error.message : String(error)
              }`,
              code: "budget_exhausted" as const,
            };
          }
        }
        const finalDependencyOperations: MissionGraphPatchOperationV1[] = continuationNode
          ? continuationNode.status === "ready"
            ? [
                { op: "remove_node", nodeId: continuationNode.id },
                {
                  op: "add_node",
                  node: {
                    ...clone(continuationNode),
                    dependencyIds: [
                      ...new Set([...continuationNode.dependencyIds, dynamicId]),
                    ].sort(),
                    ...(continuationBudget ? { budget: continuationBudget } : {}),
                    status: "queued" as const,
                  },
                },
              ]
            : [
                {
                  op: "update_node",
                  nodeId: continuationNode.id,
                  changes: {
                    dependencyIds: [
                      ...new Set([...continuationNode.dependencyIds, dynamicId]),
                    ].sort(),
                    ...(continuationBudget ? { budget: continuationBudget } : {}),
                  },
                },
              ]
          : [];
        try {
          await this.applyUnlocked(`Add bounded read retry for ${toolName}.`, [
            { op: "add_node", node: dynamicNode },
            ...finalDependencyOperations,
          ]);
        } catch (error) {
          return {
            ok: false as const,
            reason: `Tool ${toolName} cannot be added within the graph budget: ${
              error instanceof Error ? error.message : String(error)
            }`,
            code: "budget_exhausted" as const,
          };
        }
        node = this.record.graph.nodes[dynamicId];
        }
      }

      let lockLease: MissionGraphLockLease | null = null;
      try {
        lockLease = await this.acquireNodeLocksUnlocked(
          node.id,
          node.effect === "read"
            ? READ_NODE_LOCK_LEASE_MS
            : EFFECTFUL_NODE_LOCK_LEASE_MS,
        );
        if (
          node.resourceLocks.some((requirement) => requirement.mode === "exclusive") &&
          !lockLease
        ) {
          return {
            ok: false as const,
            reason: `Resource lock is unavailable for mission node ${node.id}.`,
          };
        }
        await this.applyUnlocked(`Start mission node ${node.id}.`, [
          {
            op: "set_status",
            nodeId: node.id,
            expectedStatus: "ready",
            status: "running",
            blocker: null,
          },
        ]);
        return {
          ok: true as const,
          execution: {
            nodeId: node.id,
            toolName,
            lockLease,
            lifecycleActionId:
              getCurrentMissionCompositeLifecycleActionV1(node)?.id ?? null,
          },
        };
      } catch (error) {
        if (lockLease) {
          await this.releaseNodeLocksUnlocked(lockLease).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async finishToolExecution(
    execution: MissionGraphToolExecution,
    result: {
      ok: boolean;
      evidence?: MissionEvidenceRefV1;
      receipt?: MissionReceiptRefV1;
      failureFingerprint?: string;
      failureMessage?: string;
      /** Host-verified domain outcome that must not be retried. */
      terminalFailure?: boolean;
    },
  ): Promise<MissionGraphV3> {
    return this.enqueueMutation(async () => {
      const node = this.requireNode(execution.nodeId);
      if (node.status !== "running") {
        throw new Error(
          `Mission node ${node.id} is ${node.status}; expected running before result.`,
        );
      }
      const lifecycle = getMissionCompositeLifecycleSpecV1(node);
      const lifecycleState = getMissionCompositeLifecycleStateV1(node);
      const lifecycleAction = getCurrentMissionCompositeLifecycleActionV1(node);
      if (lifecycle) {
        if (
          !lifecycleState ||
          !lifecycleAction ||
          lifecycleAction.toolName !== execution.toolName ||
          lifecycleAction.id !== execution.lifecycleActionId
        ) {
          throw new Error(
            `Tool ${execution.toolName} does not match the durable composite lifecycle cursor for ${node.id}.`,
          );
        }
      }
      const operations: MissionGraphPatchOperationV1[] = [
        {
          op: "record_attempt",
          nodeId: node.id,
          failureFingerprint: result.ok
            ? null
            : result.failureFingerprint ?? null,
          observedAt: this.now(),
        },
      ];
      if (result.evidence) {
        operations.push({
          op: "append_evidence",
          nodeId: node.id,
          evidence: result.evidence,
        });
      }
      if (result.receipt) {
        operations.push({
          op: "append_receipt",
          nodeId: node.id,
          receipt: result.receipt,
        });
      }

      if (result.ok) {
        const lifecycleProofMissing = lifecycleAction
          ? actionProofMissingV1(lifecycleAction, result)
          : false;
        if (lifecycleProofMissing && lifecycleState && lifecycleAction) {
          operations.push(
            lifecycleOutputsOperationV1(
              node.id,
              lifecycleState,
              lifecycleAction.id,
              false,
            ),
            {
              op: "set_status",
              nodeId: node.id,
              expectedStatus: "running",
              status: "blocked",
              blocker: {
                code: "completion_proof_missing",
                message: `Tool ${execution.toolName} returned without the proof required by lifecycle action ${lifecycleAction.id}.`,
                requiredAction:
                  "Reconcile the exact lifecycle action and attach its verified evidence or receipt.",
              },
            },
          );
        } else if (
          lifecycle &&
          lifecycleState &&
          lifecycleAction &&
          lifecycleState.actionCursor + 1 < lifecycle.actions.length
        ) {
          operations.push(
            lifecycleOutputsOperationV1(
              node.id,
              lifecycleState,
              lifecycleAction.id,
              true,
            ),
            {
              op: "update_node",
              nodeId: node.id,
              changes: {
                retries: {
                  maxAttempts: node.retries.maxAttempts,
                  attempts: 0,
                  failureFingerprints: [],
                  consecutiveFailureFingerprint: null,
                  consecutiveFailureCount: 0,
                },
              },
            },
            {
              op: "set_status",
              nodeId: node.id,
              expectedStatus: "running",
              status: "ready",
              blocker: null,
            },
          );
        } else {
          if (lifecycleState && lifecycleAction) {
            operations.push(
              lifecycleOutputsOperationV1(
                node.id,
                lifecycleState,
                lifecycleAction.id,
                true,
              ),
            );
          }
        const projectedEvidence = [
          ...node.evidence,
          ...(result.evidence ? [result.evidence] : []),
        ];
        const projectedReceipts = [
          ...node.receipts,
          ...(result.receipt ? [result.receipt] : []),
        ];
        const missingReceipt =
          projectedReceipts.length < node.completionContract.minimumReceipts ||
          node.completionContract.requiredReceiptKinds.some(
            (kind) => !projectedReceipts.some((receipt) => receipt.kind === kind),
          );
        const missingEvidence =
          projectedEvidence.length < node.completionContract.minimumEvidence ||
          node.completionContract.requiredEvidenceKinds.some(
            (kind) => !projectedEvidence.some((evidence) => evidence.kind === kind),
          );
        if (missingReceipt || missingEvidence) {
          operations.push({
            op: "set_status",
            nodeId: node.id,
            expectedStatus: "running",
            status: "blocked",
            blocker: {
              code: "completion_proof_missing",
              message: `Tool ${execution.toolName} returned without its required durable proof.`,
              requiredAction: "Reconcile the tool result and attach verified evidence or a receipt.",
            },
          });
        } else {
          operations.push(
            {
              op: "set_status",
              nodeId: node.id,
              expectedStatus: "running",
              status: "verifying",
              blocker: null,
            },
            {
              op: "set_status",
              nodeId: node.id,
              expectedStatus: "verifying",
              status: "complete",
              blocker: null,
            },
          );
          const graph = this.record.graph;
          for (const candidate of Object.values(graph.nodes)) {
            if (
              candidate.status === "queued" &&
              candidate.dependencyIds.every(
                (dependencyId) =>
                  dependencyId === node.id ||
                  graph.nodes[dependencyId]?.status === "complete",
              )
            ) {
              operations.push({
                op: "set_status",
                nodeId: candidate.id,
                expectedStatus: "queued",
                status: "ready",
                blocker: null,
              });
            }
          }
        }
        }
      } else {
        if (lifecycleState && lifecycleAction) {
          operations.push(
            lifecycleOutputsOperationV1(
              node.id,
              lifecycleState,
              lifecycleAction.id,
              false,
            ),
          );
        }
        const nextAttempts = node.retries.attempts + 1;
        const sameFailureCount =
          result.failureFingerprint &&
          node.retries.consecutiveFailureFingerprint === result.failureFingerprint
            ? node.retries.consecutiveFailureCount + 1
            : result.failureFingerprint
              ? 1
              : 0;
        const terminal =
          result.terminalFailure === true ||
          nextAttempts >= node.retries.maxAttempts ||
          sameFailureCount >= 2;
        operations.push({
          op: "set_status",
          nodeId: node.id,
          expectedStatus: "running",
          status: terminal ? "blocked" : "ready",
          blocker: terminal
            ? {
                code: result.terminalFailure === true
                  ? "tool_failure_terminal"
                  : "tool_failure_repeated",
                message:
                  result.failureMessage ??
                  `Tool ${execution.toolName} failed without a safe repair.`,
                requiredAction: "Inspect the failure evidence before resuming.",
              }
            : null,
        });
      }

      let graph: MissionGraphV3;
      try {
        graph = await this.applyUnlocked(
          `Record ${execution.toolName} result for ${execution.nodeId}.`,
          operations,
        );
      } finally {
        if (execution.lockLease) {
          await this.releaseNodeLocksUnlocked(execution.lockLease);
        }
      }
      return graph;
    });
  }

  /**
   * Persist that an already-started effectful tool is waiting on exact user
   * approval. The execution keeps its resource lease so another mutation
   * cannot race the prepared action while the approval surface is open.
   */
  async waitForToolApproval(
    execution: MissionGraphToolExecution,
  ): Promise<MissionGraphV3> {
    return this.enqueueMutation(async () => {
      const node = this.requireExecutionNode(execution, "running");
      if (node.effect === "read") {
        throw new Error(
          `Read-only mission node ${node.id} cannot wait for mutation approval.`,
        );
      }
      return this.applyUnlocked(`Wait for approval of mission node ${node.id}.`, [
        {
          op: "set_status",
          nodeId: node.id,
          expectedStatus: "running",
          status: "waiting_approval",
          blocker: null,
        },
      ]);
    });
  }

  /**
   * Resolve a durable approval wait. Approval resumes the same prepared
   * execution. Denial blocks the node and releases its resource lease.
   */
  async resolveToolApproval(
    execution: MissionGraphToolExecution,
    approved: boolean,
  ): Promise<MissionGraphV3> {
    return this.enqueueMutation(async () => {
      const node = this.requireExecutionNode(execution, "waiting_approval");
      const graph = await this.applyUnlocked(
        approved
          ? `Resume approved mission node ${node.id}.`
          : `Block denied mission node ${node.id}.`,
        [
          {
            op: "set_status",
            nodeId: node.id,
            expectedStatus: "waiting_approval",
            status: approved ? "running" : "blocked",
            blocker: approved
              ? null
              : {
                  code: "approval_denied",
                  message: `User denied approval for ${execution.toolName}.`,
                  requiredAction:
                    "Revise the mission or request a new exact approval before retrying.",
                },
          },
        ],
      );
      if (!approved && execution.lockLease) {
        await this.releaseNodeLocksUnlocked(execution.lockLease);
      }
      return graph;
    });
  }

  async completeFinalOutput(input: {
    outputFingerprint: string;
    observedAt: string;
  }): Promise<MissionGraphV3> {
    return this.enqueueMutation(async () => {
      const node =
        this.record.graph.nodes.final ??
        Object.values(this.record.graph.nodes).find(
          (candidate) =>
            candidate.allowedTools.length === 0 &&
            candidate.completionContract.requiredEvidenceKinds.some((kind) =>
              /final-output|final-relevance/i.test(kind),
            ) &&
            candidate.status !== "complete" &&
            candidate.status !== "cancelled",
        );
      if (!node || node.status === "complete") return this.graph;
      const dependenciesComplete = node.dependencyIds.every(
        (dependencyId) =>
          this.record.graph.nodes[dependencyId]?.status === "complete",
      );
      if (!dependenciesComplete) return this.graph;
      const operations: MissionGraphPatchOperationV1[] = [];
      let expectedStatus = node.status;
      if (expectedStatus === "queued") {
        operations.push({
          op: "set_status",
          nodeId: node.id,
          expectedStatus: "queued",
          status: "ready",
          blocker: null,
        });
        expectedStatus = "ready";
      }
      if (expectedStatus !== "ready") return this.graph;
      const finalEvidenceKind =
        node.completionContract.requiredEvidenceKinds.find((kind) =>
          /final-output|final-relevance/i.test(kind),
        ) ?? "final-output";
      operations.push(
        {
          op: "set_status",
          nodeId: node.id,
          expectedStatus: "ready",
          status: "running",
          blocker: null,
        },
        {
          op: "record_attempt",
          nodeId: node.id,
          failureFingerprint: null,
          observedAt: input.observedAt,
        },
        {
          op: "append_evidence",
          nodeId: node.id,
          evidence: {
            id: missionGraphLocalReferenceId(
              "final",
              node.id,
              this.record.graph.revision + 1,
            ),
            kind: finalEvidenceKind,
            fingerprint: input.outputFingerprint,
            observedAt: input.observedAt,
          },
        },
        {
          op: "set_status",
          nodeId: node.id,
          expectedStatus: "running",
          status: "verifying",
          blocker: null,
        },
        ...(node.completionContract.verifierId
          ? [
              {
                op: "record_verification" as const,
                nodeId: node.id,
                verification: {
                  verifierId: node.completionContract.verifierId,
                  status: "passed" as const,
                  fingerprint: input.outputFingerprint,
                  verifiedAt: input.observedAt,
                },
              },
            ]
          : []),
        {
          op: "set_status",
          nodeId: node.id,
          expectedStatus: "verifying",
          status: "complete",
          blocker: null,
        },
      );
      return this.applyUnlocked("Record accepted final output.", operations);
    });
  }

  async apply(
    reason: string,
    operations: MissionGraphPatchOperationV1[],
  ): Promise<MissionGraphV3> {
    return this.enqueueMutation(() => this.applyUnlocked(reason, operations));
  }

  async refineObjective(objective: string): Promise<MissionGraphV3> {
    const normalized = objective.trim().slice(0, 8_000);
    if (!normalized || normalized === this.record.graph.objective) {
      return this.graph;
    }
    const operations: MissionGraphPatchOperationV1[] = [
      { op: "set_objective", objective: normalized },
    ];
    const finalNode = this.record.graph.nodes.final;
    if (finalNode && finalNode.status !== "complete") {
      operations.push({
        op: "update_node",
        nodeId: finalNode.id,
        changes: {
          objective: `Deliver a verified final result for: ${normalized}`.slice(
            0,
            4_000,
          ),
        },
      });
    }
    return this.apply("Refine the mission objective from host-read context.", operations);
  }

  private async applyUnlocked(
    reason: string,
    operations: MissionGraphPatchOperationV1[],
  ): Promise<MissionGraphV3> {
    if (operations.length === 0) {
      return this.graph;
    }
    const now = this.now();
    const patch: MissionGraphPatchV1 = {
      version: 1,
      patchId: `${sanitizeMissionId(this.record.missionId)}-patch-${
        this.record.graph.revision + 1
      }-${++this.patchSequence}`,
      missionId: this.record.missionId,
      baseRevision: this.record.graph.revision,
      baseJournalFingerprint: this.record.graph.journalHeadFingerprint,
      proposedAt: now,
      reason: reason.slice(0, 2_000),
      operations: clone(operations),
    };
    const result = await persistMissionGraphPatchTransaction(
      this.context,
      this.record.missionId,
      patch,
      {
        expectedStoreRevision: this.record.storeRevision,
        preparedAt: now,
        appliedAt: now,
      },
    );
    this.record = result.record;
    this.emit(patch);
    return this.graph;
  }

  async transitionNode(
    nodeId: string,
    status: MissionNodeStatusV3,
    blocker: MissionBlockerV1 | null = null,
  ): Promise<MissionGraphV3> {
    const node = this.requireNode(nodeId);
    return this.apply(`Transition ${nodeId} to ${status}.`, [
      {
        op: "set_status",
        nodeId,
        expectedStatus: node.status,
        status,
        blocker,
      },
    ]);
  }

  async startNode(nodeId: string): Promise<MissionGraphV3> {
    const node = this.requireNode(nodeId);
    return this.apply(`Start mission node ${nodeId}.`, [
      {
        op: "set_status",
        nodeId,
        expectedStatus: node.status,
        status: "running",
        blocker: null,
      },
    ]);
  }

  async recordSuccessfulAttempt(nodeId: string): Promise<MissionGraphV3> {
    this.requireNode(nodeId);
    return this.apply(`Record successful attempt for mission node ${nodeId}.`, [
      {
        op: "record_attempt",
        nodeId,
        failureFingerprint: null,
        observedAt: this.now(),
      },
    ]);
  }

  async recordFailure(
    nodeId: string,
    failureFingerprint: string,
    blocker?: MissionBlockerV1,
  ): Promise<MissionGraphV3> {
    const node = this.requireNode(nodeId);
    const operations: MissionGraphPatchOperationV1[] = [
      {
        op: "record_attempt",
        nodeId,
        failureFingerprint,
        observedAt: this.now(),
      },
    ];
    if (blocker) {
      operations.push({
        op: "set_status",
        nodeId,
        expectedStatus: node.status,
        status: "blocked",
        blocker,
      });
    }
    return this.apply(`Record failure for mission node ${nodeId}.`, operations);
  }

  async appendEvidence(
    nodeId: string,
    evidence: MissionEvidenceRefV1,
  ): Promise<MissionGraphV3> {
    return this.apply(`Record evidence for mission node ${nodeId}.`, [
      { op: "append_evidence", nodeId, evidence },
    ]);
  }

  async appendReceipt(
    nodeId: string,
    receipt: MissionReceiptRefV1,
  ): Promise<MissionGraphV3> {
    return this.apply(`Record receipt for mission node ${nodeId}.`, [
      { op: "append_receipt", nodeId, receipt },
    ]);
  }

  async promoteReadyNodes(): Promise<MissionGraphV3> {
    const graph = this.record.graph;
    const operations: MissionGraphPatchOperationV1[] = Object.values(graph.nodes)
      .filter(
        (node) =>
          node.status === "queued" &&
          node.dependencyIds.every(
            (dependencyId) => graph.nodes[dependencyId]?.status === "complete",
          ),
      )
      .map((node) => ({
        op: "set_status" as const,
        nodeId: node.id,
        expectedStatus: "queued" as const,
        status: "ready" as const,
        blocker: null,
      }));
    return this.apply("Promote dependency-satisfied mission nodes.", operations);
  }

  async acquireNodeLocks(
    nodeId: string,
    leaseMs = EFFECTFUL_NODE_LOCK_LEASE_MS,
  ): Promise<MissionGraphLockLease | null> {
    return this.enqueueMutation(() =>
      this.acquireNodeLocksUnlocked(nodeId, leaseMs),
    );
  }

  private async acquireNodeLocksUnlocked(
    nodeId: string,
    leaseMs: number,
  ): Promise<MissionGraphLockLease | null> {
    const node = this.requireNode(nodeId);
    const resourceKeys = node.resourceLocks
      .filter((requirement) => requirement.mode === "exclusive")
      .map((requirement) => `binding:${requirement.bindingId}`);
    if (resourceKeys.length === 0) return null;
    const ownerId = `${this.record.missionId}/${nodeId}`;
    const acquired = acquireResourceLocks(this.record.resourceLocks, {
      resourceKeys,
      ownerId,
      at: this.now(),
      leaseMs,
    });
    if (!acquired.accepted || !acquired.token) {
      return null;
    }
    const persisted = await persistMissionGraphResourceLocks(
      this.context,
      this.record.missionId,
      acquired.state,
      { expectedStoreRevision: this.record.storeRevision },
    );
    this.record = persisted.record;
    return { nodeId, ownerId, token: acquired.token, resourceKeys };
  }

  async releaseNodeLocks(lease: MissionGraphLockLease): Promise<void> {
    await this.enqueueMutation(() => this.releaseNodeLocksUnlocked(lease));
  }

  private async releaseNodeLocksUnlocked(
    lease: MissionGraphLockLease,
  ): Promise<void> {
    const released = releaseResourceLocks(this.record.resourceLocks, {
      resourceKeys: lease.resourceKeys,
      ownerId: lease.ownerId,
      token: lease.token,
      at: this.now(),
    });
    if (!released.accepted) {
      throw new Error(
        `Mission graph lock release conflict: ${released.conflicts.join(", ")}.`,
      );
    }
    const persisted = await persistMissionGraphResourceLocks(
      this.context,
      this.record.missionId,
      released.state,
      { expectedStoreRevision: this.record.storeRevision },
    );
    this.record = persisted.record;
  }

  private requireNode(nodeId: string) {
    const node = this.record.graph.nodes[nodeId];
    if (!node) throw new Error(`Unknown mission graph node ${nodeId}.`);
    return node;
  }

  private requireExecutionNode(
    execution: MissionGraphToolExecution,
    expectedStatus: MissionNodeStatusV3,
  ) {
    const node = this.requireNode(execution.nodeId);
    const lifecycleAction = getCurrentMissionCompositeLifecycleActionV1(node);
    if (
      lifecycleAction
        ? lifecycleAction.toolName !== execution.toolName ||
          lifecycleAction.id !== execution.lifecycleActionId
        : !node.allowedTools.includes(execution.toolName)
    ) {
      throw new Error(
        `Tool ${execution.toolName} is not authorized for mission node ${node.id}.`,
      );
    }
    if (node.status !== expectedStatus) {
      throw new Error(
        `Mission node ${node.id} is ${node.status}; expected ${expectedStatus}.`,
      );
    }
    return node;
  }

  private now(): string {
    return (this.context.now?.() ?? new Date()).toISOString();
  }

  private emit(patch?: MissionGraphPatchV1): void {
    this.events.onGraphUpdate?.(this.graph, patch ? clone(patch) : undefined);
  }

  private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.catch(() => undefined).then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function normalizeEvidenceKindToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/gu, "-");
}

function missionNodeExpectsToolV1(
  node: MissionNodeV3,
  toolName: string,
): boolean {
  const lifecycle = getMissionCompositeLifecycleSpecV1(node);
  if (!lifecycle) return node.allowedTools.includes(toolName);
  return getCurrentMissionCompositeLifecycleActionV1(node)?.toolName === toolName;
}

function missionNodeContainsLifecycleToolV1(
  node: MissionNodeV3,
  toolName: string,
): boolean {
  return getMissionCompositeLifecycleSpecV1(node)?.actions.some(
    (action) => action.toolName === toolName,
  ) ?? false;
}

function actionProofMissingV1(
  action: MissionCompositeLifecycleActionV1,
  result: {
    evidence?: MissionEvidenceRefV1;
    receipt?: MissionReceiptRefV1;
  },
): boolean {
  const evidence = result.evidence ? [result.evidence] : [];
  const receipts = result.receipt ? [result.receipt] : [];
  return (
    evidence.length < action.minimumEvidence ||
    action.requiredEvidenceKinds.some(
      (kind) => !evidence.some((candidate) => candidate.kind === kind),
    ) ||
    receipts.length < action.minimumReceipts ||
    action.requiredReceiptKinds.some(
      (kind) => !receipts.some((candidate) => candidate.kind === kind),
    )
  );
}

function lifecycleOutputsOperationV1(
  nodeId: string,
  state: NonNullable<ReturnType<typeof getMissionCompositeLifecycleStateV1>>,
  actionId: string,
  completed: boolean,
): MissionGraphPatchOperationV1 {
  const completedActionIds = completed
    ? [...state.completedActionIds, actionId]
    : [...state.completedActionIds];
  return {
    op: "set_outputs",
    nodeId,
    outputs: {
      lifecycleActionCursor: state.actionCursor + (completed ? 1 : 0),
      lifecycleCompletedActionIds: completedActionIds,
      lifecycleActionAttemptCounts: {
        ...state.actionAttemptCounts,
        [actionId]: (state.actionAttemptCounts[actionId] ?? 0) + 1,
      },
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function findContinuationReserveNode(
  graph: MissionGraphV3,
): MissionNodeV3 | undefined {
  return (
    graph.nodes.final ??
    Object.values(graph.nodes).find(
      (node) =>
        node.status !== "cancelled" &&
        node.allowedTools.length === 0 &&
        node.completionContract.requiredEvidenceKinds.some((kind) =>
          /final-output|final-relevance/iu.test(kind),
        ),
    )
  );
}

/**
 * A dynamic continuation consumes host-reserved capacity; it does not mint a
 * larger envelope. Only surplus on the still-mutable final/continuation node
 * may cover an aggregate deficit. Already-completed nodes remain untouched.
 */
function transferReservedBudgetForContinuation(
  graph: MissionGraphV3,
  reserveNode: MissionNodeV3,
  requested: MissionNodeBudgetV1,
): {
  addedNodeBudget: MissionNodeBudgetV1;
  reserveNodeBudget: MissionNodeBudgetV1;
} {
  if (reserveNode.status === "complete" || reserveNode.status === "cancelled") {
    throw new Error("No nonterminal continuation budget reserve remains.");
  }
  const aggregate = Object.values(graph.nodes).reduce(
    (total, node) => ({
      toolCalls: total.toolCalls + node.budget.toolCalls,
      externalActions: total.externalActions + node.budget.externalActions,
      wallClockMs: total.wallClockMs + node.budget.wallClockMs,
    }),
    { toolCalls: 0, externalActions: 0, wallClockMs: 0 },
  );
  const headroom = {
    toolCalls: Math.max(
      0,
      graph.capabilityEnvelope.budgets.maxTotalToolCalls - aggregate.toolCalls,
    ),
    externalActions: Math.max(
      0,
      graph.capabilityEnvelope.budgets.maxExternalActions -
        aggregate.externalActions,
    ),
    wallClockMs: Math.max(
      0,
      graph.capabilityEnvelope.budgets.maxWallClockMs - aggregate.wallClockMs,
    ),
  };
  const transfer = {
    toolCalls: Math.max(0, requested.toolCalls - headroom.toolCalls),
    externalActions: Math.max(
      0,
      requested.externalActions - headroom.externalActions,
    ),
    wallClockMs: Math.max(0, requested.wallClockMs - headroom.wallClockMs),
  };
  const minimumReserve = {
    toolCalls: reserveNode.allowedTools.length,
    externalActions: reserveNode.effect === "external_action" ? 1 : 0,
    wallClockMs: 1,
  };
  const available = {
    toolCalls: reserveNode.budget.toolCalls - minimumReserve.toolCalls,
    externalActions:
      reserveNode.budget.externalActions - minimumReserve.externalActions,
    wallClockMs: reserveNode.budget.wallClockMs - minimumReserve.wallClockMs,
  };
  if (
    transfer.toolCalls > available.toolCalls ||
    transfer.externalActions > available.externalActions ||
    transfer.wallClockMs > available.wallClockMs
  ) {
    throw new Error(
      "The host envelope is exhausted and its nonterminal continuation node lacks enough reserved budget.",
    );
  }
  return {
    addedNodeBudget: clone(requested),
    reserveNodeBudget: {
      toolCalls: reserveNode.budget.toolCalls - transfer.toolCalls,
      externalActions:
        reserveNode.budget.externalActions - transfer.externalActions,
      wallClockMs: reserveNode.budget.wallClockMs - transfer.wallClockMs,
    },
  };
}

function sanitizeMissionId(missionId: string): string {
  return (
    missionId
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "mission"
  );
}

function missionGraphLocalReferenceId(
  kind: string,
  nodeId: string,
  revision: number,
): string {
  return `${sanitizeMissionId(kind)}:${Math.max(0, Math.trunc(revision))}:${sanitizeMissionId(
    nodeId,
  )}`.slice(0, 128);
}
