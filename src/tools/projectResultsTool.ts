import type { TFile } from "obsidian";
import {
  parseVerifiedCodeReflectionExamplesV1,
  type VerifiedCodeReflectionExamplesV1,
} from "@agentic-researcher/core-api";
import { portableSha256Text } from "../../packages/core-api/src/portableSha256";
import {
  createProjectRunReportV1,
  createProjectStageEventV1,
  parseProjectRunReportV1,
  parseProjectStageEventV1,
  reduceProjectStageEventsV1,
  renderProjectRunReportMarkdownV1,
  resolveProjectResultsDestinationV1,
  type ProjectCodeExampleV1,
  type ProjectStageEventV1,
} from "../agent/projectRunReport";
import {
  parseProjectLineageV1,
} from "../agent/projectLifecycle";
import {
  mergeProjectStageEventsPreferExactWorkUnitScopeV1,
  projectLinearBindingsFromProjectLineageV1,
  projectStageEventsFromProjectLineageV1,
} from "../agent/projectStageLineageMapper";
import {
  projectWorkUnitOutcomesV1,
  type ProjectWorkUnitLinearBindingV1,
} from "../agent/projectProgressProjection";
import { extractMarkdownPathMentions } from "../agent/missionScope";
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

export const WRITE_PROJECT_RESULTS_TOOL_NAME = "write_project_results" as const;

const PREPARED_ACTION_TTL_MS = 10 * 60 * 1_000;
const MAX_REPORT_BYTES = 5_000_000;
const ABSENT_REVISION = "absent";

interface ResolvedCodeExamplesV1 {
  bundle: VerifiedCodeReflectionExamplesV1 | null;
  reportExamples: ProjectCodeExampleV1[];
}

/**
 * Create one immutable Markdown Results artifact from host-owned project
 * evidence. The model supplies no report prose, paths, receipts, or code.
 */
export function createProjectResultsTool(): AgentTool {
  return {
    name: WRITE_PROJECT_RESULTS_TOOL_NAME,
    description:
      "Create a deterministic no-overwrite Markdown Results artifact from the current/root run's verified receipts and lineage. The host chooses a safe default path unless the original user prompt explicitly names a Results .md destination, and it resolves code examples only from the exact verified commit handoff.",
    parameters: PARAMETERS,
    descriptor: DESCRIPTOR,
    async execute() {
      throw notApplied(
        "project_results_prepared_action_required",
        `${WRITE_PROJECT_RESULTS_TOOL_NAME} must be prepared and exactly approved before execution.`,
      );
    },
    prepare: prepareProjectResults,
    executePrepared: executePreparedProjectResults,
    reconcile: reconcileProjectResults,
  };
}

