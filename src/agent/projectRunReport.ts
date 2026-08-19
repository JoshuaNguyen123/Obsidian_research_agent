import {
  assertCanonicalContract,
  assertExactKeys,
  assertSecretFree,
  constantTimeFingerprintEqual,
  DurableLinearContractError,
  expectEnum,
  expectInteger,
  expectIsoTimestamp,
  expectOpaqueId,
  expectPlainRecord,
  expectSha256,
  expectString,
  fingerprintContract,
  parseHttpUrl,
  parseUniqueStrings,
  parseVaultMarkdownPath,
} from "../integrations/linear/LinearContractSupport";

export const PROJECT_STAGE_EVENT_SCHEMA_VERSION = 1 as const;
export const PROJECT_RUN_REPORT_SCHEMA_VERSION = 1 as const;

export const PROJECT_PHASES_V1 = [
  "research",
  "linear_plan",
  "implement",
  "test",
  "github",
  "reflect",
] as const;

export type ProjectPhaseV1 = (typeof PROJECT_PHASES_V1)[number];

export const PROJECT_PHASE_LABELS_V1: Readonly<Record<ProjectPhaseV1, string>> = {
  research: "Research",
  linear_plan: "Linear plan",
  implement: "Implement",
  test: "Test",
  github: "GitHub",
  reflect: "Reflect",
};

export const PROJECT_EVIDENCE_KINDS_V1 = [
  "research_artifact",
  "linear_hierarchy_readback",
  "workspace_mutation",
  "diff_readback",
  "targeted_validation",
  "full_validation",
  "commit_readback",
  "github_repository_readback",
  "github_draft_pr_readback",
  "reflection_writeback",
  "acceptance_criterion",
  "actionable_blocker",
] as const;

export type ProjectEvidenceKindV1 =
  (typeof PROJECT_EVIDENCE_KINDS_V1)[number];

export type ProjectEvidenceDispositionV1 = "verified" | "blocked";

export type ProjectEvidenceResourceSystemV1 =
  | "vault"
  | "linear"
  | "workspace"
  | "git"
  | "github";

export interface ProjectEvidenceResourceV1 {
  system: ProjectEvidenceResourceSystemV1;
  resourceType: string;
  id: string;
  url: string | null;
  path: string | null;
  revision: string | null;
}

export interface ProjectEventWorkUnitBindingV1 {
  workUnitId: string;
  acceptanceCriterionIds: string[];
}

export interface ProjectStageEventV1 {
  schemaVersion: typeof PROJECT_STAGE_EVENT_SCHEMA_VERSION;
  eventId: string;
  runId: string;
  phase: ProjectPhaseV1;
  evidenceKind: ProjectEvidenceKindV1;
  disposition: ProjectEvidenceDispositionV1;
  occurredAt: string;
  sourceReceiptId: string;
  evidenceFingerprint: string;
  resource: ProjectEvidenceResourceV1;
  workUnits: ProjectEventWorkUnitBindingV1[];
}

export type ProjectStageEventV1Unsigned = Omit<ProjectStageEventV1, "eventId">;

export type ProjectPhaseStatusV1 =
  | "pending"
  | "in_progress"
  | "blocked"
  | "verified";

export interface ProjectPhaseOutcomeV1 {
  phase: ProjectPhaseV1;
  label: string;
  status: ProjectPhaseStatusV1;
  startedAt: string | null;
  completedAt: string | null;
  evidenceEventIds: string[];
  blockerEventIds: string[];
}

export interface ProjectPhaseSnapshotV1 {
  runId: string;
  phases: ProjectPhaseOutcomeV1[];
  complete: boolean;
}

export type ProjectResultsDestinationKindV1 = "markdown" | "jupyter";

export interface ProjectResultsDestinationV1 {
  kind: ProjectResultsDestinationKindV1;
  path: string;
  source: "default" | "explicit";
}

export interface ProjectCodeExampleV1 {
  path: string;
  language: string;
  startLine: number | null;
  endLine: number | null;
  code: string;
  sourceReceiptId: string;
  sourceFingerprint: string;
}

export const PROJECT_WORK_UNIT_OUTCOME_STATUSES_V1 = [
  "paid",
  "unpaid",
  "blocked",
] as const;

export type ProjectWorkUnitOutcomeStatusV1 =
  (typeof PROJECT_WORK_UNIT_OUTCOME_STATUSES_V1)[number];

/**
 * Exact per-child outcome supplied by the host progress projector. Project-
 * level stage evidence must not manufacture these bindings: each referenced
 * evidence event must name this exact work unit.
 */
export interface ProjectWorkUnitOutcomeV1 {
  workUnitId: string;
  linearIssueIdentifier: string | null;
  status: ProjectWorkUnitOutcomeStatusV1;
  paidAcceptanceCriterionIds: string[];
  unpaidAcceptanceCriterionIds: string[];
  evidenceEventIds: string[];
  proofDebt: string[];
}

export interface ProjectRunReportV1 {
  schemaVersion: typeof PROJECT_RUN_REPORT_SCHEMA_VERSION;
  reportId: string;
  runId: string;
  projectName: string;
  generatedAt: string;
  destination: ProjectResultsDestinationV1;
  phases: ProjectPhaseOutcomeV1[];
  evidence: ProjectStageEventV1[];
  /** Optional for byte-for-byte compatibility with legacy phase-only reports. */
  workUnitOutcomes?: ProjectWorkUnitOutcomeV1[];
  limitations: string[];
  codeExamples: ProjectCodeExampleV1[];
  complete: boolean;
  reportFingerprint: string;
}

