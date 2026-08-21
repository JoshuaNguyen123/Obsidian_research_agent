import type { TFile } from "obsidian";
import {
  parseVerifiedCodeReflectionExamplesV1,
  type VerifiedCodeReflectionExamplesV1,
} from "@agentic-researcher/core-api";
import { portableSha256Text } from "../../packages/core-api/src/portableSha256";
import { assertMeaningfulReflectionContentV1 } from "../../packages/core-api/src/reflectionContentV1";
import {
  appendJupyterReflectionV1,
  buildJupyterNotebookV1,
  validateJupyterNotebookContentV1,
} from "../../extensions/code/JupyterNotebookV1";
import {
  appendJupyterReflectionWritebackV1,
  type ReflectionWritebackStoreV1,
} from "../agent/reflectionWriteback";
import {
  extractExplicitJupyterNotebookPathsV1,
  hasJupyterReflectionIntentV1,
} from "../agent/jupyterReflectionIntent";
import {
  mergeProjectStageEventsPreferExactWorkUnitScopeV1,
  projectLinearBindingsFromProjectLineageV1,
  projectStageEventsFromProjectLineageV1,
} from "../agent/projectStageLineageMapper";
import {
  projectWorkUnitOutcomesV1,
  type ProjectWorkUnitLinearBindingV1,
} from "../agent/projectProgressProjection";
import {
  createProjectRunReportV1,
  createProjectStageEventV1,
  parseProjectRunReportV1,
  parseProjectStageEventV1,
  reduceProjectStageEventsV1,
  resolveProjectResultsDestinationV1,
  renderProjectRunReportMarkdownV1,
  type ProjectCodeExampleV1,
  type ProjectRunReportV1,
  type ProjectStageEventV1,
} from "../agent/projectRunReport";
import { parseProjectLineageV1 } from "../agent/projectLifecycle";
import { hasCodeExecutionIntent } from "../agent/promptIntentClassifiers";
import {
  sha256Fingerprint,
  verifyPreparedActionFingerprint,
  withPreparedActionFingerprint,
  type ActionReceipt,
  type JsonValue,
  type PreparedAction,
  type PreparedActionResult,
  type ToolDescriptor,
} from "../agent/actions";
import type { JsonSchemaObject } from "../model/types";
import type {
  AgentTool,
  AgentToolActionExecution,
  ToolExecutionContext,
} from "./types";
import { ToolExecutionError } from "./types";

export const APPEND_JUPYTER_REFLECTION_TOOL_NAME =
  "append_jupyter_reflection" as const;

const PREPARED_ACTION_TTL_MS = 10 * 60 * 1_000;
const ABSENT_REVISION = "absent";
const MAX_NOTEBOOK_BYTES = 10_000_000;

type JupyterReflectionWriteModeV1 = "append" | "create";

interface ResolvedJupyterCodeExamplesV1 {
  bundle: VerifiedCodeReflectionExamplesV1 | null;
  reportExamples: ProjectCodeExampleV1[];
}

/**
 * Write a reader-facing reflection to Jupyter without executing it. An exact
 * existing target is append-only; an exact absent target or a natural
 * destination request creates one no-overwrite Results notebook. The provider
 * supplies prose only. Any code cells are resolved from the current/root run's
 * immutable code lineage by the host.
 */
export function createJupyterReflectionTool(): AgentTool {
  return {
    name: APPEND_JUPYTER_REFLECTION_TOOL_NAME,
    description:
      "Write a concise reflection to Jupyter without executing cells. An explicitly named existing vault-relative .ipynb is appended exactly; an explicitly named absent path or a natural Jupyter-notebook request creates one deterministic no-overwrite Results notebook. The host seals the exact before/create state and complete proposed bytes, preserves existing notebook semantics, and adds code examples only from verified code lineage. Path is optional when the user requested a natural Jupyter destination.",
    parameters: PARAMETERS,
    descriptor: DESCRIPTOR,
    async execute() {
      throw notApplied(
        "prepared_action_required",
        `${APPEND_JUPYTER_REFLECTION_TOOL_NAME} must be prepared and exactly approved before execution.`,
      );
    },
    prepare: prepareJupyterReflection,
    executePrepared: executePreparedJupyterReflection,
    reconcile: reconcileJupyterReflection,
  };
}