async function prepareProjectResults(
  args: Record<string, unknown>,
  rawContext: ToolExecutionContext,
): Promise<PreparedActionResult> {
  try {
    assertExactArgs(args);
    const context = rawContext;
    const runId = requireIdentifier(
      context.rootMissionId?.trim() || context.runId,
      "project run id",
    );
    const toolCallId = requireIdentifier(context.operationId, "tool call id");
    const generatedAt = canonicalNow(context);
    const events = resolveHostProjectEvents(context, runId);
    const workUnitBindings = resolveProjectWorkUnitBindings(context, runId);
    const projectName = resolveProjectName(context, runId);
    const explicitPath = resolveExplicitResultsMarkdownPath(
      context.originalPrompt,
    );
    const destination = resolveProjectResultsDestinationV1({
      projectName,
      runId,
      completedAt: generatedAt,
      explicitPath,
    });
    if (destination.kind !== "markdown") {
      throw notApplied(
        "project_results_destination_invalid",
        "write_project_results creates only Markdown Results artifacts.",
      );
    }
    assertTargetAbsent(context, destination.path);

    const code = await resolveExactCodeExamples(context, runId, events);
    const preReflectionWorkUnitOutcomes = workUnitBindings.length > 0
      ? projectWorkUnitOutcomesV1({
          runId,
          events,
          bindings: workUnitBindings,
          projectedAt: generatedAt,
        })
      : undefined;
    const preReflectionReport = createProjectRunReportV1({
      runId,
      projectName,
      generatedAt,
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
      kind: "prospective_project_results_create",
      runId,
      toolCallId,
      path: destination.path,
      preReflectionReportFingerprint: preReflectionReport.reportFingerprint,
    });
    // This event can reach the vault only inside the sealed action bytes below;
    // an exact create/readback is therefore the commit point for Reflect.
    const prospectiveReflection = createProjectStageEventV1({
      schemaVersion: 1,
      runId,
      phase: "reflect",
      evidenceKind: "reflection_writeback",
      disposition: "verified",
      occurredAt: generatedAt,
      sourceReceiptId: `project-results-${reflectionBinding.slice("sha256:".length, 39)}`,
      evidenceFingerprint: reflectionBinding,
      resource: {
        system: "vault",
        resourceType: "markdown_file",
        id: destination.path,
        url: null,
        path: destination.path,
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
          projectedAt: generatedAt,
        })
      : undefined;
    const report = createProjectRunReportV1({
      runId,
      projectName,
      generatedAt,
      destination,
      events: finalEvents,
      ...(workUnitOutcomes === undefined ? {} : { workUnitOutcomes }),
      limitations: deriveLimitations(runId, finalEvents),
      codeExamples: code.reportExamples,
    });
    const proposedMarkdown = renderProjectRunReportMarkdownV1(report);
    const proposedBytes = byteLength(proposedMarkdown);
    if (proposedBytes > MAX_REPORT_BYTES) {
      throw notApplied(
        "project_results_too_large",
        "The deterministic Results artifact exceeds the 5 MB write boundary.",
      );
    }
    const expectedAfterSha256 = sha256Text(proposedMarkdown);
    const preparedAt = generatedAt;
    const actionId = prospectiveReflection.sourceReceiptId;
    const normalizedArgs: Record<string, JsonValue> = {
      expectedBeforeState: ABSENT_REVISION,
      expectedAfterSha256,
      proposedMarkdown,
      report: cloneJson(report),
      verifiedCodeExamples: code.bundle ? cloneJson(code.bundle) : null,
    };
    const action = await withPreparedActionFingerprint({
      version: 1,
      id: actionId,
      runId,
      toolCallId,
      toolName: WRITE_PROJECT_RESULTS_TOOL_NAME,
      target: {
        system: "vault",
        resourceType: "markdown_file",
        id: destination.path,
        path: destination.path,
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
        summary: `Create the immutable project Results artifact at ${destination.path}.`,
        destination: destination.path,
        before: { path: destination.path, state: ABSENT_REVISION },
        after: {
          path: destination.path,
          sha256: expectedAfterSha256,
          bytes: proposedBytes,
          reportFingerprint: report.reportFingerprint,
        },
        // Approval covers every byte that can reach the vault.
        outboundPayload: {
          path: destination.path,
          markdownContent: proposedMarkdown,
        },
        warnings: [
          "The target must remain absent; this action never overwrites an existing note.",
        ],
        outboundBytes: proposedBytes,
      },
      expectedTargetRevision: ABSENT_REVISION,
      idempotencyKey: `${runId}:${toolCallId}:${WRITE_PROJECT_RESULTS_TOOL_NAME}`,
      reconciliationKey: `${destination.path}:${expectedAfterSha256}`,
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
            : "project_results_preparation_failed",
        message: safeErrorMessage(error),
      },
    };
  }
}

async function executePreparedProjectResults(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<AgentToolActionExecution> {
  await assertPreparedActionBinding(action, context, true);
  const payload = parsePreparedPayload(action);
  assertExplicitDestinationStillBound(payload.path, context.originalPrompt, payload.report.destination.source);
  assertTargetAbsent(context, payload.path);
  const startedAt = canonicalNow(context);
  try {
    await ensureParentFolders(context, payload.path);
    await context.app.vault.create(payload.path, payload.proposedMarkdown);
  } catch (error) {
    const observed = await observeTarget(context, payload.path);
    if (
      observed.kind !== "markdown" ||
      observed.content !== payload.proposedMarkdown ||
      sha256Text(observed.content) !== payload.expectedAfterSha256
    ) {
      throw new ToolExecutionError(
        "project_results_create_uncertain",
        `Results creation did not return a verified exact readback: ${safeErrorMessage(error)}`,
        { mutationState: "may_have_applied" },
      );
    }
  }
  const observed = await observeTarget(context, payload.path);
  if (
    observed.kind !== "markdown" ||
    observed.content !== payload.proposedMarkdown ||
    sha256Text(observed.content) !== payload.expectedAfterSha256
  ) {
    throw new ToolExecutionError(
      "project_results_readback_failed",
      "Results creation did not match the exact approved Markdown bytes.",
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
    bytesWritten: byteLength(payload.proposedMarkdown),
  });
  return {
    mutationState: "applied",
    output: {
      path: payload.path,
      operation: "create",
      beforeState: ABSENT_REVISION,
      afterSha256: payload.expectedAfterSha256,
      bytesWritten: byteLength(payload.proposedMarkdown),
      report: cloneJson(payload.report),
      readbackVerified: true,
    },
    receipt,
  };
}

async function reconcileProjectResults(
  action: PreparedAction,
  context: ToolExecutionContext,
) {
  await assertPreparedActionBinding(action, context, false);
  const payload = parsePreparedPayload(action);
  let observed: ObservedTargetV1;
  try {
    observed = await observeTarget(context, payload.path);
  } catch (error) {
    return {
      outcome: "still_uncertain" as const,
      message: `The Results target could not be read during reconciliation; no create was replayed: ${safeErrorMessage(error)}`,
    };
  }
  if (
    observed.kind === "markdown" &&
    observed.content === payload.proposedMarkdown &&
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
        bytesWritten: byteLength(payload.proposedMarkdown),
      }),
      message:
        "Reconciled the exact approved Results bytes; no create was replayed.",
    };
  }
  if (observed.kind === "missing") {
    return {
      outcome: "not_applied" as const,
      message:
        "The Results file remains absent; reconciliation did not replay creation.",
    };
  }
  return {
    outcome: "still_uncertain" as const,
    message:
      "The Results path exists but does not match the exact approved bytes; manual review is required and no create was replayed.",
  };
}