export type ProjectRunReportV1Unsigned = Omit<
  ProjectRunReportV1,
  "reportFingerprint"
>;

const PHASE_COMPLETION_REQUIREMENTS: Readonly<
  Record<ProjectPhaseV1, readonly (readonly ProjectEvidenceKindV1[])[]>
> = {
  research: [["research_artifact"]],
  linear_plan: [["linear_hierarchy_readback"]],
  // The implementation phase is paid by a verified workspace mutation. A
  // diff readback is preferred report evidence, while the Test phase's
  // verified commit contract independently binds the final diff.
  implement: [["workspace_mutation"], ["diff_readback"]],
  test: [["targeted_validation", "full_validation", "commit_readback"]],
  // A draft-PR readback already binds the repository and remote revision. A
  // repository readback alone remains useful for an independently requested
  // repository-creation mission, but cannot claim the full developer journey.
  github: [["github_draft_pr_readback"]],
  reflect: [["reflection_writeback"]],
};

const EXPECTED_PHASE_BY_EVIDENCE: Readonly<
  Partial<Record<ProjectEvidenceKindV1, ProjectPhaseV1>>
> = {
  research_artifact: "research",
  linear_hierarchy_readback: "linear_plan",
  workspace_mutation: "implement",
  diff_readback: "implement",
  targeted_validation: "test",
  full_validation: "test",
  commit_readback: "test",
  github_repository_readback: "github",
  github_draft_pr_readback: "github",
  reflection_writeback: "reflect",
};

export function createProjectStageEventV1(
  value: ProjectStageEventV1Unsigned,
): ProjectStageEventV1 {
  const unsigned = parseProjectStageEventUnsignedV1(value);
  return { ...unsigned, eventId: fingerprintContract(unsigned) };
}

export function parseProjectStageEventV1(value: unknown): ProjectStageEventV1 {
  const record = expectPlainRecord(value, "project stage event");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "eventId",
      "runId",
      "phase",
      "evidenceKind",
      "disposition",
      "occurredAt",
      "sourceReceiptId",
      "evidenceFingerprint",
      "resource",
      "workUnits",
    ],
    [],
    "project stage event",
  );
  const { eventId: rawEventId, ...rawUnsigned } = record;
  const unsigned = parseProjectStageEventUnsignedV1(rawUnsigned);
  assertCanonicalContract(rawUnsigned, unsigned, "Project stage event");
  const eventId = expectSha256(rawEventId, "project stage event id");
  const expected = fingerprintContract(unsigned);
  if (!constantTimeFingerprintEqual(eventId, expected)) {
    throw new DurableLinearContractError(
      "Project stage event id does not match its canonical payload.",
    );
  }
  return { ...unsigned, eventId };
}

export function reduceProjectStageEventsV1(input: {
  runId: string;
  events: readonly ProjectStageEventV1[];
}): ProjectPhaseSnapshotV1 {
  const runId = expectOpaqueId(input.runId, "project run id");
  const unique = new Map<string, ProjectStageEventV1>();
  for (const rawEvent of input.events) {
    const event = parseProjectStageEventV1(rawEvent);
    if (event.runId !== runId) {
      throw new DurableLinearContractError(
        "Project stage event belongs to a different run.",
      );
    }
    const existing = unique.get(event.eventId);
    if (existing) {
      continue;
    }
    unique.set(event.eventId, event);
  }
  const events = [...unique.values()].sort(compareProjectEvents);
  const phases = PROJECT_PHASES_V1.map((phase) => {
    const phaseEvents = events.filter((event) => event.phase === phase);
    const proofEvents = phaseEvents.filter(
      (event) => event.disposition === "verified",
    );
    const blockerEvents = phaseEvents.filter(
      (event) => event.disposition === "blocked",
    );
    const completed = completionSatisfied(phase, proofEvents);
    const latestProof = proofEvents.at(-1) ?? null;
    const latestBlocker = blockerEvents.at(-1) ?? null;
    const activeBlocker = Boolean(
      latestBlocker &&
        (!latestProof || compareProjectEvents(latestBlocker, latestProof) > 0),
    );
    const status: ProjectPhaseStatusV1 = activeBlocker
      ? "blocked"
      : completed
        ? "verified"
        : proofEvents.length > 0
          ? "in_progress"
          : "pending";
    let completionEvent: ProjectStageEventV1 | null = null;
    if (completed) {
      for (let index = 0; index < proofEvents.length; index += 1) {
        if (completionSatisfied(phase, proofEvents.slice(0, index + 1))) {
          completionEvent = proofEvents[index] ?? null;
          break;
        }
      }
    }
    return {
      phase,
      label: PROJECT_PHASE_LABELS_V1[phase],
      status,
      startedAt: phaseEvents[0]?.occurredAt ?? null,
      completedAt: status === "verified" ? completionEvent?.occurredAt ?? null : null,
      evidenceEventIds: proofEvents.map((event) => event.eventId),
      blockerEventIds: blockerEvents.map((event) => event.eventId),
    } satisfies ProjectPhaseOutcomeV1;
  });
  return {
    runId,
    phases,
    complete: phases.every((phase) => phase.status === "verified"),
  };
}