async function prepareJupyterReflection(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<PreparedActionResult> {
  try {
    assertExactArgs(args);
    const assistantMarkdown = requireText(args.markdown, "markdown", 100_000);
    assertNoModelAuthoredCode(assistantMarkdown);
    assertMeaningfulReflectionContentV1(
      assistantMarkdown,
      "Jupyter reflection assistant notes",
    );
    const runId = requireIdentifier(
      context.rootMissionId?.trim() || context.runId,
      "project run id",
    );
    const toolCallId = requireIdentifier(context.operationId, "tool call id");
    const preparedAt = canonicalNow(context);
    const projectName = resolveProjectName(context, runId);
    const destination = resolveJupyterReflectionDestinationV1({
      prompt: context.originalPrompt,
      requestedPath: args.path,
      projectName,
      runId,
      generatedAt: preparedAt,
    });
    const path = destination.path;
    const observedTarget = await observeNotebookTarget(context, path);
    if (observedTarget.kind === "other") {
      throw notApplied(
        "jupyter_reflection_target_invalid",
        `The Jupyter target ${path} exists but is not an exact readable .ipynb file.`,
      );
    }
    const mode: JupyterReflectionWriteModeV1 =
      observedTarget.kind === "jupyter" ? "append" : "create";
    const current =
      observedTarget.kind === "jupyter"
        ? observedTarget.content
        : buildNewReflectionNotebookBaseV1();
    const expectedBeforeSha256 = sha256Text(current);
    const expectedTargetState =
      mode === "create" ? ABSENT_REVISION : expectedBeforeSha256;
    const events = resolveHostProjectEvents(context, runId);
    const workUnitBindings = resolveProjectWorkUnitBindings(context, runId);
    const code = await resolveCurrentRunCodeExamples(context, runId, events);
    const markerId = await buildMarkerId({ runId, toolCallId, path });
    const preReflectionWorkUnitOutcomes = workUnitBindings.length > 0
      ? projectWorkUnitOutcomesV1({
          runId,
          events,
          bindings: workUnitBindings,
          projectedAt: preparedAt,
        })
      : undefined;
    const preReflectionReport = createProjectRunReportV1({
      runId,
      projectName,
      generatedAt: preparedAt,
      destination,
      events,
      ...(preReflectionWorkUnitOutcomes === undefined
        ? {}
        : { workUnitOutcomes: preReflectionWorkUnitOutcomes }),
      limitations: deriveLimitations(runId, events),
      codeExamples: code.reportExamples,
    });
    const reflectionBinding = await sha256Fingerprint({
      version: 1,
      kind: `prospective_jupyter_project_report_${mode}`,
      runId,
      toolCallId,
      path,
      markerId,
      expectedTargetState,
      expectedBeforeSha256,
      assistantMarkdownSha256: sha256Text(assistantMarkdown),
      preReflectionReportFingerprint: preReflectionReport.reportFingerprint,
    });
    // The Reflect phase is prospective: it becomes true only when the sealed
    // notebook bytes containing this event are written and read back exactly.
    const prospectiveReflection = createProjectStageEventV1({
      schemaVersion: 1,
      runId,
      phase: "reflect",
      evidenceKind: "reflection_writeback",
      disposition: "verified",
      occurredAt: preparedAt,
      sourceReceiptId: `jupyter-reflection-${reflectionBinding.slice("sha256:".length, 39)}`,
      evidenceFingerprint: reflectionBinding,
      resource: {
        system: "vault",
        resourceType: "jupyter_notebook",
        id: path,
        url: null,
        path,
        revision: null,
      },
      workUnits: workUnitBindings.map((binding) => ({
        workUnitId: binding.workUnitId,
        acceptanceCriterionIds: [],
      })),
    });
    const finalEvents = [...events, prospectiveReflection];
    const workUnitOutcomes = workUnitBindings.length > 0
      ? projectWorkUnitOutcomesV1({
          runId,
          events: finalEvents,
          bindings: workUnitBindings,
          projectedAt: preparedAt,
        })
      : undefined;
    const report = createProjectRunReportV1({
      runId,
      projectName: preReflectionReport.projectName,
      generatedAt: preparedAt,
      destination,
      events: finalEvents,
      ...(workUnitOutcomes === undefined ? {} : { workUnitOutcomes }),
      limitations: deriveLimitations(runId, finalEvents),
      codeExamples: code.reportExamples,
    });
    const markdown = composeNotebookReportMarkdown(report, assistantMarkdown);
    const proposed = appendJupyterReflectionV1({
      target: { kind: "jupyter_notebook", notebookPath: path },
      currentContent: current,
      expectedBeforeSha256,
      markerId,
      markdown,
      codeExamples: code.bundle,
    });
    const expectedAfterSha256 = sha256Text(proposed.content);
    const normalizedArgs: Record<string, JsonValue> = {
      path,
      mode,
      destinationSource: destination.source,
      assistantMarkdown,
      markdown,
      markerId,
      expectedTargetState,
      expectedBeforeSha256,
      expectedAfterSha256,
      beforeNotebook: current,
      proposedNotebook: proposed.content,
      report: cloneJson(report),
      codeExamples: code.bundle
        ? cloneJson(code.bundle)
        : null,
    };
    const proposedBytes = byteLength(proposed.content);
    const currentBytes = mode === "append" ? byteLength(current) : 0;
    const action = await withPreparedActionFingerprint({
      version: 1,
      id: prospectiveReflection.sourceReceiptId,
      runId,
      toolCallId,
      toolName: APPEND_JUPYTER_REFLECTION_TOOL_NAME,
      target: {
        system: "vault",
        resourceType: "jupyter_notebook",
        id: path,
        path,
      },
      relatedResources: code.bundle
        ? code.bundle.examples.map((example) => ({
            system: "git" as const,
            resourceType: "commit_blob",
            id: `${code.bundle!.commitSha}:${example.path}`,
            path: example.path,
            revision: code.bundle!.commitSha,
          }))
        : [],
      normalizedArgs,
      preview: {
        summary:
          mode === "create"
            ? `Create the verified Jupyter Results notebook ${path} without executing cells.`
            : `Append a verified reflection to ${path} without executing cells.`,
        destination: path,
        before:
          mode === "create"
            ? { path, state: ABSENT_REVISION, bytes: 0 }
            : {
                path,
                sha256: expectedBeforeSha256,
                bytes: currentBytes,
              },
        after: {
          path,
          sha256: expectedAfterSha256,
          bytes: proposedBytes,
          executionPerformed: false,
          reportFingerprint: report.reportFingerprint,
          complete: report.complete,
        },
        // Approval is over the complete notebook bytes, not a model-authored
        // summary or an unbound patch preview.
        outboundPayload: {
          path,
          notebookContent: proposed.content,
          expectedTargetState,
        },
        warnings: [
          "Notebook cells will not be executed.",
          mode === "create"
            ? "The target must remain absent; this action never overwrites an existing file."
            : "Existing cells, metadata, and outputs are preserved.",
        ],
        outboundBytes: proposedBytes,
      },
      expectedTargetRevision: expectedTargetState,
      idempotencyKey: `${runId}:${toolCallId}:${APPEND_JUPYTER_REFLECTION_TOOL_NAME}`,
      reconciliationKey: `${path}:${expectedAfterSha256}`,
      requiredConfirmations: 1,
      preparedAt,
      expiresAt: new Date(
        Date.parse(preparedAt) + PREPARED_ACTION_TTL_MS,
      ).toISOString(),
    });
    return { ok: true, action };
  } catch (error) {
    return {
      ok: false,
      error: {
        code:
          error instanceof ToolExecutionError
            ? error.code
            : "jupyter_reflection_preparation_failed",
        message: safeErrorMessage(error),
      },
    };
  }
}

async function executePreparedJupyterReflection(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<AgentToolActionExecution> {
  await assertPreparedActionBinding(action, context, true);
  const payload = parsePreparedPayload(action);
  assertPreparedDestinationAuthority(payload, context);
  let current = payload.beforeNotebook;
  if (payload.mode === "append") {
    current = await readExactNotebook(context, payload.path);
    if (
      current !== payload.beforeNotebook ||
      sha256Text(current) !== payload.expectedBeforeSha256 ||
      action.expectedTargetRevision !== payload.expectedBeforeSha256 ||
      payload.expectedTargetState !== payload.expectedBeforeSha256
    ) {
      throw notApplied(
        "jupyter_reflection_precondition_changed",
        "The notebook changed after preparation; reconcile the sealed action or prepare a new one.",
      );
    }
  } else if (
    action.expectedTargetRevision !== ABSENT_REVISION ||
    payload.expectedTargetState !== ABSENT_REVISION ||
    (await observeNotebookTarget(context, payload.path)).kind !== "missing"
  ) {
    throw notApplied(
      "jupyter_reflection_precondition_changed",
      "The no-overwrite Jupyter Results target is no longer absent; reconcile the sealed action or choose another destination.",
    );
  }

  // Recompute the proposal from its sealed prose and host-resolved examples.
  // A valid action fingerprint alone is insufficient if a future migration
  // accidentally changes the notebook transformation contract.
  const recomputed = appendJupyterReflectionV1({
    target: { kind: "jupyter_notebook", notebookPath: payload.path },
    currentContent: current,
    expectedBeforeSha256: payload.expectedBeforeSha256,
    markerId: payload.markerId,
    markdown: payload.markdown,
    codeExamples: payload.codeExamples,
  });
  if (
    recomputed.content !== payload.proposedNotebook ||
    sha256Text(recomputed.content) !== payload.expectedAfterSha256
  ) {
    throw notApplied(
      "jupyter_reflection_proposal_mismatch",
      "The sealed notebook proposal no longer matches the deterministic reflection transform.",
    );
  }
  validateJupyterNotebookContentV1(recomputed.content);

  const startedAt = canonicalNow(context);
  let bytesWritten: number;
  let status: string;
  let writebackReceipt: JsonValue | null = null;
  if (payload.mode === "create") {
    await ensureParentFolders(context, payload.path);
    try {
      await context.app.vault.create(payload.path, payload.proposedNotebook);
    } catch (error) {
      const observed = await observeNotebookTarget(context, payload.path);
      if (
        observed.kind !== "jupyter" ||
        observed.content !== payload.proposedNotebook ||
        sha256Text(observed.content) !== payload.expectedAfterSha256
      ) {
        throw new ToolExecutionError(
          "jupyter_reflection_create_uncertain",
          `Jupyter Results creation did not return a verified exact readback: ${safeErrorMessage(error)}`,
          { mutationState: "may_have_applied" },
        );
      }
    }
    bytesWritten = byteLength(payload.proposedNotebook);
    status = "created";
  } else {
    const writeback = await appendJupyterReflectionWritebackV1({
      operationId: action.id,
      target: { kind: "jupyter_notebook", notebookPath: payload.path },
      expectedBeforeSha256: payload.expectedBeforeSha256,
      markerId: payload.markerId,
      markdown: payload.markdown,
      codeExamples: payload.codeExamples,
      completedAt: startedAt,
      store: notebookStore(context),
    });
    bytesWritten = writeback.bytesWritten;
    status = writeback.status;
    writebackReceipt = cloneJson(writeback);
  }
  const observed = await readExactNotebook(context, payload.path);
  if (
    observed !== payload.proposedNotebook ||
    sha256Text(observed) !== payload.expectedAfterSha256
  ) {
    throw new ToolExecutionError(
      "jupyter_reflection_readback_failed",
      "Notebook writeback did not match the exact approved bytes.",
      { mutationState: "may_have_applied" },
    );
  }
  const committedAt = canonicalNow(context);
  const receipt = await buildActionReceipt({
    action,
    grantId: context.authorizedAction!.grantId,
    commitKind: "committed",
    startedAt,
    committedAt,
    observedRevision: payload.expectedAfterSha256,
    bytesWritten,
    mode: payload.mode,
  });
  return {
    mutationState: "applied",
    output: {
      path: payload.path,
      operation: payload.mode,
      beforeState: payload.expectedTargetState,
      ...(payload.mode === "append"
        ? { beforeSha256: payload.expectedBeforeSha256 }
        : {}),
      afterSha256: payload.expectedAfterSha256,
      bytesWritten,
      status,
      readbackVerified: true,
      executionPerformed: false,
      report: cloneJson(payload.report),
      writebackReceipt,
    },
    receipt,
  };
}

async function reconcileJupyterReflection(
  action: PreparedAction,
  context: ToolExecutionContext,
) {
  await assertPreparedActionBinding(action, context, false);
  const payload = parsePreparedPayload(action);
  assertPreparedDestinationAuthority(payload, context);
  let observed: ObservedNotebookTargetV1;
  try {
    observed = await observeNotebookTarget(context, payload.path);
  } catch (error) {
    return {
      outcome: "still_uncertain" as const,
      message: `The exact notebook target could not be read during reconciliation: ${safeErrorMessage(error)}`,
    };
  }
  if (
    observed.kind === "jupyter" &&
    observed.content === payload.proposedNotebook &&
    sha256Text(observed.content) === payload.expectedAfterSha256
  ) {
    const checkedAt = canonicalNow(context);
    return {
      outcome: "committed" as const,
      receipt: await buildActionReceipt({
        action,
        grantId: "reconciled-exact-readback",
        commitKind: "reconciled",
        startedAt: checkedAt,
        committedAt: checkedAt,
        observedRevision: payload.expectedAfterSha256,
        bytesWritten:
          payload.mode === "create"
            ? byteLength(payload.proposedNotebook)
            : Math.max(
                0,
                byteLength(payload.proposedNotebook) -
                  byteLength(payload.beforeNotebook),
              ),
        mode: payload.mode,
      }),
      message:
        `Reconciled the notebook ${payload.mode} from exact approved-byte readback; no write was replayed.`,
    };
  }
  if (
    (payload.mode === "create" && observed.kind === "missing") ||
    (payload.mode === "append" &&
      observed.kind === "jupyter" &&
      observed.content === payload.beforeNotebook &&
      sha256Text(observed.content) === payload.expectedBeforeSha256)
  ) {
    return {
      outcome: "not_applied" as const,
      message:
        payload.mode === "create"
          ? "The no-overwrite Jupyter Results target remains absent; reconciliation did not replay creation."
          : "The notebook still exactly matches the sealed pre-write bytes; reconciliation did not replay the append.",
    };
  }
  return {
    outcome: "still_uncertain" as const,
    message:
      payload.mode === "create"
        ? "The no-overwrite Jupyter Results target exists but does not match the exact approved bytes; manual review is required and no write was replayed."
        : "The notebook matches neither the exact sealed before bytes nor the exact approved result; manual review is required and no write was replayed.",
  };
}

function resolveHostProjectEvents(
  context: ToolExecutionContext,
  runId: string,
): ProjectStageEventV1[] {
  const supplied = context.getProjectStageEvents?.(runId) ?? [];
  if (!Array.isArray(supplied) || supplied.length > 1_000) {
    throw notApplied(
      "jupyter_reflection_evidence_invalid",
      "The host project-stage evidence exceeds its bounded contract.",
    );
  }
  const callbackEvents = supplied.map(parseProjectStageEventV1);
  const lineageEvents = (context.getProjectLineages?.() ?? [])
    .map(parseProjectLineageV1)
    .filter((lineage) => lineage.runId === runId)
    .flatMap((lineage) =>
      projectStageEventsFromProjectLineageV1({ lineage, runId }),
    );
  const candidates: ProjectStageEventV1[] = [];
  for (const event of [...callbackEvents, ...lineageEvents]) {
    if (event.runId !== runId) {
      throw notApplied(
        "jupyter_reflection_evidence_run_mismatch",
        "Project-stage evidence belongs to a different run.",
      );
    }
    candidates.push(event);
  }
  return mergeProjectStageEventsPreferExactWorkUnitScopeV1(candidates);
}

function resolveProjectWorkUnitBindings(
  context: ToolExecutionContext,
  runId: string,
): ProjectWorkUnitLinearBindingV1[] {
  const unique = new Map<string, ProjectWorkUnitLinearBindingV1>();
  for (const raw of context.getProjectLineages?.() ?? []) {
    const lineage = parseProjectLineageV1(raw);
    if (lineage.runId !== runId) continue;
    for (const binding of projectLinearBindingsFromProjectLineageV1({
      lineage,
      runId,
    })) {
      const prior = unique.get(binding.workUnitId);
      if (prior && prior.bindingFingerprint !== binding.bindingFingerprint) {
        throw notApplied(
          "jupyter_reflection_work_unit_binding_conflict",
          `Project work unit ${binding.workUnitId} has conflicting durable Linear bindings.`,
        );
      }
      unique.set(binding.workUnitId, binding);
    }
  }
  return [...unique.values()].sort((left, right) =>
    left.workUnitId.localeCompare(right.workUnitId),
  );
}

function deriveLimitations(
  runId: string,
  events: readonly ProjectStageEventV1[],
): string[] {
  const snapshot = reduceProjectStageEventsV1({ runId, events: [...events] });
  return snapshot.phases
    .filter((phase) => phase.status !== "verified")
    .map((phase) =>
      phase.status === "blocked"
        ? `${phase.label} remains blocked; see its recorded blocker evidence.`
        : `${phase.label} has no verified completion evidence yet.`,
    );
}

function resolveProjectName(
  context: ToolExecutionContext,
  runId: string,
): string {
  const title = context.runtimeCache?.projectIdeaBrief?.title?.trim();
  return title || `Project ${runId}`;
}

function composeNotebookReportMarkdown(
  report: ProjectRunReportV1,
  assistantMarkdown: string,
): string {
  return `${renderProjectRunReportMarkdownV1(report).trimEnd()}\n\n## Supplemental assistant notes\n\n> These notes are bounded assistant prose, not completion evidence. Phase status is derived only from the host evidence above.\n\n${assistantMarkdown.trim()}\n`;
}

/** Git object ids are 40-hex (SHA-1) or 64-hex (SHA-256 repositories). */
const GIT_COMMIT_SHA_V1 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

async function resolveCurrentRunCodeExamples(
  context: ToolExecutionContext,
  runId: string,
  events: readonly ProjectStageEventV1[],
): Promise<ResolvedJupyterCodeExamplesV1> {
  const acceptedRunIds = new Set(
    [context.rootMissionId, context.runId]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.trim()),
  );
  const lineage = (context.getProjectLineages?.() ?? [])
    .map(parseProjectLineageV1)
    .filter((candidate) => acceptedRunIds.has(candidate.runId))
    .sort((left, right) => {
      const byCommitCount = right.commits.length - left.commits.length;
      return byCommitCount || right.updatedAt.localeCompare(left.updatedAt);
    })[0];
  const codeCommit = [...(lineage?.commits ?? [])].reverse().find(
    (commit) =>
      commit.proof.stage === "code_execution" ||
      commit.proof.stage === "code_validation",
  );
  const commitEvent = [...events]
    .filter(
      (event) =>
        event.runId === runId &&
        event.disposition === "verified" &&
        event.evidenceKind === "commit_readback",
    )
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];
  const codeCompletionRequested =
    hasCodeExecutionIntent(context.originalPrompt) ||
    /\b(?:code|implementation|repository|commit|github|tests?|validation)\b/iu.test(
      context.originalPrompt,
    );
  if (!codeCommit && !commitEvent && !codeCompletionRequested) {
    return { bundle: null, reportExamples: [] };
  }
  let resolved: VerifiedCodeReflectionExamplesV1 | null = null;
  // A commit_readback event proves a verified local commit happened, but its
  // resource is the durable repair checkpoint: the id is the checkpoint id and
  // the revision is that checkpoint's sequence number ("1"), never a Git
  // object id. Reading it as a commit sha made the tool demand that the
  // resolved examples be "bound to commit 1" and blocked the final node of the
  // journey. Only a value that is actually a commit id may constrain which
  // commit the examples must come from; otherwise the durable publication
  // handoff remains the authority.
  const rawEventRevision = commitEvent
    ? commitEvent.resource.revision ?? commitEvent.resource.id
    : null;
  const eventCommitSha =
    rawEventRevision !== null && GIT_COMMIT_SHA_V1.test(rawEventRevision)
      ? rawEventRevision
      : null;
  let expectedCommitSha = eventCommitSha;
  let triedExactCommitSha: string | null = null;
  try {
    if (
      codeCommit?.proof.stage === "code_execution" ||
      codeCommit?.proof.stage === "code_validation"
    ) {
      if (expectedCommitSha && expectedCommitSha !== codeCommit.proof.commitSha) {
        throw new Error(
          "Host stage evidence and durable code lineage name different commits.",
        );
      }
      expectedCommitSha = codeCommit.proof.commitSha;
      triedExactCommitSha = codeCommit.proof.commitSha;
      resolved =
        (await context.resolveVerifiedCodeReflectionExamples?.({
          repositoryProfileKey: codeCommit.proof.repositoryProfileKey,
          commitSha: codeCommit.proof.commitSha,
        })) ?? null;
    }
    if (
      !resolved &&
      expectedCommitSha !== null &&
      expectedCommitSha !== triedExactCommitSha &&
      context.resolveVerifiedCodeReflectionExamples
    ) {
      // A verified commit readback can name the exact commit even when the
      // durable project lineage carries no code stage for this run (a Phase B
      // implementation run whose lineage begins at accepted_research). Ask for
      // that exact commit before considering the latest durable handoff:
      // resolving "latest" first and then rejecting it for not matching is the
      // only outcome that path can produce.
      try {
        triedExactCommitSha = expectedCommitSha;
        resolved =
          (await context.resolveVerifiedCodeReflectionExamples({
            repositoryProfileKey: resolveRepositoryProfileKey(context),
            commitSha: expectedCommitSha,
          })) ?? null;
      } catch {
        // An ambiguous repository profile is not fatal here; the latest
        // durable handoff below remains a valid source.
      }
    }
    if (!resolved && codeCompletionRequested) {
      const repositoryProfileKey = resolveRepositoryProfileKey(context);
      if (!context.resolveLatestVerifiedCodeReflectionExamples) {
        throw new Error(
          "The host cannot resolve the latest durable verified code handoff.",
        );
      }
      resolved = await context.resolveLatestVerifiedCodeReflectionExamples({
        repositoryProfileKey,
      });
    }
  } catch (error) {
    throw notApplied(
      "jupyter_reflection_code_examples_unavailable",
      `Exact-commit reflection examples could not be resolved: ${safeErrorMessage(error)}`,
    );
  }
  if (!resolved) {
    throw notApplied(
      "jupyter_reflection_code_examples_unavailable",
      "This code-completion lineage requires exact-commit examples, but none were available.",
    );
  }
  let parsed: VerifiedCodeReflectionExamplesV1;
  try {
    parsed = parseVerifiedCodeReflectionExamplesV1(resolved);
  } catch (error) {
    throw notApplied(
      "jupyter_reflection_code_examples_unavailable",
      `The host returned invalid exact-commit examples: ${safeErrorMessage(error)}`,
    );
  }
  if (parsed.examples.length < 1) {
    throw notApplied(
      "jupyter_reflection_code_examples_unavailable",
      `Exact-commit examples for ${parsed.commitSha} contained no usable source excerpt.`,
    );
  }
  if (expectedCommitSha !== null && parsed.commitSha !== expectedCommitSha) {
    // Name both revisions. These are Git object ids for a disposable
    // workspace, not secrets, and a bare "do not match" left three audit runs
    // unable to tell a stale handoff from a mislabelled expectation.
    throw notApplied(
      "jupyter_reflection_code_examples_unavailable",
      `Resolved examples are bound to commit ${parsed.commitSha}, not the verified ${expectedCommitSha}.`,
    );
  }
  const reportExamples = commitEvent
    ? parsed.examples.map((example) => ({
        path: example.path,
        language: example.language,
        startLine: example.startLine,
        endLine: example.endLine,
        code: example.code,
        sourceReceiptId: commitEvent.sourceReceiptId,
        sourceFingerprint: example.codeSha256,
      }))
    : [];
  return { bundle: parsed, reportExamples };
}

