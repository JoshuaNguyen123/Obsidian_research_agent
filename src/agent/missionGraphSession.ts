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
import { collectRequiredDependencyIds } from "./missionGraphAuthority";
import { sha256Fingerprint } from "../../packages/headless-runtime/src/canonicalize";

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
    options: {
      allowDynamicReadContinuation?: boolean;
      /** Keep an unplanned companion outside the required final closure. */
      optionalDynamicContinuation?: boolean;
      /** Disable only when the host intentionally prestarts parallel calls. */
      recoverOrphanedRunning?: boolean;
    } = {},
  ): Promise<MissionGraphToolStartResult> {
    return this.enqueueMutation(async () => {
      let node = Object.values(this.record.graph.nodes).find(
        (candidate) =>
          candidate.status === "ready" &&
          missionNodeExpectsToolV1(candidate, toolName),
      );
      // Host early-returns that forget finishToolExecution can leave a node
      // stuck in running with an empty ready frontier. Heal before begin.
      if (!node && options.recoverOrphanedRunning !== false) {
        const orphanedRunning = Object.values(this.record.graph.nodes).find(
          (candidate) =>
            candidate.status === "running" &&
            missionNodeExpectsToolV1(candidate, toolName),
        );
        if (orphanedRunning) {
          await this.releaseOrphanedNodeLocksUnlocked(orphanedRunning.id);
          await this.applyUnlocked(
            `Recover orphaned running mission node ${orphanedRunning.id}.`,
            [
              {
                op: "set_status",
                nodeId: orphanedRunning.id,
                expectedStatus: "running",
                status: "ready",
                blocker: null,
              },
            ],
          );
          node = this.record.graph.nodes[orphanedRunning.id];
        }
      }
      if (!node) {
        const terminalFailure = Object.values(this.record.graph.nodes).find(
          (candidate) =>
            candidate.status === "blocked" &&
            missionNodeExpectsToolV1(candidate, toolName) &&
            (candidate.blocker?.code === "tool_failure_terminal" ||
              candidate.blocker?.code === "tool_failure_repeated" ||
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
          const lifecycleSpec =
            getMissionCompositeLifecycleSpecV1(lifecycleNode);
          const replayed =
            state &&
            lifecycleSpec?.actions
              .filter((action) =>
                state.completedActionIds.includes(action.id),
              )
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
        const optionalDynamicContinuation =
          options.optionalDynamicContinuation === true;
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
          const dynamicId = `${optionalDynamicContinuation ? "optional-retry" : "retry"}-${this.record.graph.revision + 1}-${sanitizeMissionId(
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
          const continuationOperations: MissionGraphPatchOperationV1[] =
            optionalDynamicContinuation
              ? [
                  {
                    op: "update_node",
                    nodeId: continuationNode.id,
                    changes: {
                      budget: continuationBudget,
                    },
                  },
                ]
              : continuationNode.status === "ready"
                ? [
                    { op: "remove_node", nodeId: continuationNode.id },
                    {
                      op: "add_node",
                      node: {
                        ...clone(continuationNode),
                        dependencyIds: [
                          ...new Set([
                            ...continuationNode.dependencyIds,
                            dynamicId,
                          ]),
                        ].sort(),
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
                        dependencyIds: [
                          ...new Set([
                            ...continuationNode.dependencyIds,
                            dynamicId,
                          ]),
                        ].sort(),
                        budget: continuationBudget,
                      },
                    },
                  ];
          try {
            await this.applyUnlocked(
              `Add bounded effectful continuation for ${toolName}.`,
              [
                { op: "add_node", node: dynamicNode },
                ...continuationOperations,
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
        const dynamicId = `${optionalDynamicContinuation ? "optional-retry" : "retry"}-${this.record.graph.revision + 1}-${sanitizeMissionId(
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
        const continuationOperations: MissionGraphPatchOperationV1[] = [];
        if (
          continuationNode &&
          optionalDynamicContinuation &&
          continuationBudget
        ) {
          continuationOperations.push({
            op: "update_node",
            nodeId: continuationNode.id,
            changes: { budget: continuationBudget },
          });
        } else if (continuationNode?.status === "ready") {
          continuationOperations.push(
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
          );
        } else if (continuationNode) {
          continuationOperations.push({
            op: "update_node",
            nodeId: continuationNode.id,
            changes: {
              dependencyIds: [
                ...new Set([...continuationNode.dependencyIds, dynamicId]),
              ].sort(),
              ...(continuationBudget ? { budget: continuationBudget } : {}),
            },
          });
        }
        try {
          await this.applyUnlocked(`Add bounded read retry for ${toolName}.`, [
            { op: "add_node", node: dynamicNode },
            ...continuationOperations,
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
      /** Conditional actions proved unnecessary by the just-finished result. */
      skipNextToolNames?: string[];
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
              lifecycle!,
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
          nextLifecycleCursor(
            lifecycle,
            lifecycleState.actionCursor,
            result.skipNextToolNames,
          ) < lifecycle.actions.length
        ) {
          operations.push(
            lifecycleOutputsOperationV1(
              node.id,
              lifecycleState,
              lifecycle,
              lifecycleAction.id,
              true,
              result.skipNextToolNames,
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
                lifecycle!,
                lifecycleAction.id,
                true,
                result.skipNextToolNames,
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
          const projectedCompletedNodeIds = new Set(
            Object.values(graph.nodes)
              .filter((candidate) => candidate.status === "complete")
              .map((candidate) => candidate.id),
          );
          projectedCompletedNodeIds.add(node.id);
          for (const candidate of Object.values(graph.nodes)) {
            if (
              candidate.status === "queued" &&
              !isFastValidationAwaitingCorrection(graph, candidate.id) &&
              candidate.dependencyIds.every(
                (dependencyId) =>
                  projectedCompletedNodeIds.has(dependencyId),
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
              lifecycle!,
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
      if (
        result.ok &&
        execution.toolName === "code_workspace_write_expected"
      ) {
        graph = await this.reconcileCreateFileCollisionOriginUnlocked(
          this.record.graph.nodes[execution.nodeId]!,
          result,
        );
      }
      if (result.ok) {
        graph = await this.reconcileValidationRecoveryOriginUnlocked(
          this.record.graph.nodes[execution.nodeId]!,
        );
      }
      return graph;
    });
  }

  /**
   * A recorded `repaired` outcome proves only that one red fast-validation
   * receipt was journaled. Before that repair node completes, insert the next
   * bounded fast-validation -> repair-record pair and make every unfinished
   * direct dependent wait for it. Scheduling before completion is deliberate:
   * there is never a durable graph revision where targeted/full validation can
   * become ready without a receipt-backed passing fast cycle.
   */
  async scheduleRepairedFastValidationCycle(
    execution: MissionGraphToolExecution,
  ): Promise<MissionGraphV3> {
    return this.enqueueMutation(async () => {
      const repairTemplate = this.requireNode(execution.nodeId);
      if (
        execution.toolName !== "code_repair_record_cycle" ||
        repairTemplate.status !== "running"
      ) {
        throw new Error(
          `A repaired fast-validation continuation requires a running code_repair_record_cycle node; ${repairTemplate.id} is ${repairTemplate.status}.`,
        );
      }
      if (getMissionCompositeLifecycleSpecV1(repairTemplate)) {
        throw new Error(
          "A repaired fast-validation continuation cannot rewrite a composite lifecycle cursor.",
        );
      }

      const downstreamIds = new Set([repairTemplate.id]);
      let discoveredDownstream = true;
      while (discoveredDownstream) {
        discoveredDownstream = false;
        for (const candidate of Object.values(this.record.graph.nodes)) {
          if (
            candidate.status === "cancelled" ||
            downstreamIds.has(candidate.id) ||
            !candidate.dependencyIds.some((dependencyId) =>
              downstreamIds.has(dependencyId),
            )
          ) {
            continue;
          }
          downstreamIds.add(candidate.id);
          discoveredDownstream = true;
        }
      }
      const plannedFastNodes = Object.values(this.record.graph.nodes).filter(
        (candidate) =>
          candidate.id !== repairTemplate.id &&
          downstreamIds.has(candidate.id) &&
          candidate.status !== "complete" &&
          candidate.allowedTools.includes("code_validate_fast"),
      );
      const alreadyScheduled = plannedFastNodes.some((fastNode) =>
        Object.values(this.record.graph.nodes).some(
          (candidate) =>
            downstreamIds.has(candidate.id) &&
            candidate.status !== "complete" &&
            candidate.allowedTools.includes("code_repair_record_cycle") &&
            candidate.dependencyIds.includes(fastNode.id),
        ),
      );
      const parallelPairAlreadyScheduled = Object.values(
        this.record.graph.nodes,
      )
        .filter((candidate) =>
          candidate.dependencyIds.includes(repairTemplate.id),
        )
        .some((dependent) =>
          dependent.dependencyIds.some((dependencyId) => {
            const repeatedRepair = this.record.graph.nodes[dependencyId];
            if (
              !repeatedRepair ||
              repeatedRepair.id === repairTemplate.id ||
              repeatedRepair.status === "complete" ||
              !repeatedRepair.allowedTools.includes(
                "code_repair_record_cycle",
              )
            ) {
              return false;
            }
            return repeatedRepair.dependencyIds.some((fastDependencyId) =>
              this.record.graph.nodes[
                fastDependencyId
              ]?.allowedTools.includes("code_validate_fast"),
            );
          }),
        );
      if (alreadyScheduled || parallelPairAlreadyScheduled) {
        return this.record.graph;
      }

      const fastTemplate = repairTemplate.dependencyIds
        .map((dependencyId) => this.record.graph.nodes[dependencyId])
        .find(
          (candidate) =>
            candidate?.status === "complete" &&
            candidate.allowedTools.includes("code_validate_fast"),
        );
      if (!fastTemplate) {
        throw new Error(
          `Repair node ${repairTemplate.id} has no completed fast-validation dependency to repeat.`,
        );
      }
      const downstreamNodes = Object.values(this.record.graph.nodes).filter(
        (candidate) =>
          candidate.dependencyIds.includes(repairTemplate.id) &&
          candidate.status !== "complete" &&
          candidate.status !== "cancelled",
      );
      if (downstreamNodes.length === 0) {
        throw new Error(
          `Repair node ${repairTemplate.id} has no unfinished downstream proof gate.`,
        );
      }

      const reserveNode = findContinuationReserveNode(this.record.graph);
      if (!reserveNode || reserveNode.id === repairTemplate.id) {
        throw new Error(
          "A repaired fast-validation continuation has no nonterminal continuation budget reserve.",
        );
      }
      const requestedBudget: MissionNodeBudgetV1 = {
        toolCalls:
          fastTemplate.budget.toolCalls + repairTemplate.budget.toolCalls,
        externalActions:
          fastTemplate.budget.externalActions +
          repairTemplate.budget.externalActions,
        wallClockMs:
          fastTemplate.budget.wallClockMs +
          repairTemplate.budget.wallClockMs,
      };
      const allocation = transferReservedBudgetForContinuation(
        this.record.graph,
        reserveNode,
        requestedBudget,
      );
      const idSuffix = sanitizeMissionId(
        `${this.record.graph.revision + 1}-${repairTemplate.id}`,
      );
      const fastNodeId = `repair-fast-${idSuffix}`.slice(0, 128);
      const repairNodeId = `repair-record-${idSuffix}`.slice(0, 128);
      if (
        this.record.graph.nodes[fastNodeId] ||
        this.record.graph.nodes[repairNodeId]
      ) {
        throw new Error(
          `The repaired fast-validation continuation IDs for ${repairTemplate.id} already exist without their durable origin marker.`,
        );
      }
      const resetRetries = (template: MissionNodeV3) => ({
        maxAttempts: template.retries.maxAttempts,
        attempts: 0,
        failureFingerprints: [],
        consecutiveFailureFingerprint: null,
        consecutiveFailureCount: 0,
      });
      const fastNode: MissionNodeV3 = {
        ...clone(fastTemplate),
        id: fastNodeId,
        dependencyIds: [...fastTemplate.dependencyIds],
        objective:
          `Run a fresh fast validation after recorded repair cycle ${repairTemplate.id}; downstream validation remains gated on its exact receipt.`.slice(
            0,
            4_000,
          ),
        outputs: {},
        retries: resetRetries(fastTemplate),
        status: "queued",
        evidence: [],
        receipts: [],
        verification: null,
        blocker: null,
      };
      const repairNode: MissionNodeV3 = {
        ...clone(repairTemplate),
        id: repairNodeId,
        dependencyIds: [
          ...new Set([...repairTemplate.dependencyIds, fastNodeId]),
        ].sort(),
        objective:
          `Record the exact result of fresh fast validation ${fastNodeId}; only outcome passed may unlock downstream validation.`.slice(
            0,
            4_000,
          ),
        outputs: {
          validationRecovery: {
            version: 1,
            status: "awaiting_correction",
            failedToolName: "code_validate_fast",
            failedAt: this.now(),
            fastNodeId,
            repairNodeId,
            targetedNodeId: null,
            originRepairNodeId: repairTemplate.id,
            correction: null,
          },
        },
        retries: resetRetries(repairTemplate),
        status: "queued",
        evidence: [],
        receipts: [],
        verification: null,
        blocker: null,
      };
      const operations: MissionGraphPatchOperationV1[] = [
        { op: "add_node", node: fastNode },
        { op: "add_node", node: repairNode },
        ...downstreamNodes.map(
          (candidate): MissionGraphPatchOperationV1 => ({
            op: "update_node",
            nodeId: candidate.id,
            changes: {
              dependencyIds: [
                ...new Set([...candidate.dependencyIds, repairNodeId]),
              ].sort(),
            },
          }),
        ),
      ];
      if (
        JSON.stringify(allocation.reserveNodeBudget) !==
        JSON.stringify(reserveNode.budget)
      ) {
        operations.push({
          op: "update_node",
          nodeId: reserveNode.id,
          changes: { budget: allocation.reserveNodeBudget },
        });
      }
      return this.applyUnlocked(
        `Gate downstream validation on a fresh fast cycle after repaired outcome from ${repairTemplate.id}.`,
        operations,
      );
    });
  }

  /**
   * A red targeted/full validator is evidence that the current workspace is
   * not publishable. Requeue that exact validator behind a fresh fast/repair
   * chain (and a fresh targeted validator before a failed full validator),
   * while durably requiring one actual workspace mutation before the new fast
   * node may be offered. This prevents unchanged red validation retries from
   * exhausting the node and preserves the original capability/budget envelope.
   */
  async finishFailedValidationWithRecovery(
    execution: MissionGraphToolExecution,
    result: {
      evidence?: MissionEvidenceRefV1;
      receipt?: MissionReceiptRefV1;
      failureFingerprint: string;
      failureMessage: string;
    },
  ): Promise<{ graph: MissionGraphV3; scheduled: boolean }> {
    return this.enqueueMutation(async () => {
      const validationNode = this.requireNode(execution.nodeId);
      if (
        !["code_validate_targeted", "code_validate_full"].includes(
          execution.toolName,
        ) ||
        validationNode.status !== "running"
      ) {
        throw new Error(
          `Validation recovery requires a running targeted/full validator; ${validationNode.id} is ${validationNode.status}.`,
        );
      }
      const lifecycle = getMissionCompositeLifecycleSpecV1(validationNode);
      if (lifecycle) {
        return this.finishFailedCompositeValidationWithRecoveryUnlocked(
          execution,
          validationNode,
          lifecycle,
          result,
        );
      }

      const operations: MissionGraphPatchOperationV1[] = [
        {
          op: "record_attempt",
          nodeId: validationNode.id,
          failureFingerprint: result.failureFingerprint,
          observedAt: this.now(),
        },
      ];
      if (result.evidence) {
        operations.push({
          op: "append_evidence",
          nodeId: validationNode.id,
          evidence: result.evidence,
        });
      }
      if (result.receipt) {
        operations.push({
          op: "append_receipt",
          nodeId: validationNode.id,
          receipt: result.receipt,
        });
      }

      const nextAttempts = validationNode.retries.attempts + 1;
      if (nextAttempts >= validationNode.retries.maxAttempts) {
        operations.push(
          {
            op: "set_outputs",
            nodeId: validationNode.id,
            outputs: {
              ...validationNode.outputs,
              validationRecovery: {
                version: 1,
                status: "exhausted",
                failedToolName: execution.toolName,
                failureFingerprint: result.failureFingerprint,
                failedAt: this.now(),
              },
            },
          },
          {
            op: "set_status",
            nodeId: validationNode.id,
            expectedStatus: "running",
            status: "blocked",
            blocker: {
              code: "validation_repair_cycles_exhausted",
              message:
                "Validation remained red after the bounded correction cycles.",
              requiredAction:
                "Inspect the latest validation diagnostic before starting a new explicitly authorized repair run.",
            },
          },
        );
        let graph: MissionGraphV3;
        try {
          graph = await this.applyUnlocked(
            `Block ${execution.toolName} after bounded validation recovery was exhausted.`,
            operations,
          );
        } finally {
          if (execution.lockLease) {
            await this.releaseNodeLocksUnlocked(execution.lockLease);
          }
        }
        return { graph, scheduled: false };
      }

      const ancestorIds = new Set<string>();
      const pendingAncestors = [...validationNode.dependencyIds];
      while (pendingAncestors.length > 0) {
        const candidateId = pendingAncestors.pop()!;
        if (ancestorIds.has(candidateId)) continue;
        ancestorIds.add(candidateId);
        const candidate = this.record.graph.nodes[candidateId];
        if (candidate) pendingAncestors.push(...candidate.dependencyIds);
      }
      const completedAncestors = Object.values(this.record.graph.nodes).filter(
        (candidate) =>
          ancestorIds.has(candidate.id) && candidate.status === "complete",
      );
      const repairTemplate = completedAncestors
        .filter((candidate) =>
          candidate.allowedTools.includes("code_repair_record_cycle"),
        )
        .at(-1);
      const fastTemplate = repairTemplate?.dependencyIds
        .map((dependencyId) => this.record.graph.nodes[dependencyId])
        .filter(
          (candidate): candidate is MissionNodeV3 =>
            Boolean(
              candidate?.status === "complete" &&
                candidate.allowedTools.includes("code_validate_fast"),
            ),
        )
        .at(-1);
      if (!repairTemplate || !fastTemplate) {
        throw new Error(
          `${execution.toolName} recovery requires completed fast-validation and repair-record ancestors.`,
        );
      }
      const targetedTemplate =
        execution.toolName === "code_validate_full"
          ? validationNode.dependencyIds
              .map((dependencyId) => this.record.graph.nodes[dependencyId])
              .filter(
                (candidate): candidate is MissionNodeV3 =>
                  Boolean(
                    candidate?.status === "complete" &&
                      candidate.allowedTools.includes(
                        "code_validate_targeted",
                      ),
                  ),
              )
              .at(-1)
          : null;
      if (
        execution.toolName === "code_validate_full" &&
        !targetedTemplate
      ) {
        throw new Error(
          "Full-validation recovery requires a completed targeted-validation dependency to repeat.",
        );
      }

      const requestedBudget: MissionNodeBudgetV1 = {
        toolCalls:
          fastTemplate.budget.toolCalls +
          repairTemplate.budget.toolCalls +
          (targetedTemplate?.budget.toolCalls ?? 0),
        externalActions:
          fastTemplate.budget.externalActions +
          repairTemplate.budget.externalActions +
          (targetedTemplate?.budget.externalActions ?? 0),
        wallClockMs:
          fastTemplate.budget.wallClockMs +
          repairTemplate.budget.wallClockMs +
          (targetedTemplate?.budget.wallClockMs ?? 0),
      };
      const reserveNode = findContinuationReserveNode(this.record.graph);
      if (!reserveNode || reserveNode.id === validationNode.id) {
        throw new Error(
          "Validation recovery has no nonterminal continuation budget reserve.",
        );
      }
      const allocation = transferReservedBudgetForContinuation(
        this.record.graph,
        reserveNode,
        requestedBudget,
      );
      const idSuffix = sanitizeMissionId(
        `${this.record.graph.revision + 1}-${validationNode.id}`,
      );
      const fastNodeId = `validation-recovery-fast-${idSuffix}`.slice(0, 128);
      const repairNodeId =
        `validation-recovery-record-${idSuffix}`.slice(0, 128);
      const targetedNodeId =
        `validation-recovery-targeted-${idSuffix}`.slice(0, 128);
      for (const nodeId of [
        fastNodeId,
        repairNodeId,
        ...(targetedTemplate ? [targetedNodeId] : []),
      ]) {
        if (this.record.graph.nodes[nodeId]) {
          throw new Error(
            `Validation recovery node ${nodeId} already exists without its durable origin marker.`,
          );
        }
      }
      const resetRetries = (template: MissionNodeV3) => ({
        maxAttempts: template.retries.maxAttempts,
        attempts: 0,
        failureFingerprints: [],
        consecutiveFailureFingerprint: null,
        consecutiveFailureCount: 0,
      });
      const fastNode: MissionNodeV3 = {
        ...clone(fastTemplate),
        id: fastNodeId,
        dependencyIds: [...fastTemplate.dependencyIds],
        objective:
          `Run fresh fast validation only after a receipt-backed correction for red ${validationNode.id}.`.slice(
            0,
            4_000,
          ),
        outputs: {},
        retries: resetRetries(fastTemplate),
        status: "queued",
        evidence: [],
        receipts: [],
        verification: null,
        blocker: null,
      };
      const repairNode: MissionNodeV3 = {
        ...clone(repairTemplate),
        id: repairNodeId,
        dependencyIds: [
          ...new Set([
            ...repairTemplate.dependencyIds.filter(
              (dependencyId) =>
                !this.record.graph.nodes[
                  dependencyId
                ]?.allowedTools.includes("code_validate_fast"),
            ),
            fastNodeId,
          ]),
        ].sort(),
        objective:
          `Record the exact result of recovery fast validation ${fastNodeId}.`.slice(
            0,
            4_000,
          ),
        outputs: {},
        retries: resetRetries(repairTemplate),
        status: "queued",
        evidence: [],
        receipts: [],
        verification: null,
        blocker: null,
      };
      const targetedNode: MissionNodeV3 | null = targetedTemplate
        ? {
            ...clone(targetedTemplate),
            id: targetedNodeId,
            dependencyIds: [
              ...new Set([
                ...targetedTemplate.dependencyIds,
                repairNodeId,
              ]),
            ].sort(),
            objective:
              `Run fresh targeted validation after recovery receipt ${repairNodeId} before retrying full validation.`.slice(
                0,
                4_000,
              ),
            outputs: {},
            retries: resetRetries(targetedTemplate),
            status: "queued" as const,
            evidence: [],
            receipts: [],
            verification: null,
            blocker: null,
          }
        : null;
      const nextDependencyId = targetedNode?.id ?? repairNode.id;
      operations.push(
        { op: "add_node", node: fastNode },
        { op: "add_node", node: repairNode },
        ...(targetedNode
          ? [{ op: "add_node" as const, node: targetedNode }]
          : []),
        {
          op: "update_node",
          nodeId: validationNode.id,
          changes: {
            dependencyIds: [
              ...new Set([
                ...validationNode.dependencyIds,
                nextDependencyId,
              ]),
            ].sort(),
          },
        },
        {
          op: "set_outputs",
          nodeId: validationNode.id,
          outputs: {
            ...validationNode.outputs,
            validationRecovery: {
              version: 1,
              status: "awaiting_correction",
              failedToolName: execution.toolName,
              failureFingerprint: result.failureFingerprint,
              failedAt: this.now(),
              fastNodeId,
              repairNodeId,
              targetedNodeId: targetedNode?.id ?? null,
              correction: null,
            },
          },
        },
      );
      if (
        JSON.stringify(allocation.reserveNodeBudget) !==
        JSON.stringify(reserveNode.budget)
      ) {
        operations.push({
          op: "update_node",
          nodeId: reserveNode.id,
          changes: { budget: allocation.reserveNodeBudget },
        });
      }
      operations.push({
        op: "set_status",
        nodeId: validationNode.id,
        expectedStatus: "running",
        status: "queued",
        blocker: null,
      });

      let graph: MissionGraphV3;
      try {
        graph = await this.applyUnlocked(
          `Require a workspace correction and fresh validation chain after red ${execution.toolName}.`,
          operations,
        );
      } finally {
        if (execution.lockLease) {
          await this.releaseNodeLocksUnlocked(execution.lockLease);
        }
      }
      return { graph, scheduled: true };
    });
  }

  /**
   * Composite validation stages keep their closed action literal immutable.
   * A red targeted/full action therefore cannot splice recovery actions into
   * the cursor. Instead, clone the already-authorized validation stage as one
   * bounded sibling, hold it behind a receipt-backed correction gate, and
   * reconcile its complete proof back into the blocked origin. The clone has
   * the exact authority signature and depth of the original stage, so this
   * consumes only host-reserved budget and never widens tools, bindings, or
   * graph depth.
   */
  private async finishFailedCompositeValidationWithRecoveryUnlocked(
    execution: MissionGraphToolExecution,
    validationNode: MissionNodeV3,
    lifecycle: NonNullable<
      ReturnType<typeof getMissionCompositeLifecycleSpecV1>
    >,
    result: {
      evidence?: MissionEvidenceRefV1;
      receipt?: MissionReceiptRefV1;
      failureFingerprint: string;
      failureMessage: string;
    },
  ): Promise<{ graph: MissionGraphV3; scheduled: boolean }> {
    const lifecycleState = getMissionCompositeLifecycleStateV1(validationNode);
    const lifecycleAction =
      getCurrentMissionCompositeLifecycleActionV1(validationNode);
    if (
      !lifecycleState ||
      !lifecycleAction ||
      lifecycleAction.toolName !== execution.toolName ||
      lifecycleAction.id !== execution.lifecycleActionId
    ) {
      throw new Error(
        `Validation recovery no longer matches the durable composite lifecycle cursor for ${validationNode.id}.`,
      );
    }

    const recoveryDepth = this.validationRecoveryDepthUnlocked(
      validationNode.id,
    );
    const nextAttempts = recoveryDepth + 1;
    const failedOutputs = {
      ...validationNode.outputs,
      lifecycleActionCursor: lifecycleState.actionCursor,
      lifecycleCompletedActionIds: [...lifecycleState.completedActionIds],
      lifecycleSkippedActionIds: [...lifecycleState.skippedActionIds],
      lifecycleActionAttemptCounts: {
        ...lifecycleState.actionAttemptCounts,
        [lifecycleAction.id]:
          (lifecycleState.actionAttemptCounts[lifecycleAction.id] ?? 0) + 1,
      },
    };
    const operations: MissionGraphPatchOperationV1[] = [
      {
        op: "record_attempt",
        nodeId: validationNode.id,
        failureFingerprint: result.failureFingerprint,
        observedAt: this.now(),
      },
    ];
    if (result.evidence) {
      operations.push({
        op: "append_evidence",
        nodeId: validationNode.id,
        evidence: result.evidence,
      });
    }
    if (result.receipt) {
      operations.push({
        op: "append_receipt",
        nodeId: validationNode.id,
        receipt: result.receipt,
      });
    }

    if (nextAttempts >= validationNode.retries.maxAttempts) {
      operations.push(
        {
          op: "set_outputs",
          nodeId: validationNode.id,
          outputs: failedOutputs,
        },
        {
          op: "set_status",
          nodeId: validationNode.id,
          expectedStatus: "running",
          status: "blocked",
          blocker: {
            code: "validation_repair_cycles_exhausted",
            message:
              "Validation remained red after the bounded correction cycles.",
            requiredAction:
              "Inspect the latest validation diagnostic before starting a new explicitly authorized repair run.",
          },
        },
      );
      let graph: MissionGraphV3;
      try {
        graph = await this.applyUnlocked(
          `Block ${execution.toolName} after bounded composite validation recovery was exhausted.`,
          operations,
        );
      } finally {
        if (execution.lockLease) {
          await this.releaseNodeLocksUnlocked(execution.lockLease);
        }
      }
      return { graph, scheduled: false };
    }

    const reserveNode = findContinuationReserveNode(this.record.graph);
    if (!reserveNode || reserveNode.id === validationNode.id) {
      throw new Error(
        "Composite validation recovery has no nonterminal continuation budget reserve.",
      );
    }
    const allocation = transferReservedBudgetForContinuation(
      this.record.graph,
      reserveNode,
      validationNode.budget,
    );
    const recoveryNodeId =
      `validation-recovery-stage-${sanitizeMissionId(
        `${this.record.graph.revision + 1}-${validationNode.id}`,
      )}`.slice(0, 128);
    if (this.record.graph.nodes[recoveryNodeId]) {
      throw new Error(
        `Composite validation recovery node ${recoveryNodeId} already exists without its durable origin marker.`,
      );
    }
    const recoveryNode: MissionNodeV3 = {
      ...clone(validationNode),
      id: recoveryNodeId,
      objective:
        `Repeat the closed ${lifecycle.stage} proof stage after a receipt-backed correction for red ${execution.toolName} on ${validationNode.id}.`.slice(
          0,
          4_000,
        ),
      outputs: {},
      retries: {
        maxAttempts: validationNode.retries.maxAttempts,
        attempts: 0,
        failureFingerprints: [],
        consecutiveFailureFingerprint: null,
        consecutiveFailureCount: 0,
      },
      status: "queued",
      evidence: [],
      receipts: [],
      verification: null,
      blocker: null,
    };
    operations.push(
      { op: "add_node", node: recoveryNode },
      {
        op: "set_outputs",
        nodeId: validationNode.id,
        outputs: failedOutputs,
      },
      {
        op: "set_status",
        nodeId: validationNode.id,
        expectedStatus: "running",
        status: "blocked",
        blocker: {
          code: "validation_recovery_pending",
          message: `Validation action ${execution.toolName} is red and requires one receipt-backed workspace correction.`,
          requiredAction: compositeValidationRecoveryRequiredActionV1(
            recoveryNodeId,
          ),
        },
      },
    );
    if (
      JSON.stringify(allocation.reserveNodeBudget) !==
      JSON.stringify(reserveNode.budget)
    ) {
      operations.push({
        op: "update_node",
        nodeId: reserveNode.id,
        changes: { budget: allocation.reserveNodeBudget },
      });
    }

    let graph: MissionGraphV3;
    try {
      graph = await this.applyUnlocked(
        `Gate a closed composite validation retry on a workspace correction after red ${execution.toolName}.`,
        operations,
      );
    } finally {
      if (execution.lockLease) {
        await this.releaseNodeLocksUnlocked(execution.lockLease);
      }
    }
    return { graph, scheduled: true };
  }

  private validationRecoveryDepthUnlocked(nodeId: string): number {
    const seen = new Set<string>();
    let currentNodeId = nodeId;
    let depth = 0;
    while (!seen.has(currentNodeId)) {
      seen.add(currentNodeId);
      const parent = Object.values(this.record.graph.nodes).find(
        (candidate) => {
          const recovery = candidate.outputs.validationRecovery;
          return (
            recovery !== null &&
            typeof recovery === "object" &&
            !Array.isArray(recovery) &&
            (recovery as Record<string, unknown>).recoveryNodeId ===
              currentNodeId
          );
        },
      );
      const compositeParent = Object.values(this.record.graph.nodes).find(
        (candidate) =>
          compositeValidationRecoveryNodeIdV1(candidate) === currentNodeId,
      );
      const resolvedParent = parent ?? compositeParent;
      if (!resolvedParent) break;
      depth += 1;
      currentNodeId = resolvedParent.id;
    }
    return depth;
  }

  /**
   * Pay the durable correction gate only from a successful, receipt-backed
   * adaptive workspace mutation. Reads, prose, and unchanged validator calls
   * cannot unlock the recovery fast node.
   */
  async recordValidationRecoveryCorrection(input: {
    toolName: string;
    path: string;
    eligiblePaths: readonly string[];
    receiptId: string;
    receiptFingerprint: string;
    observedAt: string;
  }): Promise<{ graph: MissionGraphV3; recorded: boolean }> {
    return this.enqueueMutation(async () => {
      if (
        ![
          "code_workspace_create_file",
          "code_workspace_append",
          "code_workspace_patch",
          "code_workspace_write_expected",
        ].includes(input.toolName)
      ) {
        return { graph: this.record.graph, recorded: false };
      }
      const normalizedPath = normalizeValidationRecoveryPath(input.path);
      const eligiblePaths = [
        ...new Set(
          input.eligiblePaths
            .map(normalizeValidationRecoveryPath)
            .filter(Boolean),
        ),
      ].sort();
      if (
        !normalizedPath ||
        eligiblePaths.length === 0 ||
        !eligiblePaths.includes(normalizedPath)
      ) {
        return { graph: this.record.graph, recorded: false };
      }
      const recoveryNode = Object.values(this.record.graph.nodes).find(
        (candidate) => {
          if (
            candidate.status !== "queued" &&
            candidate.status !== "blocked"
          ) {
            return false;
          }
          const recovery = candidate.outputs.validationRecovery;
          const conventionalRecovery =
            recovery !== null &&
            typeof recovery === "object" &&
            !Array.isArray(recovery) &&
            (recovery as Record<string, unknown>).status ===
              "awaiting_correction";
          const conventionalFastNodeId = conventionalRecovery
            ? (recovery as Record<string, unknown>).fastNodeId
            : null;
          const compositeFastNodeId =
            compositeValidationRecoveryNodeIdV1(candidate);
          const fastNodeId =
            typeof conventionalFastNodeId === "string"
              ? conventionalFastNodeId
              : compositeFastNodeId;
          return Boolean(
            fastNodeId &&
              this.record.graph.nodes[fastNodeId]?.status === "queued",
          );
        },
      );
      if (!recoveryNode) {
        return { graph: this.record.graph, recorded: false };
      }
      const recovery = recoveryNode.outputs.validationRecovery;
      const conventionalRecovery =
        recovery !== null &&
        typeof recovery === "object" &&
        !Array.isArray(recovery)
          ? (recovery as Record<string, unknown>)
          : null;
      const fastNodeId =
        typeof conventionalRecovery?.fastNodeId === "string"
          ? conventionalRecovery.fastNodeId
          : compositeValidationRecoveryNodeIdV1(recoveryNode);
      if (!fastNodeId) {
        throw new Error(
          `Validation recovery on ${recoveryNode.id} lost its exact fast-validation node binding.`,
        );
      }
      const fastNode = this.record.graph.nodes[fastNodeId];
      if (!fastNode || fastNode.status !== "queued") {
        throw new Error(
          `Validation recovery fast node ${fastNodeId} is not queued for a correction receipt.`,
        );
      }
      const graph = await this.applyUnlocked(
        `Record receipt-backed workspace correction for ${recoveryNode.id}.`,
        [
          ...(conventionalRecovery
            ? ([
                {
                  op: "set_outputs" as const,
                  nodeId: recoveryNode.id,
                  outputs: {
                    ...recoveryNode.outputs,
                    validationRecovery: {
                      ...conventionalRecovery,
                      status: "correction_recorded",
                      correction: {
                        toolName: input.toolName,
                        path: normalizedPath,
                        eligiblePaths,
                        receiptId: input.receiptId,
                        receiptFingerprint: input.receiptFingerprint,
                        observedAt: input.observedAt,
                      },
                    },
                  },
                },
              ] as const)
            : []),
          {
            op: "set_status",
            nodeId: fastNodeId,
            expectedStatus: "queued",
            status: "ready",
            blocker: null,
          },
        ],
      );
      return { graph, recorded: true };
    });
  }

  /**
   * A successful composite recovery node pays the blocked origin without
   * replaying the failed provider call. Recovery nodes carry the exact same
   * closed lifecycle authority as their origin, so their terminal proof can
   * be projected onto the origin with new graph-local evidence/receipt IDs.
   * The loop also collapses a bounded chain when a recovery stage itself
   * needed another correction cycle.
   */
  private async reconcileValidationRecoveryOriginUnlocked(
    completedRecoveryNode: MissionNodeV3,
  ): Promise<MissionGraphV3> {
    let recoveredNode = completedRecoveryNode;
    while (recoveredNode.status === "complete") {
      const origin = Object.values(this.record.graph.nodes).find(
        (candidate) => {
          if (
            candidate.status !== "blocked" ||
            candidate.blocker?.code !== "validation_recovery_pending"
          ) {
            return false;
          }
          return (
            compositeValidationRecoveryNodeIdV1(candidate) ===
            recoveredNode.id
          );
        },
      );
      if (!origin) break;

      const originLifecycle = getMissionCompositeLifecycleSpecV1(origin);
      const originState = getMissionCompositeLifecycleStateV1(origin);
      const recoveryLifecycle =
        getMissionCompositeLifecycleSpecV1(recoveredNode);
      const recoveryState =
        getMissionCompositeLifecycleStateV1(recoveredNode);
      if (
        !originLifecycle ||
        !originState ||
        !recoveryLifecycle ||
        !recoveryState ||
        originLifecycle.intentFingerprint !==
          recoveryLifecycle.intentFingerprint ||
        originLifecycle.stage !== recoveryLifecycle.stage ||
        JSON.stringify(originLifecycle.actions) !==
          JSON.stringify(recoveryLifecycle.actions) ||
        recoveryState.actionCursor !== recoveryLifecycle.actions.length
      ) {
        throw new Error(
          `Completed validation recovery ${recoveredNode.id} does not match the closed lifecycle authority of ${origin.id}.`,
        );
      }

      const actionAttemptCounts = Object.fromEntries(
        originLifecycle.actions.flatMap((action) => {
          const count = Math.min(
            10,
            (originState.actionAttemptCounts[action.id] ?? 0) +
              (recoveryState.actionAttemptCounts[action.id] ?? 0),
          );
          return count > 0 ? [[action.id, count] as const] : [];
        }),
      );
      const operations: MissionGraphPatchOperationV1[] = [
        ...recoveredNode.evidence.map(
          (evidence, index): MissionGraphPatchOperationV1 => ({
            op: "append_evidence",
            nodeId: origin.id,
            evidence: {
              ...evidence,
              id: missionGraphLocalReferenceId(
                `validation-recovery-evidence-${String(index + 1).padStart(3, "0")}`,
                origin.id,
                this.record.graph.revision + 1,
              ),
            },
          }),
        ),
        ...recoveredNode.receipts.map(
          (receipt, index): MissionGraphPatchOperationV1 => ({
            op: "append_receipt",
            nodeId: origin.id,
            receipt: {
              ...receipt,
              id: missionGraphLocalReferenceId(
                `validation-recovery-receipt-${String(index + 1).padStart(3, "0")}`,
                origin.id,
                this.record.graph.revision + 1,
              ),
            },
          }),
        ),
        {
          op: "set_outputs",
          nodeId: origin.id,
          outputs: {
            lifecycleActionCursor: recoveryState.actionCursor,
            lifecycleCompletedActionIds: [
              ...recoveryState.completedActionIds,
            ],
            lifecycleSkippedActionIds: [...recoveryState.skippedActionIds],
            lifecycleActionAttemptCounts: actionAttemptCounts,
          },
        },
        {
          op: "set_status",
          nodeId: origin.id,
          expectedStatus: "blocked",
          status: "ready",
          blocker: null,
        },
        {
          op: "set_status",
          nodeId: origin.id,
          expectedStatus: "ready",
          status: "running",
          blocker: null,
        },
        {
          op: "set_status",
          nodeId: origin.id,
          expectedStatus: "running",
          status: "verifying",
          blocker: null,
        },
        {
          op: "set_status",
          nodeId: origin.id,
          expectedStatus: "verifying",
          status: "complete",
          blocker: null,
        },
      ];
      for (const candidate of Object.values(this.record.graph.nodes)) {
        if (
          candidate.status === "queued" &&
          !isFastValidationAwaitingCorrection(
            this.record.graph,
            candidate.id,
          ) &&
          candidate.dependencyIds.every(
            (dependencyId) =>
              dependencyId === origin.id ||
              this.record.graph.nodes[dependencyId]?.status === "complete",
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
      await this.applyUnlocked(
        `Reconcile closed validation recovery ${recoveredNode.id} into ${origin.id}.`,
        operations,
      );
      recoveredNode = this.record.graph.nodes[origin.id]!;
    }
    return this.record.graph;
  }

  /**
   * Replan one failed create-file node into two bounded sibling nodes:
   * exact read -> hash-bound write_expected. The failed create stays blocked
   * until the write receipt reconciles its original completion contract.
   * This preserves the immutable planned lifecycle while keeping the repair
   * on the same trusted binding and inside the original host envelope.
   */
  async scheduleCreateFileCollisionRepair(
    execution: MissionGraphToolExecution,
    targetPath: string,
  ): Promise<MissionGraphV3> {
    return this.enqueueMutation(async () => {
      const node = this.requireNode(execution.nodeId);
      if (
        execution.toolName !== "code_workspace_create_file" ||
        node.status !== "ready"
      ) {
        throw new Error(
          `Create-file collision repair requires a ready failed create node; ${node.id} is ${node.status}.`,
        );
      }
      const requestedSelector = targetPath.trim();
      if (!requestedSelector) {
        throw new Error("Create-file collision repair requires an exact path.");
      }
      const lifecycleAction =
        getCurrentMissionCompositeLifecycleActionV1(node);
      if (
        lifecycleAction &&
        lifecycleAction.toolName !== "code_workspace_create_file"
      ) {
        throw new Error(
          `Create-file collision repair expected the current lifecycle action to be code_workspace_create_file, not ${lifecycleAction.toolName}.`,
        );
      }
      const selector =
        lifecycleAction?.selector ?? node.destination?.selector ?? null;
      const bindingId =
        lifecycleAction?.bindingId ?? node.destination?.bindingId ?? null;
      if (selector !== requestedSelector) {
        throw new Error(
          `Create-file collision repair path ${requestedSelector} does not match the trusted graph selector ${selector ?? "(missing)"}.`,
        );
      }
      if (!bindingId) {
        throw new Error(
          `Create-file collision repair lost the trusted workspace binding for ${node.id}.`,
        );
      }
      const readGrant =
        this.record.graph.capabilityEnvelope.tools.code_workspace_read;
      const writeGrant =
        this.record.graph.capabilityEnvelope.tools
          .code_workspace_write_expected;
      if (!readGrant || !writeGrant) {
        throw new Error(
          "Create-file collision repair requires code_workspace_read and code_workspace_write_expected grants.",
        );
      }
      const readExecutionHost = readGrant.executionHosts.find((host) =>
        Object.values(this.record.graph.capabilityEnvelope.executors).some(
          (executor) =>
            executor.executionHosts.includes(host) &&
            executor.allowedEffects.includes("read"),
        ),
      );
      const readExecutor = Object.values(
        this.record.graph.capabilityEnvelope.executors,
      ).find(
        (executor) =>
          readExecutionHost !== undefined &&
          executor.executionHosts.includes(readExecutionHost) &&
          executor.allowedEffects.includes("read"),
      );
      if (!readExecutionHost || !readExecutor) {
        throw new Error(
          "Create-file collision repair has no installed read executor.",
        );
      }
      if (
        node.effect === "read" ||
        !writeGrant.executionHosts.includes(node.executionHost) ||
        writeGrant.effect !== node.effect
      ) {
        throw new Error(
          "Create-file collision repair cannot preserve the original execution host and mutation effect.",
        );
      }
      const perNodeWallClockMs = missionGraphToolNodeWallClockMs(
        this.record.graph.capabilityEnvelope.budgets.maxWallClockMs,
        this.record.graph.capabilityEnvelope.budgets.maxTotalToolCalls,
      );
      const reserveNode = findContinuationReserveNode(this.record.graph);
      if (!reserveNode || reserveNode.id === node.id) {
        throw new Error(
          "Create-file collision repair has no nonterminal continuation budget reserve.",
        );
      }
      const allocation = transferReservedBudgetForContinuation(
        this.record.graph,
        reserveNode,
        {
          toolCalls: 2,
          externalActions: 0,
          wallClockMs: perNodeWallClockMs * 2,
        },
      );
      const idSuffix = sanitizeMissionId(
        `${this.record.graph.revision + 1}-${node.id}`,
      );
      const readNodeId = `repair-read-${idSuffix}`.slice(0, 128);
      const writeNodeId = `repair-write-${idSuffix}`.slice(0, 128);
      const retries = {
        maxAttempts:
          this.record.graph.capabilityEnvelope.budgets.maxAttemptsPerNode,
        attempts: 0,
        failureFingerprints: [],
        consecutiveFailureFingerprint: null,
        consecutiveFailureCount: 0,
      };
      const readNode: MissionNodeV3 = {
        id: readNodeId,
        dependencyIds: [...node.dependencyIds],
        objective: `Read the existing workspace file ${selector} and observe its SHA-256 before collision repair.`,
        executorId: readExecutor.id,
        executionHost: readExecutionHost,
        effect: "read",
        inputs: {
          resource: { kind: "binding", bindingId, selector },
        },
        outputs: {},
        requiredCapabilities: [...readGrant.capabilityIds],
        allowedTools: ["code_workspace_read"],
        destination: null,
        resourceLocks: [{ bindingId, mode: "shared" }],
        budget: {
          toolCalls: 1,
          externalActions: 0,
          wallClockMs: perNodeWallClockMs,
        },
        retries: clone(retries),
        status: "ready",
        evidence: [],
        receipts: [],
        verification: null,
        completionContract: {
          criteria: [
            `code_workspace_read observed ${selector} and returned its current SHA-256.`,
          ],
          minimumEvidence: 1,
          requiredEvidenceKinds: ["tool-result"],
          minimumReceipts: 0,
          requiredReceiptKinds: [],
          verifierId: null,
        },
        blocker: null,
      };
      const repairContract = lifecycleAction
        ? {
            minimumEvidence: lifecycleAction.minimumEvidence,
            requiredEvidenceKinds: [
              ...lifecycleAction.requiredEvidenceKinds,
            ],
            minimumReceipts: lifecycleAction.minimumReceipts,
            requiredReceiptKinds: [
              ...lifecycleAction.requiredReceiptKinds,
            ],
          }
        : {
            minimumEvidence: node.completionContract.minimumEvidence,
            requiredEvidenceKinds: [
              ...node.completionContract.requiredEvidenceKinds,
            ],
            minimumReceipts: node.completionContract.minimumReceipts,
            requiredReceiptKinds: [
              ...node.completionContract.requiredReceiptKinds,
            ],
          };
      const writeNode: MissionNodeV3 = {
        id: writeNodeId,
        dependencyIds: [readNodeId],
        objective: `Replace ${selector} only under the SHA-256 observed by the preceding exact read.`,
        executorId: node.executorId,
        executionHost: node.executionHost,
        effect: node.effect,
        inputs: {
          resource: { kind: "binding", bindingId, selector },
          create_collision_origin: { kind: "literal", value: node.id },
          create_collision_read: { kind: "literal", value: readNodeId },
        },
        outputs: {},
        requiredCapabilities: [...writeGrant.capabilityIds],
        allowedTools: ["code_workspace_write_expected"],
        destination: {
          bindingId,
          effect: node.effect,
          selector,
        },
        resourceLocks: [{ bindingId, mode: "exclusive" }],
        budget: {
          toolCalls: 1,
          externalActions: 0,
          wallClockMs: perNodeWallClockMs,
        },
        retries: clone(retries),
        status: "queued",
        evidence: [],
        receipts: [],
        verification: null,
        completionContract: {
          criteria: [
            `code_workspace_write_expected reconciled ${selector} under the SHA-256 observed by ${readNodeId}.`,
          ],
          ...repairContract,
          verifierId: null,
        },
        blocker: null,
      };
      const operations: MissionGraphPatchOperationV1[] = [
        {
          op: "set_status",
          nodeId: node.id,
          expectedStatus: "ready",
          status: "blocked",
          blocker: {
            code: "create_file_path_exists",
            message: `The planned create target ${selector} already exists with different content.`,
            requiredAction:
              "Complete the exact read and hash-bound write_expected repair nodes.",
          },
        },
        { op: "add_node", node: readNode },
        { op: "add_node", node: writeNode },
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
      ];
      if (
        JSON.stringify(allocation.reserveNodeBudget) !==
        JSON.stringify(reserveNode.budget)
      ) {
        operations.push({
          op: "update_node",
          nodeId: reserveNode.id,
          changes: { budget: allocation.reserveNodeBudget },
        });
      }
      return this.applyUnlocked(
        `Replan create-file collision at ${selector} into exact read and hash-bound write.`,
        operations,
      );
    });
  }

  private async reconcileCreateFileCollisionOriginUnlocked(
    repairNode: MissionNodeV3,
    result: {
      evidence?: MissionEvidenceRefV1;
      receipt?: MissionReceiptRefV1;
    },
  ): Promise<MissionGraphV3> {
    const originInput = repairNode.inputs.create_collision_origin;
    if (
      originInput?.kind !== "literal" ||
      typeof originInput.value !== "string"
    ) {
      return this.record.graph;
    }
    const origin = this.record.graph.nodes[originInput.value];
    if (
      !origin ||
      origin.status !== "blocked" ||
      origin.blocker?.code !== "create_file_path_exists"
    ) {
      return this.record.graph;
    }
    const lifecycle = getMissionCompositeLifecycleSpecV1(origin);
    const lifecycleState = getMissionCompositeLifecycleStateV1(origin);
    const lifecycleAction = getCurrentMissionCompositeLifecycleActionV1(origin);
    if (
      lifecycle &&
      (!lifecycleState ||
        !lifecycleAction ||
        lifecycleAction.toolName !== "code_workspace_create_file")
    ) {
      throw new Error(
        `Create-file collision repair no longer matches the lifecycle cursor for ${origin.id}.`,
      );
    }
    const proofContract = lifecycleAction ?? origin.completionContract;
    const proofMissing =
      !result.evidence ||
      proofContract.requiredEvidenceKinds.some(
        (kind) => result.evidence?.kind !== kind,
      ) ||
      (proofContract.minimumReceipts > 0 && !result.receipt) ||
      proofContract.requiredReceiptKinds.some(
        (kind) => result.receipt?.kind !== kind,
      );
    if (proofMissing) {
      return this.record.graph;
    }
    const evidence: MissionEvidenceRefV1 = {
      ...result.evidence!,
      id: missionGraphLocalReferenceId(
        "create-repair-evidence",
        origin.id,
        this.record.graph.revision + 1,
      ),
    };
    const receipt = result.receipt
      ? {
          ...result.receipt,
          id: missionGraphLocalReferenceId(
            "create-repair-receipt",
            origin.id,
            this.record.graph.revision + 1,
          ),
        }
      : null;
    const operations: MissionGraphPatchOperationV1[] = [
      {
        op: "set_status",
        nodeId: origin.id,
        expectedStatus: "blocked",
        status: "ready",
        blocker: null,
      },
      {
        op: "set_status",
        nodeId: origin.id,
        expectedStatus: "ready",
        status: "running",
        blocker: null,
      },
      { op: "append_evidence", nodeId: origin.id, evidence },
      ...(receipt
        ? ([{ op: "append_receipt", nodeId: origin.id, receipt }] as const)
        : []),
      {
        op: "update_node",
        nodeId: origin.id,
        changes: {
          retries: {
            maxAttempts: origin.retries.maxAttempts,
            attempts: 0,
            failureFingerprints: [],
            consecutiveFailureFingerprint: null,
            consecutiveFailureCount: 0,
          },
        },
      },
    ];
    if (lifecycle && lifecycleState && lifecycleAction) {
      operations.push(
        lifecycleOutputsOperationV1(
          origin.id,
          lifecycleState,
          lifecycle,
          lifecycleAction.id,
          true,
        ),
      );
      if (lifecycleState.actionCursor + 1 < lifecycle.actions.length) {
        operations.push({
          op: "set_status",
          nodeId: origin.id,
          expectedStatus: "running",
          status: "ready",
          blocker: null,
        });
        return this.applyUnlocked(
          `Reconcile create-file collision repair into lifecycle node ${origin.id}.`,
          operations,
        );
      }
    }
    operations.push(
      {
        op: "set_status",
        nodeId: origin.id,
        expectedStatus: "running",
        status: "verifying",
        blocker: null,
      },
      {
        op: "set_status",
        nodeId: origin.id,
        expectedStatus: "verifying",
        status: "complete",
        blocker: null,
      },
    );
    for (const candidate of Object.values(this.record.graph.nodes)) {
      if (
        candidate.status === "queued" &&
        candidate.dependencyIds.every(
          (dependencyId) =>
            dependencyId === origin.id ||
            this.record.graph.nodes[dependencyId]?.status === "complete",
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
    return this.applyUnlocked(
      `Reconcile create-file collision repair into mission node ${origin.id}.`,
      operations,
    );
  }

  /**
   * Requeue one host-policy deferral, but journal it as an attempt. Repeating
   * the same deferral blocks the node instead of creating an invisible
   * ready -> running -> ready loop that can consume the whole model budget.
   */
  async deferToolExecution(
    execution: MissionGraphToolExecution,
    reason: string,
  ): Promise<MissionGraphV3> {
    const failureFingerprint = await sha256Fingerprint({
      kind: "host_policy_deferral",
      toolName: execution.toolName,
      reason: reason.replace(/\s+/gu, " ").trim(),
    });
    return this.enqueueMutation(async () => {
      const node = this.requireExecutionNode(execution, "running");
      const nextAttempts = node.retries.attempts + 1;
      const sameDeferralCount =
        node.retries.consecutiveFailureFingerprint === failureFingerprint
          ? node.retries.consecutiveFailureCount + 1
          : 1;
      const terminal =
        sameDeferralCount >= 2 ||
        nextAttempts >= Math.max(2, node.retries.maxAttempts);
      try {
        return await this.applyUnlocked(
          `Defer ${execution.toolName} for ${node.id}: ${reason.slice(0, 240)}`,
          [
            {
              op: "record_attempt",
              nodeId: node.id,
              failureFingerprint,
              observedAt: this.now(),
            },
            {
              op: "set_status",
              nodeId: node.id,
              expectedStatus: "running",
              status: terminal ? "blocked" : "ready",
              blocker: terminal
                ? {
                    code: "policy_deferral_repeated",
                    message: `Internal orchestration repeatedly deferred ${execution.toolName}: ${reason}`,
                    requiredAction:
                      "Rebuild the mission frontier so effectful work follows its read prerequisites, then retry the mission.",
                  }
                : null,
            },
          ],
        );
      } finally {
        if (execution.lockLease) {
          await this.releaseNodeLocksUnlocked(execution.lockLease);
        }
      }
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
    resolution: boolean | "approved" | "denied" | "expired" | "aborted",
  ): Promise<MissionGraphV3> {
    return this.enqueueMutation(async () => {
      const approved = resolution === true || resolution === "approved";
      const deniedCode = resolution === false || resolution === "denied"
        ? "approval_denied"
        : `approval_${resolution}`;
      const deniedMessage = deniedCode === "approval_denied"
        ? `User denied approval for ${execution.toolName}.`
        : deniedCode === "approval_expired"
          ? `Approval expired before ${execution.toolName} could run.`
          : `Approval for ${execution.toolName} was aborted before execution.`;
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
                  code: deniedCode,
                  message: deniedMessage,
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
      // Once the required final node is verified, every node outside its
      // transitive dependency closure is explicitly abandoned. This includes
      // blocked optional reads and stale recovery siblings: leaving either
      // non-terminal makes the authoritative graph disagree with the completed
      // ledger and can surface phantom work after a successful mission. The one
      // exception is a canonical host-built post-acceptance action: the runner
      // may execute that hidden action only after this final proof is recorded.
      const requiredIds = collectRequiredDependencyIds(
        this.record.graph,
        node.id,
      );
      requiredIds.add(node.id);
      for (const [id, candidate] of Object.entries(this.record.graph.nodes)) {
        if (requiredIds.has(id)) continue;
        if (isCanonicalHostPostAcceptanceNode(candidate)) continue;
        if (
          candidate.status === "complete" ||
          candidate.status === "cancelled"
        ) {
          continue;
        }
        await this.releaseOrphanedNodeLocksUnlocked(id);
        operations.push({
          op: "set_status",
          nodeId: id,
          expectedStatus: candidate.status,
          status: "cancelled",
          blocker: null,
        });
      }
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
          !isFastValidationAwaitingCorrection(graph, node.id) &&
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

  /** Drop locks left behind when a host forgot finishToolExecution. */
  private async releaseOrphanedNodeLocksUnlocked(
    nodeId: string,
  ): Promise<void> {
    const ownerId = `${this.record.missionId}/${nodeId}`;
    const held = Object.values(this.record.resourceLocks.locks).filter(
      (lock) => lock.ownerId === ownerId,
    );
    if (held.length === 0) return;
    await this.releaseNodeLocksUnlocked({
      nodeId,
      ownerId,
      token: held[0]!.token,
      resourceKeys: held.map((lock) => lock.resourceKey),
    });
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
  lifecycle: NonNullable<ReturnType<typeof getMissionCompositeLifecycleSpecV1>>,
  actionId: string,
  completed: boolean,
  skipNextToolNames: readonly string[] = [],
): MissionGraphPatchOperationV1 {
  const completedActionIds = completed
    ? [...state.completedActionIds, actionId]
    : [...state.completedActionIds];
  const skipSet = new Set(skipNextToolNames);
  const skippedActionIds = [...state.skippedActionIds];
  let actionCursor = state.actionCursor + (completed ? 1 : 0);
  while (
    completed &&
    actionCursor < lifecycle.actions.length &&
    skipSet.has(lifecycle.actions[actionCursor].toolName) &&
    lifecycle.actions[actionCursor].condition === "fast_validation_failed"
  ) {
    skippedActionIds.push(lifecycle.actions[actionCursor].id);
    actionCursor += 1;
  }
  return {
    op: "set_outputs",
    nodeId,
    outputs: {
      lifecycleActionCursor: actionCursor,
      lifecycleCompletedActionIds: completedActionIds,
      lifecycleSkippedActionIds: skippedActionIds,
      lifecycleActionAttemptCounts: {
        ...state.actionAttemptCounts,
        [actionId]: (state.actionAttemptCounts[actionId] ?? 0) + 1,
      },
    },
  };
}

function isCanonicalHostPostAcceptanceNode(node: MissionNodeV3): boolean {
  if (node.effect === "read" || node.allowedTools.length !== 1) return false;
  const toolName = node.allowedTools[0]!;
  const ordinal = /^post-acceptance-tool-(\d{2})-/u.exec(node.id)?.[1];
  if (!ordinal) return false;
  const stableToolToken =
    toolName
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
      .slice(0, 128) || "resource";
  const expectedId =
    `post-acceptance-${`tool-${ordinal}-${stableToolToken}`.slice(0, 128)}`;
  return (
    node.id === expectedId &&
    node.objective ===
      `After result acceptance, run host-authorized ${toolName}.` &&
    node.completionContract.minimumEvidence === 1 &&
    node.completionContract.requiredEvidenceKinds.length === 1 &&
    node.completionContract.requiredEvidenceKinds[0] === "tool-result" &&
    node.completionContract.minimumReceipts === 0 &&
    node.completionContract.requiredReceiptKinds.length === 0 &&
    node.completionContract.verifierId === null
  );
}

function nextLifecycleCursor(
  lifecycle: NonNullable<ReturnType<typeof getMissionCompositeLifecycleSpecV1>>,
  currentCursor: number,
  skipNextToolNames: readonly string[] | undefined,
): number {
  const skipSet = new Set(skipNextToolNames ?? []);
  let cursor = currentCursor + 1;
  while (
    cursor < lifecycle.actions.length &&
    skipSet.has(lifecycle.actions[cursor].toolName) &&
    lifecycle.actions[cursor].condition === "fast_validation_failed"
  ) {
    cursor += 1;
  }
  return cursor;
}

function normalizeValidationRecoveryPath(value: string): string {
  if (typeof value !== "string") return "";
  const normalized = value
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^(?:\.\/)+/u, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /(^|\/)\.\.(?:\/|$)/u.test(normalized)
  ) {
    return "";
  }
  return normalized;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const COMPOSITE_VALIDATION_RECOVERY_ACTION_PREFIX =
  "Apply an eligible workspace correction, then complete validation recovery node ";

function compositeValidationRecoveryRequiredActionV1(
  recoveryNodeId: string,
): string {
  return `${COMPOSITE_VALIDATION_RECOVERY_ACTION_PREFIX}${recoveryNodeId}.`;
}

function compositeValidationRecoveryNodeIdV1(
  node: Pick<MissionNodeV3, "blocker">,
): string | null {
  if (
    node.blocker?.code !== "validation_recovery_pending" ||
    !node.blocker.requiredAction?.startsWith(
      COMPOSITE_VALIDATION_RECOVERY_ACTION_PREFIX,
    ) ||
    !node.blocker.requiredAction.endsWith(".")
  ) {
    return null;
  }
  const nodeId = node.blocker.requiredAction.slice(
    COMPOSITE_VALIDATION_RECOVERY_ACTION_PREFIX.length,
    -1,
  );
  return /^[A-Za-z0-9._-]{1,128}$/u.test(nodeId) ? nodeId : null;
}

function isFastValidationAwaitingCorrection(
  graph: MissionGraphV3,
  fastNodeId: string,
): boolean {
  return Object.values(graph.nodes).some((candidate) => {
    const recovery = candidate.outputs.validationRecovery;
    const conventionalRecovery =
      recovery !== null &&
      typeof recovery === "object" &&
      !Array.isArray(recovery) &&
      (recovery as Record<string, unknown>).status ===
        "awaiting_correction" &&
      (recovery as Record<string, unknown>).fastNodeId === fastNodeId;
    return (
      conventionalRecovery ||
      compositeValidationRecoveryNodeIdV1(candidate) === fastNodeId
    );
  });
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