export function resolveProjectResultsDestinationV1(input: {
  projectName: string;
  runId: string;
  completedAt: string;
  explicitPath?: string | null;
}): ProjectResultsDestinationV1 {
  const projectName = expectString(input.projectName, "project name", 1, 160);
  const runId = expectOpaqueId(input.runId, "project run id");
  const completedAt = expectIsoTimestamp(input.completedAt, "project completion time");
  const explicit = input.explicitPath?.trim();
  if (explicit) {
    if (explicit.toLowerCase().endsWith(".md")) {
      return {
        kind: "markdown",
        path: parseVaultMarkdownPath(explicit, "project results path"),
        source: "explicit",
      };
    }
    if (explicit.toLowerCase().endsWith(".ipynb")) {
      return {
        kind: "jupyter",
        path: parseSafeVaultJupyterPath(explicit),
        source: "explicit",
      };
    }
    throw new DurableLinearContractError(
      "Explicit project results path must end in .md or .ipynb.",
    );
  }
  const date = completedAt.slice(0, 10);
  const projectSlug = slugify(projectName, "project");
  const runSlug = slugify(runId, "run");
  return {
    kind: "markdown",
    path: `Agent Work/Results/${projectSlug}/${date}-${runSlug}.md`,
    source: "default",
  };
}

export function createProjectRunReportV1(input: {
  runId: string;
  projectName: string;
  generatedAt: string;
  destination: ProjectResultsDestinationV1;
  events: readonly ProjectStageEventV1[];
  workUnitOutcomes?: readonly ProjectWorkUnitOutcomeV1[];
  limitations?: readonly string[];
  codeExamples?: readonly ProjectCodeExampleV1[];
}): ProjectRunReportV1 {
  const runId = expectOpaqueId(input.runId, "project run id");
  const projectName = expectString(input.projectName, "project name", 1, 160);
  const generatedAt = expectIsoTimestamp(input.generatedAt, "report generation time");
  const destination = parseProjectResultsDestinationV1(input.destination);
  const evidence = input.events
    .map(parseProjectStageEventV1)
    .sort(compareProjectEvents);
  const snapshot = reduceProjectStageEventsV1({ runId, events: evidence });
  const hasWorkUnitOutcomes = input.workUnitOutcomes !== undefined;
  const workUnitOutcomes = hasWorkUnitOutcomes
    ? parseProjectWorkUnitOutcomesV1(input.workUnitOutcomes, evidence)
    : undefined;
  const limitations = parseLimitations(input.limitations ?? []);
  const codeExamples = parseCodeExamples(input.codeExamples ?? []);
  const unsigned: ProjectRunReportV1Unsigned = {
    schemaVersion: PROJECT_RUN_REPORT_SCHEMA_VERSION,
    reportId: fingerprintContract({ runId, destination }),
    runId,
    projectName,
    generatedAt,
    destination,
    phases: snapshot.phases,
    evidence,
    ...(workUnitOutcomes === undefined ? {} : { workUnitOutcomes }),
    limitations,
    codeExamples,
    complete:
      snapshot.complete &&
      (workUnitOutcomes === undefined ||
        workUnitOutcomes.every((outcome) => outcome.status === "paid")),
  };
  return { ...unsigned, reportFingerprint: fingerprintContract(unsigned) };
}

export function parseProjectRunReportV1(value: unknown): ProjectRunReportV1 {
  const record = expectPlainRecord(value, "project run report");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "reportId",
      "runId",
      "projectName",
      "generatedAt",
      "destination",
      "phases",
      "evidence",
      "limitations",
      "codeExamples",
      "complete",
      "reportFingerprint",
    ],
    ["workUnitOutcomes"],
    "project run report",
  );
  if (record.schemaVersion !== PROJECT_RUN_REPORT_SCHEMA_VERSION) {
    throw new DurableLinearContractError("Unsupported project run report version.");
  }
  if (!Array.isArray(record.evidence)) {
    throw new DurableLinearContractError("Project run report evidence must be a list.");
  }
  const evidence = record.evidence.map(parseProjectStageEventV1);
  const hasWorkUnitOutcomes = Object.prototype.hasOwnProperty.call(
    record,
    "workUnitOutcomes",
  );
  const parsed = createProjectRunReportV1({
    runId: expectOpaqueId(record.runId, "project run id"),
    projectName: expectString(record.projectName, "project name", 1, 160),
    generatedAt: expectIsoTimestamp(record.generatedAt, "report generation time"),
    destination: parseProjectResultsDestinationV1(record.destination),
    events: evidence,
    ...(hasWorkUnitOutcomes
      ? {
          workUnitOutcomes: parseProjectWorkUnitOutcomesV1(
            record.workUnitOutcomes,
            evidence,
          ),
        }
      : {}),
    limitations: parseLimitations(record.limitations),
    codeExamples: parseCodeExamples(record.codeExamples),
  });
  const reportId = expectSha256(record.reportId, "project report id");
  if (!constantTimeFingerprintEqual(reportId, parsed.reportId)) {
    throw new DurableLinearContractError(
      "Project run report id does not match its run and destination.",
    );
  }
  if (record.complete !== parsed.complete) {
    throw new DurableLinearContractError(
      "Project run report completion must be derived from verified stage evidence and paid work-unit outcomes.",
    );
  }
  assertPhaseOutcomesEqual(record.phases, parsed.phases);
  const reportFingerprint = expectSha256(
    record.reportFingerprint,
    "project report fingerprint",
  );
  if (!constantTimeFingerprintEqual(reportFingerprint, parsed.reportFingerprint)) {
    throw new DurableLinearContractError(
      "Project run report fingerprint does not match its canonical payload.",
    );
  }
  assertCanonicalContract(record, parsed, "Project run report");
  return parsed;
}