function resolveRepositoryProfileKey(context: ToolExecutionContext): string {
  const keys = [...new Set(context.getRepositoryProfileKeys?.() ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);
  const explicitlyNamed = keys.filter((key) =>
    containsExactBoundedLiteral(context.originalPrompt, key),
  );
  if (explicitlyNamed.length === 1) return explicitlyNamed[0]!;
  if (explicitlyNamed.length === 0 && keys.length === 1) return keys[0]!;
  throw notApplied(
    "jupyter_reflection_repository_ambiguous",
    explicitlyNamed.length > 1
      ? "The reflection names multiple trusted repository profiles; select exactly one."
      : "The code-completion reflection must name exactly one trusted repository profile.",
  );
}

interface PreparedPayloadV1 {
  path: string;
  mode: JupyterReflectionWriteModeV1;
  destinationSource: "default" | "explicit";
  assistantMarkdown: string;
  markdown: string;
  markerId: string;
  expectedTargetState: string;
  expectedBeforeSha256: string;
  expectedAfterSha256: string;
  beforeNotebook: string;
  proposedNotebook: string;
  report: ProjectRunReportV1;
  codeExamples: VerifiedCodeReflectionExamplesV1 | null;
}

function parsePreparedPayload(action: PreparedAction): PreparedPayloadV1 {
  const args = action.normalizedArgs;
  const expectedKeys = [
    "assistantMarkdown",
    "beforeNotebook",
    "codeExamples",
    "destinationSource",
    "expectedAfterSha256",
    "expectedBeforeSha256",
    "expectedTargetState",
    "markdown",
    "markerId",
    "mode",
    "path",
    "proposedNotebook",
    "report",
  ];
  if (Object.keys(args).sort().join("\0") !== expectedKeys.join("\0")) {
    throw notApplied(
      "jupyter_reflection_prepared_action_invalid",
      "Prepared Jupyter reflection arguments do not match the sealed report contract.",
    );
  }
  const path = requireSafeNotebookPath(args.path);
  const mode = requireEnum(
    args.mode,
    ["append", "create"] as const,
    "prepared write mode",
  );
  const destinationSource = requireEnum(
    args.destinationSource,
    ["default", "explicit"] as const,
    "prepared destination source",
  );
  const assistantMarkdown = requireText(
    args.assistantMarkdown,
    "prepared assistant markdown",
    100_000,
  );
  assertNoModelAuthoredCode(assistantMarkdown);
  const markdown = requireText(args.markdown, "prepared markdown", 1_000_000);
  const markerId = requireText(args.markerId, "prepared marker id", 256);
  const expectedBeforeSha256 = requireSha(args.expectedBeforeSha256, "prepared before hash");
  const expectedAfterSha256 = requireSha(args.expectedAfterSha256, "prepared after hash");
  const expectedTargetState =
    args.expectedTargetState === ABSENT_REVISION
      ? ABSENT_REVISION
      : requireSha(args.expectedTargetState, "prepared target state");
  const beforeNotebook = requireText(
    args.beforeNotebook,
    "prepared before notebook",
    10_000_000,
    true,
  );
  const proposedNotebook = requireText(
    args.proposedNotebook,
    "prepared proposed notebook",
    10_000_000,
  );
  let report: ProjectRunReportV1;
  try {
    report = parseProjectRunReportV1(args.report);
  } catch (error) {
    throw notApplied(
      "jupyter_reflection_prepared_action_invalid",
      `Prepared project report is invalid: ${safeErrorMessage(error)}`,
    );
  }
  let codeExamples: VerifiedCodeReflectionExamplesV1 | null = null;
  if (args.codeExamples !== null) {
    try {
      codeExamples = parseVerifiedCodeReflectionExamplesV1(args.codeExamples);
    } catch (error) {
      throw notApplied(
        "jupyter_reflection_prepared_action_invalid",
        `Prepared code examples are invalid: ${safeErrorMessage(error)}`,
      );
    }
  }
  if (
    action.target.system !== "vault" ||
    action.target.resourceType !== "jupyter_notebook" ||
    action.target.id !== path ||
    action.target.path !== path ||
    action.runId !== report.runId ||
    report.destination.kind !== "jupyter" ||
    report.destination.source !== destinationSource ||
    report.destination.path !== path ||
    !report.evidence.some(
      (event) =>
        event.phase === "reflect" &&
        event.evidenceKind === "reflection_writeback" &&
        event.disposition === "verified" &&
        event.sourceReceiptId === action.id &&
        event.resource.system === "vault" &&
        event.resource.resourceType === "jupyter_notebook" &&
        event.resource.path === path,
    ) ||
    composeNotebookReportMarkdown(report, assistantMarkdown) !== markdown ||
    sha256Text(beforeNotebook) !== expectedBeforeSha256 ||
    sha256Text(proposedNotebook) !== expectedAfterSha256 ||
    action.expectedTargetRevision !== expectedTargetState ||
    (mode === "create" && expectedTargetState !== ABSENT_REVISION) ||
    (mode === "append" && expectedTargetState !== expectedBeforeSha256)
  ) {
    throw notApplied(
      "jupyter_reflection_prepared_action_invalid",
      "Prepared notebook target or exact byte hashes are inconsistent.",
    );
  }
  try {
    validateJupyterNotebookContentV1(beforeNotebook);
    validateJupyterNotebookContentV1(proposedNotebook);
  } catch (error) {
    throw notApplied(
      "jupyter_reflection_prepared_action_invalid",
      `Prepared notebook bytes are invalid: ${safeErrorMessage(error)}`,
    );
  }
  return {
    path,
    mode,
    destinationSource,
    assistantMarkdown,
    markdown,
    markerId,
    expectedTargetState,
    expectedBeforeSha256,
    expectedAfterSha256,
    beforeNotebook,
    proposedNotebook,
    report,
    codeExamples,
  };
}

async function assertPreparedActionBinding(
  action: PreparedAction,
  context: ToolExecutionContext,
  requireAuthorization: boolean,
): Promise<void> {
  if (
    action.toolName !== APPEND_JUPYTER_REFLECTION_TOOL_NAME ||
    !(await verifyPreparedActionFingerprint(action))
  ) {
    throw notApplied(
      "jupyter_reflection_fingerprint_mismatch",
      "Prepared Jupyter reflection identity or fingerprint is invalid.",
    );
  }
  if (requireAuthorization) {
    const authorized = context.authorizedAction;
    if (
      !authorized ||
      authorized.preparedActionId !== action.id ||
      authorized.payloadFingerprint !== action.payloadFingerprint ||
      !authorized.grantId.trim()
    ) {
      throw notApplied(
        "jupyter_reflection_authorization_mismatch",
        "Prepared Jupyter reflection lacks its exact approval binding.",
      );
    }
    if (Date.parse(canonicalNow(context)) > Date.parse(action.expiresAt)) {
      throw notApplied(
        "jupyter_reflection_approval_expired",
        "Prepared Jupyter reflection approval has expired; prepare it again.",
      );
    }
  }
}

async function buildActionReceipt(input: {
  action: PreparedAction;
  grantId: string;
  commitKind: "committed" | "reconciled";
  startedAt: string;
  committedAt: string;
  observedRevision: string;
  bytesWritten: number;
  mode: JupyterReflectionWriteModeV1;
}): Promise<ActionReceipt> {
  const receiptHash = await sha256Fingerprint({
    actionId: input.action.id,
    commitKind: input.commitKind,
    observedRevision: input.observedRevision,
  });
  return {
    version: 1,
    id: `jupyter-receipt-${receiptHash.slice("sha256:".length, 39)}`,
    runId: input.action.runId,
    actionId: input.action.id,
    toolName: input.action.toolName,
    operation: "append",
    resource: { ...input.action.target },
    relatedResources: input.action.relatedResources,
    message:
      input.commitKind === "reconciled"
        ? `Reconciled the exact approved Jupyter reflection ${input.mode} at ${input.action.target.path}.`
        : input.mode === "create"
          ? `Created the no-overwrite Jupyter Results notebook at ${input.action.target.path}.`
          : `Appended the exact approved reflection to ${input.action.target.path}.`,
    payloadFingerprint: input.action.payloadFingerprint,
    grantId: input.grantId,
    idempotencyKey: input.action.idempotencyKey,
    startedAt: input.startedAt,
    committedAt: input.committedAt,
    commitKind: input.commitKind,
    readback: {
      status: "verified",
      checkedAt: input.committedAt,
      observedRevision: input.observedRevision,
      observedFingerprint: input.observedRevision,
    },
    effects: { bytesWritten: input.bytesWritten, affectedCount: 1 },
  };
}

function resolveJupyterReflectionDestinationV1(input: {
  prompt: string;
  requestedPath: unknown;
  projectName: string;
  runId: string;
  generatedAt: string;
}): { kind: "jupyter"; path: string; source: "default" | "explicit" } {
  if (!hasJupyterReflectionIntentV1(input.prompt)) {
    throw notApplied(
      "jupyter_reflection_intent_missing",
      "Jupyter reflection requires an affirmative original user request; negation remains authoritative.",
    );
  }
  const explicitPaths = extractExplicitJupyterNotebookPathsV1(input.prompt);
  if (explicitPaths.length > 1) {
    throw notApplied(
      "jupyter_reflection_destination_ambiguous",
      "The original request names multiple safe Jupyter paths; select exactly one destination.",
    );
  }
  if (explicitPaths.length === 1) {
    const explicitPath = explicitPaths[0]!;
    if (
      input.requestedPath !== undefined &&
      requireSafeNotebookPath(input.requestedPath) !== explicitPath
    ) {
      throw notApplied(
        "jupyter_reflection_path_not_explicit",
        "The notebook target must exactly match the safe .ipynb path in the original user prompt.",
      );
    }
    const destination = resolveProjectResultsDestinationV1({
      projectName: input.projectName,
      runId: input.runId,
      completedAt: input.generatedAt,
      explicitPath,
    });
    if (destination.kind !== "jupyter") {
      throw notApplied(
        "jupyter_reflection_path_invalid",
        "The explicit Jupyter reflection destination must end in .ipynb.",
      );
    }
    return {
      kind: "jupyter",
      path: destination.path,
      source: destination.source,
    };
  }
  if (input.requestedPath !== undefined) {
    requireSafeNotebookPath(input.requestedPath);
    throw notApplied(
      "jupyter_reflection_path_not_explicit",
      "A model-selected notebook path is not authorized. Omit path so the host can derive the no-overwrite Results destination.",
    );
  }
  const defaultResults = resolveProjectResultsDestinationV1({
    projectName: input.projectName,
    runId: input.runId,
    completedAt: input.generatedAt,
  });
  if (
    defaultResults.kind !== "markdown" ||
    !defaultResults.path.endsWith(".md")
  ) {
    throw notApplied(
      "jupyter_reflection_destination_invalid",
      "The host could not derive a safe default Jupyter Results destination.",
    );
  }
  return {
    kind: "jupyter",
    path: requireSafeNotebookPath(
      `${defaultResults.path.slice(0, -".md".length)}.ipynb`,
    ),
    source: "default",
  };
}

function assertPreparedDestinationAuthority(
  payload: PreparedPayloadV1,
  context: ToolExecutionContext,
): void {
  const resolved = resolveJupyterReflectionDestinationV1({
    prompt: context.originalPrompt,
    requestedPath:
      payload.destinationSource === "explicit" ? payload.path : undefined,
    projectName: payload.report.projectName,
    runId: payload.report.runId,
    generatedAt: payload.report.generatedAt,
  });
  if (
    resolved.path !== payload.path ||
    resolved.source !== payload.destinationSource
  ) {
    throw notApplied(
      "jupyter_reflection_destination_mismatch",
      "The sealed Jupyter destination no longer matches the original user authority.",
    );
  }
}

function buildNewReflectionNotebookBaseV1(): string {
  const built = buildJupyterNotebookV1({
    cells: [
      {
        type: "markdown",
        source: [
          "# Project results",
          "",
          "This notebook is a host-verified, unexecuted record of the developer mission.",
        ].join("\n"),
      },
    ],
  });
  if (built.executionState !== "not_executed") {
    throw notApplied(
      "jupyter_reflection_template_invalid",
      "The host Jupyter Results template did not preserve the unexecuted state.",
    );
  }
  validateJupyterNotebookContentV1(built.content);
  return built.content;
}

type ObservedNotebookTargetV1 =
  | { kind: "missing" }
  | { kind: "other" }
  | { kind: "jupyter"; content: string };

async function observeNotebookTarget(
  context: ToolExecutionContext,
  path: string,
): Promise<ObservedNotebookTargetV1> {
  const candidate = context.app?.vault?.getAbstractFileByPath(path);
  if (!candidate) return { kind: "missing" };
  if (
    candidate.path !== path ||
    !("extension" in candidate) ||
    (candidate as TFile).extension.toLowerCase() !== "ipynb"
  ) {
    return { kind: "other" };
  }
  const content = await context.app.vault.read(candidate as TFile);
  if (
    typeof content !== "string" ||
    byteLength(content) > MAX_NOTEBOOK_BYTES ||
    content.includes("\0")
  ) {
    return { kind: "other" };
  }
  try {
    validateJupyterNotebookContentV1(content);
  } catch {
    return { kind: "other" };
  }
  return { kind: "jupyter", content };
}

async function ensureParentFolders(
  context: ToolExecutionContext,
  targetPath: string,
): Promise<void> {
  const parts = targetPath.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = context.app.vault.getAbstractFileByPath(current);
    if (existing) {
      if ("extension" in existing) {
        throw notApplied(
          "jupyter_reflection_parent_blocked",
          `A file blocks the Jupyter Results folder ${current}.`,
        );
      }
      continue;
    }
    await context.app.vault.createFolder(current);
  }
}