function resolveHostProjectEvents(
  context: ToolExecutionContext,
  runId: string,
): ProjectStageEventV1[] {
  const supplied = context.getProjectStageEvents?.(runId) ?? [];
  if (!Array.isArray(supplied) || supplied.length > 1_000) {
    throw notApplied(
      "project_results_evidence_invalid",
      "The host project-stage evidence exceeds its bounded contract.",
    );
  }
  const callbackEvents = supplied.map(parseProjectStageEventV1);
  const lineages = (context.getProjectLineages?.() ?? [])
    .map(parseProjectLineageV1)
    .filter((lineage) => lineage.runId === runId);
  const lineageEvents = lineages.flatMap((lineage) =>
    projectStageEventsFromProjectLineageV1({ lineage, runId }),
  );
  const candidates: ProjectStageEventV1[] = [];
  for (const event of [...callbackEvents, ...lineageEvents]) {
    if (event.runId !== runId) {
      throw notApplied(
        "project_results_evidence_run_mismatch",
        "Project-stage evidence belongs to a different run.",
      );
    }
    candidates.push(event);
  }
  const merged = mergeProjectStageEventsPreferExactWorkUnitScopeV1(candidates);
  if (merged.length < 1) {
    throw notApplied(
      "project_results_evidence_unavailable",
      "No host-verified project-stage evidence is available for this run.",
    );
  }
  return merged;
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
          "project_results_work_unit_binding_conflict",
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

async function resolveExactCodeExamples(
  context: ToolExecutionContext,
  runId: string,
  events: readonly ProjectStageEventV1[],
): Promise<ResolvedCodeExamplesV1> {
  const commitEvent = [...events]
    .filter(
      (event) =>
        event.runId === runId &&
        event.disposition === "verified" &&
        event.evidenceKind === "commit_readback",
    )
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];
  if (!commitEvent) return { bundle: null, reportExamples: [] };
  const commitSha = commitEvent.resource.revision ?? commitEvent.resource.id;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commitSha)) {
    throw notApplied(
      "project_results_code_examples_unavailable",
      "Verified commit evidence does not contain a canonical commit SHA.",
    );
  }
  const bindings = new Map<string, { repositoryProfileKey: string; commitSha: string }>();
  for (const raw of context.getProjectLineages?.() ?? []) {
    const lineage = parseProjectLineageV1(raw);
    if (lineage.runId !== runId) continue;
    for (const candidate of lineage.commits) {
      if (
        (candidate.proof.stage === "code_execution" ||
          candidate.proof.stage === "code_validation") &&
        candidate.proof.commitSha === commitSha
      ) {
        const binding = {
          repositoryProfileKey: candidate.proof.repositoryProfileKey,
          commitSha,
        };
        bindings.set(`${binding.repositoryProfileKey}:${commitSha}`, binding);
      }
    }
  }
  if (bindings.size !== 1 || !context.resolveVerifiedCodeReflectionExamples) {
    throw notApplied(
      "project_results_code_examples_unavailable",
      "Exact verified code examples require one current/root lineage commit and its host handoff resolver.",
    );
  }
  const binding = [...bindings.values()][0]!;
  let bundle: VerifiedCodeReflectionExamplesV1;
  try {
    const resolved = await context.resolveVerifiedCodeReflectionExamples(binding);
    if (!resolved) throw new Error("No exact verified handoff matched the lineage commit.");
    bundle = parseVerifiedCodeReflectionExamplesV1(resolved);
  } catch (error) {
    throw notApplied(
      "project_results_code_examples_unavailable",
      `Exact-commit Results examples could not be resolved: ${safeErrorMessage(error)}`,
    );
  }
  if (bundle.commitSha !== commitSha || bundle.examples.length < 1) {
    throw notApplied(
      "project_results_code_examples_unavailable",
      "Resolved Results examples do not match the exact verified commit.",
    );
  }
  return {
    bundle,
    reportExamples: bundle.examples.map((example) => ({
      path: example.path,
      language: example.language,
      startLine: example.startLine,
      endLine: example.endLine,
      code: example.code,
      sourceReceiptId: commitEvent.sourceReceiptId,
      sourceFingerprint: example.codeSha256,
    })),
  };
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