export function renderProjectRunReportMarkdownV1(
  rawReport: ProjectRunReportV1,
): string {
  const report = parseProjectRunReportV1(rawReport);
  const lines = [
    `# ${escapeMarkdownText(report.projectName)} — Results`,
    "",
    `- Run: \`${report.runId}\``,
    `- Generated: ${report.generatedAt}`,
    `- Outcome: ${report.complete ? "Complete" : "Incomplete"}`,
    `- Report fingerprint: \`${report.reportFingerprint}\``,
    "",
    "## Phase outcomes",
    "",
  ];
  for (const phase of report.phases) {
    lines.push(
      `- ${phase.label}: **${formatStatus(phase.status)}**${
        phase.completedAt ? ` (${phase.completedAt})` : ""
      }`,
    );
  }

  lines.push("", "## Work-unit outcomes", "");
  if (report.workUnitOutcomes === undefined) {
    lines.push(
      "- Per-work-unit outcomes were not supplied; this legacy-compatible report is phase-level only.",
    );
  } else if (report.workUnitOutcomes.length === 0) {
    lines.push("- No child work units were supplied for this project-level run.");
  } else {
    for (const outcome of report.workUnitOutcomes) {
      const identity = outcome.linearIssueIdentifier
        ? `${outcome.linearIssueIdentifier} / ${outcome.workUnitId}`
        : outcome.workUnitId;
      lines.push(
        `### ${escapeMarkdownText(identity)}`,
        "",
        `- Outcome: **${formatStatus(outcome.status)}**`,
        `- Acceptance criteria paid: ${outcome.paidAcceptanceCriterionIds.length}`,
        `- Acceptance criteria unpaid: ${
          outcome.unpaidAcceptanceCriterionIds.length > 0
            ? outcome.unpaidAcceptanceCriterionIds
                .map((id) => `\`${id}\``)
                .join(", ")
            : "None"
        }`,
        `- Exact evidence events: ${
          outcome.evidenceEventIds.length > 0
            ? outcome.evidenceEventIds.length
            : "None"
        }`,
        "- Proof debt:",
      );
      if (outcome.proofDebt.length === 0) {
        lines.push("  - None");
      } else {
        for (const debt of outcome.proofDebt) {
          lines.push(`  - ${escapeMarkdownText(debt)}`);
        }
      }
      lines.push("");
    }
  }

  lines.push("", "## High-level phase reflection", "");
  for (const phase of report.phases) {
    const phaseEvidence = report.evidence.filter(
      (event) => event.phase === phase.phase,
    );
    lines.push(`### ${phase.label}`, "");
    lines.push(...renderPhaseReflectionV1(phase.phase, phase.status, phaseEvidence));
    lines.push("");
  }

  lines.push("", "## Scientific reflection", "");
  lines.push(...renderScientificReflectionV1(report));

  lines.push("", "## Evidence and readbacks", "");
  if (report.evidence.length === 0) {
    lines.push("- No verified evidence recorded.");
  } else {
    for (const event of report.evidence) {
      const resource = renderResourceReference(event.resource);
      lines.push(
        `- ${PROJECT_PHASE_LABELS_V1[event.phase]} — ${event.evidenceKind}: ` +
          `\`${event.sourceReceiptId}\` / \`${event.evidenceFingerprint}\`${resource}`,
      );
    }
  }

  const validation = report.evidence.filter((event) =>
    ["targeted_validation", "full_validation", "commit_readback"].includes(
      event.evidenceKind,
    ),
  );
  lines.push("", "## Validation", "");
  if (validation.length === 0) {
    lines.push("- No verified validation receipts recorded.");
  } else {
    for (const event of validation) {
      lines.push(
        `- ${event.evidenceKind}: **${event.disposition}** — ` +
          `\`${event.evidenceFingerprint}\`${renderResourceReference(event.resource)}`,
      );
    }
  }

  const commit = findLastEventMatching(
    report.evidence,
    (event) => event.evidenceKind === "commit_readback",
  );
  const pullRequest = findLastEventMatching(
    report.evidence,
    (event) => event.evidenceKind === "github_draft_pr_readback",
  );
  lines.push("", "## Publication", "");
  lines.push(
    commit
      ? `- Verified commit: \`${commit.resource.revision ?? commit.resource.id}\``
      : "- Verified commit: unavailable",
  );
  lines.push(
    pullRequest
      ? `- Draft pull request:${renderResourceReference(pullRequest.resource, true)}`
      : "- Draft pull request: unavailable",
  );

  lines.push("", "## Limitations", "");
  if (report.limitations.length === 0) {
    lines.push("- None recorded.");
  } else {
    for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  }

  lines.push("", "## Verified code examples", "");
  if (report.codeExamples.length === 0) {
    lines.push("- No verified code examples supplied.");
  } else {
    for (const example of report.codeExamples) {
      const range =
        example.startLine === null
          ? ""
          : `:${example.startLine}${
              example.endLine !== null && example.endLine !== example.startLine
                ? `-${example.endLine}`
                : ""
            }`;
      lines.push(
        `### \`${example.path}${range}\``,
        "",
        `Evidence: \`${example.sourceReceiptId}\` / \`${example.sourceFingerprint}\``,
        "",
        `\`\`\`${example.language}`,
        example.code,
        "```",
        "",
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderScientificReflectionV1(report: ProjectRunReportV1): string[] {
  const verifiedEvidence = report.evidence.filter(
    (event) => event.disposition === "verified",
  );
  const blockerEvidence = report.evidence.filter(
    (event) => event.disposition === "blocked",
  );
  const openPhases = report.phases.filter(
    (phase) => phase.status !== "verified",
  );
  const unpaidWorkUnits = (report.workUnitOutcomes ?? []).filter(
    (outcome) => outcome.status !== "paid",
  );
  const firstOpenPhase = openPhases[0];
  const draftPullRequest = findLastEventMatching(
    verifiedEvidence,
    (event) => event.evidenceKind === "github_draft_pr_readback",
  );
  const observedSystems = [...new Set(
    verifiedEvidence.map((event) => event.resource.system),
  )].sort();
  return [
    "- Question: Could the accepted technical direction become a traceable, tested, reviewable code change?",
    "- Method: Preserve one evidence chain across research, Linear planning, implementation, validation, GitHub publication, and reflection; advance a phase only from host-verified receipts or provider readbacks.",
    `- Observations: ${verifiedEvidence.length} verified evidence record${
      verifiedEvidence.length === 1 ? "" : "s"
    } were retained${
      observedSystems.length > 0
        ? ` across ${observedSystems.join(", ")}`
        : ""
    }; ${report.phases.filter((phase) => phase.status === "verified").length} of ${report.phases.length} phases are verified${
      report.workUnitOutcomes === undefined
        ? ""
        : `; ${report.workUnitOutcomes.length - unpaidWorkUnits.length} of ${report.workUnitOutcomes.length} supplied work-unit outcomes are paid`
    }.`,
    blockerEvidence.length > 0
      ? `- Deviations and surprises: ${blockerEvidence.length} host-verified blocker${
          blockerEvidence.length === 1 ? " was" : "s were"
        } recorded. The evidence appendix identifies where the expected path diverged.`
      : "- Deviations and surprises: No host-verified blocker is recorded. This means the durable evidence chain contains no blocker; it does not claim that every attempt was frictionless.",
    report.complete
      ? "- Conclusion: The six-phase delivery hypothesis is supported by the recorded evidence. The result is reviewable, but a draft pull request is not proof of merge, deployment, or production impact."
      : unpaidWorkUnits.length > 0
        ? `- Conclusion: All project phases may be verified, but the delivery hypothesis is not complete because ${unpaidWorkUnits.length} supplied work-unit outcome${
            unpaidWorkUnits.length === 1 ? " remains" : "s remain"
          } unpaid or blocked.`
        : `- Conclusion: The delivery hypothesis is not fully supported yet; ${
            openPhases.map((phase) => phase.label).join(", ") || "one or more phases"
          } remain open.`,
    report.complete && draftPullRequest
      ? "- Next experiment: Complete human review, then separately verify merge, deployment, and observed production behavior before treating the change as product learning."
      : unpaidWorkUnits.length > 0
        ? `- Next experiment: Pay the exact proof debt for work unit ${
            unpaidWorkUnits[0]?.linearIssueIdentifier ??
            unpaidWorkUnits[0]?.workUnitId ??
            "with the earliest unpaid outcome"
          }, then regenerate a new immutable Results artifact rather than overwriting this record.`
        : `- Next experiment: Resume at ${
            firstOpenPhase?.label ?? "the first unverified phase"
          }, collect its missing receipt or readback, and regenerate a new immutable Results artifact rather than overwriting this record.`,
  ];
}

function renderPhaseReflectionV1(
  phase: ProjectPhaseV1,
  status: ProjectPhaseOutcomeV1["status"],
  evidence: readonly ProjectStageEventV1[],
): string[] {
  if (status === "pending") {
    return ["- No verified phase outcome is available yet."];
  }
  if (status === "blocked") {
    return [
      "- The phase is blocked by host-verified evidence; inspect the evidence appendix before continuing.",
    ];
  }

  const verified = evidence.filter((event) => event.disposition === "verified");
  switch (phase) {
    case "research": {
      const artifact = findLastEventMatching(
        verified,
        (event) => event.evidenceKind === "research_artifact",
      );
      return artifact
        ? [
            `- The research and high-level design were accepted from ${renderResourceReference(
              artifact.resource,
              true,
            ).replace(/^\s+—\s+/u, "")}.`,
          ]
        : ["- Research completion is verified by the recorded host evidence."];
    }
    case "linear_plan": {
      const hierarchy = findLastEventMatching(
        verified,
        (event) => event.evidenceKind === "linear_hierarchy_readback",
      );
      const workUnitCount = new Set(
        verified.flatMap((event) => event.workUnits.map((unit) => unit.workUnitId)),
      ).size;
      return hierarchy
        ? [
            `- Linear readback verified the project plan${
              workUnitCount > 0
                ? ` and ${workUnitCount} bound unit${workUnitCount === 1 ? "" : "s"} of work`
                : ""
            }${renderResourceReference(hierarchy.resource, true)}.`,
          ]
        : ["- Linear planning completion is verified by the recorded host evidence."];
    }
    case "implement": {
      const diff = findLastEventMatching(
        verified,
        (event) => event.evidenceKind === "diff_readback",
      );
      const mutationCount = verified.filter(
        (event) => event.evidenceKind === "workspace_mutation",
      ).length;
      return [
        `- Implementation is backed by ${mutationCount} verified workspace mutation${
          mutationCount === 1 ? "" : "s"
        }${
          diff
            ? ` and an exact diff readback \`${diff.resource.revision ?? diff.evidenceFingerprint}\``
            : ""
        }.`,
      ];
    }
    case "test": {
      const kinds = new Set(verified.map((event) => event.evidenceKind));
      const commit = findLastEventMatching(
        verified,
        (event) => event.evidenceKind === "commit_readback",
      );
      return [
        `- ${kinds.has("targeted_validation") ? "Targeted validation passed" : "Targeted validation is not recorded"}; ${
          kinds.has("full_validation")
            ? "fresh full validation passed"
            : "fresh full validation is not recorded"
        }${
          commit
            ? `; the verified result is bound to commit \`${commit.resource.revision ?? commit.resource.id}\``
            : ""
        }.`,
      ];
    }
    case "github": {
      const pullRequest = findLastEventMatching(
        verified,
        (event) => event.evidenceKind === "github_draft_pr_readback",
      );
      return pullRequest
        ? [
            `- GitHub publication was read back as a draft pull request${renderResourceReference(
              pullRequest.resource,
              true,
            )}.`,
          ]
        : ["- GitHub publication is verified by the recorded provider readback."];
    }
    case "reflect": {
      const writeback = findLastEventMatching(
        verified,
        (event) => event.evidenceKind === "reflection_writeback",
      );
      return writeback
        ? [
            `- This report closes the run with a deterministic reflection bound to ${renderResourceReference(
              writeback.resource,
              true,
            ).replace(/^\s+—\s+/u, "")}.`,
          ]
        : ["- Reflection completion is verified by the recorded host evidence."];
    }
  }
}

function parseProjectStageEventUnsignedV1(
  value: unknown,
): ProjectStageEventV1Unsigned {
  const record = expectPlainRecord(value, "project stage event");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "runId",
      "phase",
      "evidenceKind",
      "disposition",
      "occurredAt",
      "sourceReceiptId",
      "evidenceFingerprint",
      "resource",
      "workUnits",
    ],
    [],
    "project stage event",
  );
  if (record.schemaVersion !== PROJECT_STAGE_EVENT_SCHEMA_VERSION) {
    throw new DurableLinearContractError("Unsupported project stage event version.");
  }
  const phase = expectEnum(record.phase, "project phase", PROJECT_PHASES_V1);
  const evidenceKind = expectEnum(
    record.evidenceKind,
    "project evidence kind",
    PROJECT_EVIDENCE_KINDS_V1,
  );
  const disposition = expectEnum(
    record.disposition,
    "project evidence disposition",
    ["verified", "blocked"] as const,
  );
  if ((evidenceKind === "actionable_blocker") !== (disposition === "blocked")) {
    throw new DurableLinearContractError(
      "Only actionable blocker evidence may use the blocked disposition.",
    );
  }
  const expectedPhase = EXPECTED_PHASE_BY_EVIDENCE[evidenceKind];
  if (expectedPhase && phase !== expectedPhase) {
    throw new DurableLinearContractError(
      `${evidenceKind} evidence belongs to the ${expectedPhase} phase.`,
    );
  }
  if (!Array.isArray(record.workUnits)) {
    throw new DurableLinearContractError("Project event work units must be a list.");
  }
  const workUnits = record.workUnits.map(parseEventWorkUnitBinding);
  const workUnitIds = workUnits.map((item) => item.workUnitId);
  if (new Set(workUnitIds).size !== workUnitIds.length) {
    throw new DurableLinearContractError(
      "Project event work units must not contain duplicates.",
    );
  }
  workUnits.sort((left, right) => left.workUnitId.localeCompare(right.workUnitId));
  return {
    schemaVersion: PROJECT_STAGE_EVENT_SCHEMA_VERSION,
    runId: expectOpaqueId(record.runId, "project run id"),
    phase,
    evidenceKind,
    disposition,
    occurredAt: expectIsoTimestamp(record.occurredAt, "project event time"),
    sourceReceiptId: expectOpaqueId(record.sourceReceiptId, "source receipt id"),
    evidenceFingerprint: expectSha256(
      record.evidenceFingerprint,
      "project evidence fingerprint",
    ),
    resource: parseEvidenceResource(record.resource),
    workUnits,
  };
}

function parseEvidenceResource(value: unknown): ProjectEvidenceResourceV1 {
  const record = expectPlainRecord(value, "project evidence resource");
  assertExactKeys(
    record,
    ["system", "resourceType", "id", "url", "path", "revision"],
    [],
    "project evidence resource",
  );
  const system = expectEnum(
    record.system,
    "project evidence resource system",
    ["vault", "linear", "workspace", "git", "github"] as const,
  );
  const path = parseNullableString(record.path, "project evidence resource path", 500);
  if (path && (path.startsWith("/") || path.includes("\\") || /(^|\/)\.\.?(\/|$)/u.test(path))) {
    throw new DurableLinearContractError(
      "Project evidence resource path must be relative and traversal-free.",
    );
  }
  const url = record.url === null ? null : parseHttpUrl(record.url, "project evidence resource URL");
  return {
    system,
    resourceType: expectOpaqueId(record.resourceType, "project evidence resource type"),
    id: expectString(record.id, "project evidence resource id", 1, 500),
    url,
    path,
    revision: parseNullableString(record.revision, "project evidence resource revision", 240),
  };
}

function parseEventWorkUnitBinding(value: unknown): ProjectEventWorkUnitBindingV1 {
  const record = expectPlainRecord(value, "project event work-unit binding");
  assertExactKeys(
    record,
    ["workUnitId", "acceptanceCriterionIds"],
    [],
    "project event work-unit binding",
  );
  return {
    workUnitId: expectOpaqueId(record.workUnitId, "project work-unit id"),
    acceptanceCriterionIds: parseUniqueStrings(
      record.acceptanceCriterionIds,
      "acceptance criterion id",
      0,
      100,
      160,
      (entry, label) => expectOpaqueId(entry, label),
    ).sort(),
  };
}

function completionSatisfied(
  phase: ProjectPhaseV1,
  proofEvents: readonly ProjectStageEventV1[],
): boolean {
  const kinds = new Set(proofEvents.map((event) => event.evidenceKind));
  return PHASE_COMPLETION_REQUIREMENTS[phase].some((requirement) =>
    requirement.every((kind) => kinds.has(kind)),
  );
}

function compareProjectEvents(
  left: ProjectStageEventV1,
  right: ProjectStageEventV1,
): number {
  return (
    left.occurredAt.localeCompare(right.occurredAt) ||
    left.eventId.localeCompare(right.eventId)
  );
}

function findLastEventMatching(
  events: readonly ProjectStageEventV1[],
  predicate: (event: ProjectStageEventV1) => boolean,
): ProjectStageEventV1 | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && predicate(event)) return event;
  }
  return null;
}

function parseProjectResultsDestinationV1(
  value: unknown,
): ProjectResultsDestinationV1 {
  const record = expectPlainRecord(value, "project results destination");
  assertExactKeys(record, ["kind", "path", "source"], [], "project results destination");
  const kind = expectEnum(
    record.kind,
    "project results destination kind",
    ["markdown", "jupyter"] as const,
  );
  const source = expectEnum(
    record.source,
    "project results destination source",
    ["default", "explicit"] as const,
  );
  const path =
    kind === "markdown"
      ? parseVaultMarkdownPath(record.path, "project results path")
      : parseSafeVaultJupyterPath(record.path);
  return { kind, path, source };
}

function parseSafeVaultJupyterPath(value: unknown): string {
  const path = expectString(value, "project results notebook path", 1, 500);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /(^|\/)\.\.?(\/|$)/u.test(path) ||
    /^[A-Za-z]:/u.test(path) ||
    !path.toLowerCase().endsWith(".ipynb") ||
    /^(?:\.obsidian|\.agent-backups)(?:\/|$)/iu.test(path)
  ) {
    throw new DurableLinearContractError(
      "Project results notebook path must be a safe vault-relative .ipynb path.",
    );
  }
  return path;
}

function parseProjectWorkUnitOutcomesV1(
  value: unknown,
  evidence: readonly ProjectStageEventV1[],
): ProjectWorkUnitOutcomeV1[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new DurableLinearContractError(
      "Project work-unit outcomes must be a list of no more than 100 entries.",
    );
  }
  const eventById = new Map(evidence.map((event) => [event.eventId, event]));
  const outcomes = value.map((entry, index) => {
    const label = `project work-unit outcome ${index + 1}`;
    const record = expectPlainRecord(entry, label);
    assertExactKeys(
      record,
      [
        "workUnitId",
        "linearIssueIdentifier",
        "status",
        "paidAcceptanceCriterionIds",
        "unpaidAcceptanceCriterionIds",
        "evidenceEventIds",
        "proofDebt",
      ],
      [],
      label,
    );
    const workUnitId = expectOpaqueId(record.workUnitId, `${label} id`);
    const linearIssueIdentifier =
      record.linearIssueIdentifier === null
        ? null
        : parseLinearIssueIdentifierV1(
            record.linearIssueIdentifier,
            `${label} Linear issue identifier`,
          );
    const status = expectEnum(
      record.status,
      `${label} status`,
      PROJECT_WORK_UNIT_OUTCOME_STATUSES_V1,
    );
    const criterion = (raw: unknown, criterionLabel: string) =>
      parseUniqueStrings(
        raw,
        criterionLabel,
        0,
        100,
        160,
        (item, itemLabel) => expectOpaqueId(item, itemLabel),
      ).sort();
    const paidAcceptanceCriterionIds = criterion(
      record.paidAcceptanceCriterionIds,
      `${label} paid acceptance criterion`,
    );
    const unpaidAcceptanceCriterionIds = criterion(
      record.unpaidAcceptanceCriterionIds,
      `${label} unpaid acceptance criterion`,
    );
    if (
      paidAcceptanceCriterionIds.some((id) =>
        unpaidAcceptanceCriterionIds.includes(id),
      )
    ) {
      throw new DurableLinearContractError(
        `${label} cannot mark one acceptance criterion both paid and unpaid.`,
      );
    }
    const evidenceEventIds = parseUniqueStrings(
      record.evidenceEventIds,
      `${label} evidence event id`,
      0,
      200,
      72,
      (item, itemLabel) => expectSha256(item, itemLabel),
    ).sort();
    const proofDebt = parseUniqueStrings(
      record.proofDebt,
      `${label} proof debt`,
      0,
      100,
      300,
      (item, itemLabel) =>
        expectString(item, itemLabel, 1, 300, { secretFree: true }),
    ).sort();
    const hasUnpaidProof =
      unpaidAcceptanceCriterionIds.length > 0 || proofDebt.length > 0;
    if (status === "paid" && hasUnpaidProof) {
      throw new DurableLinearContractError(
        `${label} cannot be paid while acceptance or proof debt remains.`,
      );
    }
    if (status !== "paid" && !hasUnpaidProof) {
      throw new DurableLinearContractError(
        `${label} must identify the proof debt behind its ${status} status.`,
      );
    }
    if (status === "blocked" && proofDebt.length === 0) {
      throw new DurableLinearContractError(
        `${label} blocked status requires explicit proof debt.`,
      );
    }

    const referencedEvents = evidenceEventIds.map((eventId) => {
      const event = eventById.get(eventId);
      if (!event) {
        throw new DurableLinearContractError(
          `${label} references evidence outside this report.`,
        );
      }
      if (!event.workUnits.some((unit) => unit.workUnitId === workUnitId)) {
        throw new DurableLinearContractError(
          `${label} references project-level or differently bound evidence.`,
        );
      }
      return event;
    });
    if (status === "paid" && referencedEvents.length === 0) {
      throw new DurableLinearContractError(
        `${label} paid status requires exact work-unit evidence.`,
      );
    }
    if (
      status === "blocked" &&
      !referencedEvents.some(
        (event) =>
          event.disposition === "blocked" &&
          event.evidenceKind === "actionable_blocker",
      )
    ) {
      throw new DurableLinearContractError(
        `${label} blocked status requires an exact work-unit blocker event.`,
      );
    }
    const observedAcceptanceCriteria = [
      ...new Set(
        referencedEvents
          .filter((event) => event.evidenceKind === "acceptance_criterion")
          .flatMap((event) =>
            event.workUnits
              .filter((unit) => unit.workUnitId === workUnitId)
              .flatMap((unit) => unit.acceptanceCriterionIds),
          ),
      ),
    ].sort();
    if (
      paidAcceptanceCriterionIds.some(
        (id) => !observedAcceptanceCriteria.includes(id),
      )
    ) {
      throw new DurableLinearContractError(
        `${label} marks an acceptance criterion paid without exact evidence.`,
      );
    }
    if (
      observedAcceptanceCriteria.some(
        (id) => !paidAcceptanceCriterionIds.includes(id),
      )
    ) {
      throw new DurableLinearContractError(
        `${label} omits acceptance evidence from its paid criteria.`,
      );
    }

    return {
      workUnitId,
      linearIssueIdentifier,
      status,
      paidAcceptanceCriterionIds,
      unpaidAcceptanceCriterionIds,
      evidenceEventIds,
      proofDebt,
    } satisfies ProjectWorkUnitOutcomeV1;
  });
  const ids = outcomes.map((outcome) => outcome.workUnitId);
  if (new Set(ids).size !== ids.length) {
    throw new DurableLinearContractError(
      "Project work-unit outcomes must not contain duplicate work-unit ids.",
    );
  }
  return outcomes.sort((left, right) =>
    left.workUnitId.localeCompare(right.workUnitId),
  );
}

function parseLinearIssueIdentifierV1(value: unknown, label: string): string {
  const identifier = expectString(value, label, 3, 80, { secretFree: true });
  if (!/^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]{0,9}$/u.test(identifier)) {
    throw new DurableLinearContractError(
      `${label} must be an uppercase team key and issue number.`,
    );
  }
  return identifier;
}

function parseLimitations(value: unknown): string[] {
  return parseUniqueStrings(value, "project limitation", 0, 100, 500);
}

function parseCodeExamples(value: unknown): ProjectCodeExampleV1[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new DurableLinearContractError(
      "Project code examples must be a list of no more than 50 entries.",
    );
  }
  return value.map((entry, index) => parseCodeExample(entry, index));
}

function parseCodeExample(value: unknown, index: number): ProjectCodeExampleV1 {
  const label = `project code example ${index + 1}`;
  const record = expectPlainRecord(value, label);
  assertExactKeys(
    record,
    [
      "path",
      "language",
      "startLine",
      "endLine",
      "code",
      "sourceReceiptId",
      "sourceFingerprint",
    ],
    [],
    label,
  );
  const path = expectString(record.path, `${label} path`, 1, 500);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /(^|\/)\.\.?(\/|$)/u.test(path) ||
    /^[A-Za-z]:/u.test(path)
  ) {
    throw new DurableLinearContractError(`${label} path must be workspace-relative.`);
  }
  const startLine = parseNullableLine(record.startLine, `${label} start line`);
  const endLine = parseNullableLine(record.endLine, `${label} end line`);
  if ((startLine === null) !== (endLine === null) || (startLine && endLine && endLine < startLine)) {
    throw new DurableLinearContractError(`${label} line range is invalid.`);
  }
  if (typeof record.code !== "string" || !record.code.trim() || record.code.length > 20_000) {
    throw new DurableLinearContractError(`${label} code must contain 1-20000 characters.`);
  }
  if (/\u0000/u.test(record.code)) {
    throw new DurableLinearContractError(`${label} code contains unsupported control characters.`);
  }
  assertSecretFree(record.code, `${label} code`);
  return {
    path,
    language: expectOpaqueId(record.language, `${label} language`, 40),
    startLine,
    endLine,
    code: record.code,
    sourceReceiptId: expectOpaqueId(record.sourceReceiptId, `${label} source receipt id`),
    sourceFingerprint: expectSha256(
      record.sourceFingerprint,
      `${label} source fingerprint`,
    ),
  };
}

function parseNullableLine(value: unknown, label: string): number | null {
  return value === null ? null : expectInteger(value, label, 1, 10_000_000);
}

function parseNullableString(
  value: unknown,
  label: string,
  maximumLength: number,
): string | null {
  return value === null
    ? null
    : expectString(value, label, 1, maximumLength, { secretFree: true });
}

function assertPhaseOutcomesEqual(
  raw: unknown,
  expected: readonly ProjectPhaseOutcomeV1[],
): void {
  if (!Array.isArray(raw)) {
    throw new DurableLinearContractError("Project report phases must be a list.");
  }
  assertCanonicalContract(raw, expected, "Project report phases");
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-+$/u, "");
  return slug || fallback;
}

function formatStatus(
  status: ProjectPhaseStatusV1 | ProjectWorkUnitOutcomeStatusV1,
): string {
  return status.replace(/_/gu, " ").replace(/^./u, (value) => value.toUpperCase());
}

function renderResourceReference(
  resource: ProjectEvidenceResourceV1,
  leadingSpace = false,
): string {
  const prefix = leadingSpace ? " " : " — ";
  if (resource.url) {
    return `${prefix}[${escapeMarkdownText(resource.id)}](${resource.url})`;
  }
  if (resource.path) return `${prefix}\`${resource.path}\``;
  if (resource.revision) return `${prefix}\`${resource.revision}\``;
  return `${prefix}\`${resource.id}\``;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\[\]*_`]/gu, "\\$&");
}