function notebookStore(context: ToolExecutionContext): ReflectionWritebackStoreV1 {
  return {
    read: (path) => readExactNotebook(context, path),
    modify: async (path, content) => {
      const file = requireExactNotebookFile(context, path);
      await context.app.vault.modify(file, content);
    },
  };
}

async function readExactNotebook(
  context: ToolExecutionContext,
  path: string,
): Promise<string> {
  const observed = await observeNotebookTarget(context, path);
  if (observed.kind !== "jupyter") {
    throw notApplied(
      observed.kind === "missing"
        ? "jupyter_reflection_target_missing"
        : "jupyter_reflection_target_invalid",
      observed.kind === "missing"
        ? `The exact notebook ${path} was not found in the vault.`
        : "Notebook readback must be a valid bounded nbformat 4 UTF-8 document without null bytes.",
    );
  }
  return observed.content;
}

function requireExactNotebookFile(
  context: ToolExecutionContext,
  path: string,
): TFile {
  const candidate = context.app?.vault?.getAbstractFileByPath(path);
  if (
    !candidate ||
    candidate.path !== path ||
    !("extension" in candidate) ||
    (candidate as TFile).extension.toLowerCase() !== "ipynb"
  ) {
    throw notApplied(
      "jupyter_reflection_target_missing",
      `The exact existing notebook ${path} was not found in the vault.`,
    );
  }
  return candidate as TFile;
}