function resolveExplicitResultsMarkdownPath(prompt: string): string | null {
  const discovered = new Set(extractMarkdownPathMentions(prompt));
  for (const match of prompt.matchAll(/["'`]([^"'`\r\n]{1,1024}\.md)["'`]/giu)) {
    if (match[1]) discovered.add(match[1]);
  }
  const candidates = [...discovered].filter(
    (candidate) =>
      ![...discovered].some(
        (other) => other !== candidate && other.endsWith(`/${candidate}`),
      ),
  );
  const bound = candidates.filter(
    (candidate) =>
      isSafeMarkdownPath(candidate) &&
      promptBindsPathToResults(prompt, candidate),
  );
  if (bound.length > 1) {
    throw notApplied(
      "project_results_destination_ambiguous",
      `The original mission names more than one explicit Markdown Results destination: ${bound.join(", ")}.`,
    );
  }
  return bound[0] ?? null;
}

function promptBindsPathToResults(prompt: string, path: string): boolean {
  let offset = 0;
  while (offset <= prompt.length - path.length) {
    const index = prompt.indexOf(path, offset);
    if (index < 0) return false;
    const clause = prompt.slice(Math.max(0, index - 120), index);
    if (
      /\b(?:project\s+)?(?:results?|report|reflection|writeback)(?:\s+(?:note|file|path))?(?:\s+(?:to|at|into|in|as|named|called))?[^.!?\n]{0,50}$/iu.test(
        clause,
      )
    ) {
      return true;
    }
    offset = index + path.length;
  }
  return false;
}

function assertExplicitDestinationStillBound(
  path: string,
  prompt: string,
  source: "default" | "explicit",
): void {
  if (source === "explicit" && resolveExplicitResultsMarkdownPath(prompt) !== path) {
    throw notApplied(
      "project_results_destination_changed",
      "The prepared explicit Results destination no longer matches the original mission.",
    );
  }
}

interface PreparedPayloadV1 {
  path: string;
  expectedAfterSha256: string;
  proposedMarkdown: string;
  report: ReturnType<typeof parseProjectRunReportV1>;
  verifiedCodeExamples: VerifiedCodeReflectionExamplesV1 | null;
}

function parsePreparedPayload(action: PreparedAction): PreparedPayloadV1 {
  assertExactRecord(action.normalizedArgs, [
    "expectedBeforeState",
    "expectedAfterSha256",
    "proposedMarkdown",
    "report",
    "verifiedCodeExamples",
  ]);
  if (action.normalizedArgs.expectedBeforeState !== ABSENT_REVISION) {
    throw invalidPrepared("Prepared Results target must be sealed as absent.");
  }
  const report = parseProjectRunReportV1(action.normalizedArgs.report);
  if (report.destination.kind !== "markdown") {
    throw invalidPrepared("Prepared Results report must target Markdown.");
  }
  const path = requireSafeMarkdownPath(report.destination.path);
  const proposedMarkdown = requireText(
    action.normalizedArgs.proposedMarkdown,
    "prepared Results Markdown",
    MAX_REPORT_BYTES,
  );
  const expectedAfterSha256 = requireSha(
    action.normalizedArgs.expectedAfterSha256,
    "prepared Results after hash",
  );
  let verifiedCodeExamples: VerifiedCodeReflectionExamplesV1 | null = null;
  if (action.normalizedArgs.verifiedCodeExamples !== null) {
    verifiedCodeExamples = parseVerifiedCodeReflectionExamplesV1(
      action.normalizedArgs.verifiedCodeExamples,
    );
  }
  const expectedReportExamples = verifiedCodeExamples
    ? projectExamplesFromBundle(report.evidence, verifiedCodeExamples)
    : [];
  if (
    JSON.stringify(expectedReportExamples) !== JSON.stringify(report.codeExamples) ||
    renderProjectRunReportMarkdownV1(report) !== proposedMarkdown ||
    sha256Text(proposedMarkdown) !== expectedAfterSha256 ||
    action.target.system !== "vault" ||
    action.target.resourceType !== "markdown_file" ||
    action.target.id !== path ||
    action.target.path !== path ||
    action.expectedTargetRevision !== ABSENT_REVISION ||
    action.preview.outboundPayload?.markdownContent !== proposedMarkdown ||
    action.preview.outboundPayload?.path !== path ||
    action.preview.outboundBytes !== byteLength(proposedMarkdown)
  ) {
    throw invalidPrepared(
      "Prepared Results target, report, code evidence, or exact bytes are inconsistent.",
    );
  }
  return {
    path,
    expectedAfterSha256,
    proposedMarkdown,
    report,
    verifiedCodeExamples,
  };
}

function projectExamplesFromBundle(
  evidence: readonly ProjectStageEventV1[],
  bundle: VerifiedCodeReflectionExamplesV1,
): ProjectCodeExampleV1[] {
  const commitEvent = [...evidence]
    .filter(
      (event) =>
        event.evidenceKind === "commit_readback" &&
        (event.resource.revision ?? event.resource.id) === bundle.commitSha,
    )
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];
  if (!commitEvent) {
    throw invalidPrepared(
      "Prepared code examples are not bound to report commit evidence.",
    );
  }
  return bundle.examples.map((example) => ({
    path: example.path,
    language: example.language,
    startLine: example.startLine,
    endLine: example.endLine,
    code: example.code,
    sourceReceiptId: commitEvent.sourceReceiptId,
    sourceFingerprint: example.codeSha256,
  }));
}

async function assertPreparedActionBinding(
  action: PreparedAction,
  context: ToolExecutionContext,
  requireAuthorization: boolean,
): Promise<void> {
  if (
    action.toolName !== WRITE_PROJECT_RESULTS_TOOL_NAME ||
    !(await verifyPreparedActionFingerprint(action))
  ) {
    throw notApplied(
      "project_results_fingerprint_mismatch",
      "Prepared Results identity or fingerprint is invalid.",
    );
  }
  if (!requireAuthorization) return;
  const authorized = context.authorizedAction;
  if (
    !authorized ||
    authorized.preparedActionId !== action.id ||
    authorized.payloadFingerprint !== action.payloadFingerprint ||
    !authorized.grantId.trim()
  ) {
    throw notApplied(
      "project_results_authorization_mismatch",
      "Prepared Results creation lacks its exact approval binding.",
    );
  }
  if (Date.parse(canonicalNow(context)) > Date.parse(action.expiresAt)) {
    throw notApplied(
      "project_results_approval_expired",
      "Prepared Results approval has expired; prepare it again.",
    );
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
}): Promise<ActionReceipt> {
  const receiptHash = await sha256Fingerprint({
    actionId: input.action.id,
    commitKind: input.commitKind,
    observedRevision: input.observedRevision,
  });
  return {
    version: 1,
    id: `project-results-receipt-${receiptHash.slice("sha256:".length, 39)}`,
    runId: input.action.runId,
    actionId: input.action.id,
    toolName: input.action.toolName,
    operation: "create",
    resource: { ...input.action.target },
    relatedResources: input.action.relatedResources,
    message:
      input.commitKind === "reconciled"
        ? `Reconciled the exact approved Results artifact at ${input.action.target.path}.`
        : `Created the exact approved Results artifact at ${input.action.target.path}.`,
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
    effects: {
      bytesWritten: input.bytesWritten,
      affectedCount: 1,
    },
  };
}

type ObservedTargetV1 =
  | { kind: "missing" }
  | { kind: "other" }
  | { kind: "markdown"; content: string };

async function observeTarget(
  context: ToolExecutionContext,
  path: string,
): Promise<ObservedTargetV1> {
  const candidate = context.app?.vault?.getAbstractFileByPath(path);
  if (!candidate) return { kind: "missing" };
  if (
    candidate.path !== path ||
    !("extension" in candidate) ||
    (candidate as TFile).extension.toLowerCase() !== "md"
  ) {
    return { kind: "other" };
  }
  const content = await context.app.vault.read(candidate as TFile);
  if (
    typeof content !== "string" ||
    byteLength(content) > MAX_REPORT_BYTES ||
    content.includes("\0")
  ) {
    return { kind: "other" };
  }
  return { kind: "markdown", content };
}

function assertTargetAbsent(context: ToolExecutionContext, path: string): void {
  if (context.app?.vault?.getAbstractFileByPath(path)) {
    throw notApplied(
      "project_results_target_exists",
      `The Results target ${path} already exists; this tool never overwrites it.`,
    );
  }
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
        throw new Error(`A file blocks the Results folder ${current}.`);
      }
      continue;
    }
    await context.app.vault.createFolder(current);
  }
}

function assertExactArgs(args: Record<string, unknown>): void {
  if (Object.keys(args).length !== 0) {
    throw notApplied(
      "project_results_invalid_arguments",
      "write_project_results accepts no model-authored fields; path, evidence, prose, and code are host-resolved.",
    );
  }
}

function assertExactRecord(
  value: Record<string, JsonValue>,
  expectedKeys: readonly string[],
): void {
  if (
    Object.keys(value).sort().join("\0") !==
    [...expectedKeys].sort().join("\0")
  ) {
    throw invalidPrepared(
      "Prepared Results payload does not match its closed contract.",
    );
  }
}

function requireSafeMarkdownPath(value: unknown): string {
  if (typeof value !== "string" || !isSafeMarkdownPath(value)) {
    throw invalidPrepared(
      "Results target must be a safe vault-relative Markdown path.",
    );
  }
  return value;
}

function isSafeMarkdownPath(value: string): boolean {
  const parts = value.split("/");
  return (
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.toLowerCase().endsWith(".md") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/^[a-z]:/iu.test(value) &&
    !/[\0\r\n?#]/u.test(value) &&
    parts.every(
      (part) => part && part !== "." && part !== ".." && !part.startsWith("."),
    )
  );
}

function canonicalNow(context: ToolExecutionContext): string {
  const now = context.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw notApplied(
      "project_results_clock_invalid",
      "The host Results clock is invalid.",
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
      "project_results_context_invalid",
      `write_project_results requires a host-owned ${label}.`,
    );
  }
  return value;
}

function requireText(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\0") ||
    byteLength(value) > maximumBytes
  ) {
    throw invalidPrepared(`${label} must be bounded non-empty text.`);
  }
  return value;
}

function requireSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw invalidPrepared(`${label} must be a canonical SHA-256 value.`);
  }
  return value;
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
  return (error instanceof Error ? error.message : "Unknown Results error.")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/(token|secret|password)\s*[=:]\s*[^\s,;}]+/giu, "$1=[REDACTED]")
    .slice(0, 2_000);
}

function invalidPrepared(message: string): ToolExecutionError {
  return notApplied("project_results_prepared_action_invalid", message);
}

function notApplied(code: string, message: string): ToolExecutionError {
  return new ToolExecutionError(code, message, { mutationState: "not_applied" });
}

const PARAMETERS: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

const DESCRIPTOR: ToolDescriptor = {
  version: 1,
  name: WRITE_PROJECT_RESULTS_TOOL_NAME,
  capability: {
    system: "vault",
    resourceType: "markdown_file",
    action: "create",
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