function assertExactArgs(args: Record<string, unknown>): void {
  const keys = Object.keys(args).sort().join("\0");
  if (keys !== "markdown" && keys !== "markdown\0path") {
    throw notApplied(
      "jupyter_reflection_invalid_arguments",
      "Jupyter reflection arguments require markdown and may include only one explicit path; code examples and default destinations are host-resolved.",
    );
  }
}

function requireSafeNotebookPath(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || value.length > 1024) {
    throw notApplied(
      "jupyter_reflection_path_invalid",
      "Jupyter reflection requires a bounded vault-relative .ipynb path.",
    );
  }
  const parts = value.split("/");
  if (
    !value ||
    !value.toLowerCase().endsWith(".ipynb") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[a-z]:/iu.test(value) ||
    /[\0\r\n?#]/u.test(value) ||
    parts.some(
      (part) => !part || part === "." || part === ".." || part.startsWith("."),
    )
  ) {
    throw notApplied(
      "jupyter_reflection_path_invalid",
      "Jupyter reflection target must be a safe vault-relative .ipynb path.",
    );
  }
  return value;
}

function containsExactBoundedLiteral(prompt: string, value: string): boolean {
  const haystack = prompt;
  const needle = value;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return false;
    const before = index > 0 ? haystack[index - 1]! : "";
    const after = haystack[index + needle.length] ?? "";
    if (
      (!before || !/[a-z0-9._/-]/u.test(before)) &&
      (!after || !/[a-z0-9._/-]/u.test(after))
    ) {
      return true;
    }
    offset = index + 1;
  }
  return false;
}

function assertNoModelAuthoredCode(markdown: string): void {
  if (
    /(?:^|\n)\s*(?:```|~~~)/u.test(markdown) ||
    /<\/?(?:pre|code)\b/iu.test(markdown) ||
    /`/u.test(markdown) ||
    /(?:^|\n)(?: {4}|\t)\S/u.test(markdown) ||
    /(?:=>|[{}]|;\s*(?:$|\n))/u.test(markdown) ||
    /\b[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*\([^\n)]*\)/iu.test(markdown) ||
    /(?:^|\n)\s*(?:const|let|var|function|class|def|import|from|return|async|await|if|for|while|try|catch)\b/iu.test(
      markdown,
    )
  ) {
    throw notApplied(
      "jupyter_reflection_model_code_forbidden",
      "Jupyter reflection markdown must be prose-only and cannot contain model-authored code syntax; exact code examples are host-resolved.",
    );
  }
}

async function buildMarkerId(input: {
  runId: string;
  toolCallId: string;
  path: string;
}): Promise<string> {
  const hash = await sha256Fingerprint(input);
  return `run-${hash.slice("sha256:".length, 31)}`;
}

function canonicalNow(context: ToolExecutionContext): string {
  const now = context.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw notApplied(
      "jupyter_reflection_clock_invalid",
      "The host Jupyter reflection clock is invalid.",
    );
  }
  return now.toISOString();
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)
  ) {
    throw notApplied(
      "jupyter_reflection_context_invalid",
      `Jupyter reflection requires a host-owned ${label}.`,
    );
  }
  return value;
}

function requireText(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    value.includes("\0") ||
    (!allowEmpty && !value.trim())
  ) {
    throw notApplied(
      "jupyter_reflection_prepared_action_invalid",
      `${label} must be bounded text.`,
    );
  }
  return value;
}

function requireSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw notApplied(
      "jupyter_reflection_prepared_action_invalid",
      `${label} must be a canonical SHA-256 value.`,
    );
  }
  return value;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw notApplied(
      "jupyter_reflection_prepared_action_invalid",
      `${label} is invalid.`,
    );
  }
  return value as T[number];
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sha256Text(value: string): string {
  return `sha256:${portableSha256Text(value)}`;
}

function cloneJson<T>(value: T): JsonValue & T {
  return JSON.parse(JSON.stringify(value)) as JsonValue & T;
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown Jupyter reflection error.")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/(token|secret|password)\s*[=:]\s*[^\s,;}]+/giu, "$1=[REDACTED]")
    .slice(0, 2_000);
}

function notApplied(code: string, message: string): ToolExecutionError {
  return new ToolExecutionError(code, message, { mutationState: "not_applied" });
}

const PARAMETERS: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["markdown"],
  properties: {
    path: {
      type: "string",
      description:
        "Optional exact vault-relative .ipynb path present in the original user prompt. Omit it for a natural Jupyter request so the host derives a no-overwrite Results path.",
    },
    markdown: {
      type: "string",
      description:
        "Concise meaningful reflection prose. Do not include code; verified code examples are host-resolved.",
    },
  },
};

const DESCRIPTOR: ToolDescriptor = {
  version: 1,
  name: APPEND_JUPYTER_REFLECTION_TOOL_NAME,
  capability: {
    system: "vault",
    resourceType: "jupyter_notebook",
    action: "append",
  },
  effect: "reversible_mutation",
  risk: "medium",
  approval: {
    allowPromptGrant: false,
    allowPersistentGrant: false,
    fallback: "exact",
  },
  execution: {
    preparation: "required",
    cacheable: false,
    parallelSafe: false,
  },
  durability: {
    journal: true,
    receipt: true,
    readback: "required",
    reconciliation: "required",
  },
  allowedPrincipals: ["single_agent", "lead"],
  receiptKind: "vault_write",
};
