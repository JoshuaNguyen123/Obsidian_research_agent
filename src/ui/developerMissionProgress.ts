/**
 * Small, host-owned projection for the prompt-first Developer Mission UI.
 *
 * This is intentionally a view model, not lifecycle authority. Durable
 * MissionGraph nodes and verified receipts remain the source of truth; this
 * module only turns their redacted stage/status signals into six stable labels.
 */

import type {
  ProjectPhaseStatusV1,
  ProjectRunReportV1,
} from "../agent/projectRunReport";

export const DEVELOPER_MISSION_PHASES_V1 = Object.freeze([
  { id: "research", label: "Research" },
  { id: "linear_plan", label: "Linear plan" },
  { id: "implement", label: "Implement" },
  { id: "test", label: "Test" },
  { id: "github", label: "GitHub" },
  { id: "reflect", label: "Reflect" },
] as const);

export type DeveloperMissionPhaseIdV1 =
  (typeof DEVELOPER_MISSION_PHASES_V1)[number]["id"];

export type DeveloperMissionPhaseStatusV1 =
  | "pending"
  | "active"
  | "complete"
  | "blocked";

export interface DeveloperMissionPhaseViewV1 {
  id: DeveloperMissionPhaseIdV1;
  label: string;
  status: DeveloperMissionPhaseStatusV1;
}

export interface DeveloperMissionProgressViewV1 {
  version: 1;
  kind: "developer_mission_progress";
  phases: DeveloperMissionPhaseViewV1[];
}

export interface DeveloperMissionGraphNodeViewV1 {
  id: string;
  objective?: string | null;
  status: string;
}

export type DeveloperMissionArtifactKindV1 =
  | "results"
  | "linear"
  | "validation"
  | "commit"
  | "pull_request";

export interface DeveloperMissionCompletionArtifactV1 {
  kind: DeveloperMissionArtifactKindV1;
  label: string;
  /** Safe https provider link, when the provider returned one. */
  url?: string | null;
  /** Vault-relative note/notebook path, opened through the Obsidian host. */
  vaultPath?: string | null;
}

export interface DeveloperMissionCompletionViewV1 {
  version: 1;
  kind: "developer_mission_completion";
  status: "complete" | "paused" | "blocked";
  summary: string;
  artifacts: DeveloperMissionCompletionArtifactV1[];
  progress?: DeveloperMissionProgressViewV1 | null;
}

const ACTIVE_GRAPH_STATUSES = new Set([
  "ready",
  "running",
  "waiting_approval",
  "waiting_obsidian",
  "verifying",
]);

const COMPLETE_GRAPH_STATUSES = new Set(["complete", "completed", "verified"]);

/**
 * Creates a projection only for a multi-stage lifecycle. Older persisted
 * lifecycles remain readable as the exact stages they actually declared; the
 * view never invents a negated or historically absent proof requirement.
 */
export function createDeveloperMissionProgressV1(
  lifecycleStages: readonly string[],
): DeveloperMissionProgressViewV1 | null {
  const mapped = uniquePhaseIds(lifecycleStages.map(phaseForLifecycleStageV1));
  if (mapped.length <= 1) return null;

  return {
    version: 1,
    kind: "developer_mission_progress",
    phases: mapped.map((id) => ({
      id,
      label: labelForPhase(id),
      status: "pending",
    })),
  };
}

/** Retains observed states while adopting a newer lifecycle projection. */
export function mergeDeveloperMissionLifecycleV1(
  current: DeveloperMissionProgressViewV1 | null,
  lifecycleStages: readonly string[],
): DeveloperMissionProgressViewV1 | null {
  const next = createDeveloperMissionProgressV1(lifecycleStages);
  if (!next || !current) return next;
  const currentById = new Map(current.phases.map((phase) => [phase.id, phase]));
  return {
    ...next,
    phases: next.phases.map((phase) => ({
      ...phase,
      status: currentById.get(phase.id)?.status ?? phase.status,
    })),
  };
}

/** Projects canonical graph state without inventing completion evidence. */
export function applyDeveloperMissionGraphV1(
  current: DeveloperMissionProgressViewV1 | null,
  nodes: readonly DeveloperMissionGraphNodeViewV1[],
): DeveloperMissionProgressViewV1 | null {
  if (!current) return null;
  const next = cloneProgress(current);
  for (const node of nodes) {
    const phaseId = phaseForSignalV1(`${node.id} ${node.objective ?? ""}`);
    if (!phaseId || !next.phases.some((phase) => phase.id === phaseId)) continue;
    const normalizedStatus = node.status.trim().toLowerCase();
    if (COMPLETE_GRAPH_STATUSES.has(normalizedStatus)) {
      setPhaseStatus(next, phaseId, "complete");
    } else if (normalizedStatus === "blocked") {
      setPhaseStatus(next, phaseId, "blocked");
    } else if (ACTIVE_GRAPH_STATUSES.has(normalizedStatus)) {
      setPhaseStatus(next, phaseId, "active");
    }
  }
  return next;
}

/** Tool start is activity only; it never pays a phase's completion proof. */
export function applyDeveloperMissionToolStartV1(
  current: DeveloperMissionProgressViewV1 | null,
  toolName: string,
): DeveloperMissionProgressViewV1 | null {
  const phaseId = phaseForToolNameV1(toolName);
  if (!current || !phaseId) return current;
  const next = cloneProgress(current);
  setPhaseStatus(next, phaseId, "active");
  return next;
}

/** A host-emitted receipt is the minimum UI signal allowed to mark completion. */
export function applyDeveloperMissionReceiptV1(
  current: DeveloperMissionProgressViewV1 | null,
  toolName: string,
  _receiptText = "",
): DeveloperMissionProgressViewV1 | null {
  const phaseId = completionPhaseForReceiptToolV1(toolName);
  if (!current || !phaseId) return current;
  const next = cloneProgress(current);
  setPhaseStatus(next, phaseId, "complete");
  return next;
}

/**
 * Receipt-only compatibility is intentionally narrower than activity routing.
 * Compound MissionGraph completion and ProjectRunReport evidence remain the
 * primary truth; these terminal tools are the only standalone receipts whose
 * own contracts prove a whole phase. Intermediate reads, workspace creation,
 * one validation command, or repository creation can only mark activity.
 */
function completionPhaseForReceiptToolV1(
  toolName: string,
): DeveloperMissionPhaseIdV1 | null {
  switch (toolName.trim().toLowerCase()) {
    case "publish_research_to_linear":
    case "accept_research_artifact":
    case "write_accepted_research_artifact":
      return "research";
    case "publish_research_project_to_linear":
    case "linear_create_issue":
      return "linear_plan";
    case "code_workspace_create_file":
    case "code_workspace_write_expected":
    case "code_workspace_append":
    case "code_workspace_edit":
    case "code_workspace_patch":
    case "code_workspace_copy":
    case "code_workspace_move":
    case "code_workspace_restore":
    case "code_replace_text":
    case "code_write_file":
    case "workspace_edit":
    case "workspace_patch":
    case "code_diff_readback":
      return "implement";
    case "code_commit_verified":
      return "test";
    case "publish_verified_code_to_github":
    case "github_create_draft_pull_request":
    case "github_draft_pr_readback":
      return "github";
    case "write_project_results":
    case "append_jupyter_reflection":
      return "reflect";
    default:
      return null;
  }
}

export function phaseForLifecycleStageV1(
  stage: string,
): DeveloperMissionPhaseIdV1 | null {
  const normalized = stage.trim().toLowerCase();
  switch (normalized) {
    case "accepted_research":
      return "research";
    case "linear_hierarchy":
      return "linear_plan";
    case "code_execution":
    case "code_implementation":
      return "implement";
    case "code_validation":
    case "validation":
      return "test";
    case "private_github_publication":
    case "github_publication":
      return "github";
    case "reflection":
    case "results_reflection":
      return "reflect";
    case "reconciliation_cleanup":
      return null;
    default:
      return phaseForSignalV1(normalized);
  }
}

export function phaseForToolNameV1(
  toolName: string,
): DeveloperMissionPhaseIdV1 | null {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return null;
  if (/reflection|jupyter|project_run_report|results_report|write_results/u.test(normalized)) {
    return "reflect";
  }
  if (/validate|validation|\btest\b|run_code_block|sandbox_(?:run|execute)/u.test(normalized)) {
    return "test";
  }
  if (/github|git_push|pull_request|publish_(?:branch|repository)/u.test(normalized)) {
    return "github";
  }
  if (/linear/u.test(normalized)) return "linear_plan";
  if (/research|web_search|web_fetch|open_web_source|accepted_research/u.test(normalized)) {
    return "research";
  }
  if (/code_workspace|code_(?:create|edit|patch|commit|repair|execute)|workspace_(?:create|edit|patch)/u.test(normalized)) {
    return "implement";
  }
  return null;
}

export function phaseStatusLabelV1(status: DeveloperMissionPhaseStatusV1): string {
  switch (status) {
    case "active":
      return "In progress";
    case "complete":
      return "Complete";
    case "blocked":
      return "Blocked";
    case "pending":
    default:
      return "Pending";
  }
}

export function normalizeDeveloperMissionCompletionV1(
  input: DeveloperMissionCompletionViewV1,
): DeveloperMissionCompletionViewV1 {
  const seen = new Set<string>();
  const artifacts: DeveloperMissionCompletionArtifactV1[] = [];
  for (const artifact of input.artifacts) {
    const label = artifact.label.trim();
    if (!label) continue;
    const url = safeHttpsUrl(artifact.url);
    const vaultPath = safeVaultArtifactPath(artifact.vaultPath);
    const key = `${artifact.kind}|${url ?? ""}|${vaultPath ?? ""}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    artifacts.push({
      kind: artifact.kind,
      label,
      ...(url ? { url } : {}),
      ...(vaultPath ? { vaultPath } : {}),
    });
  }
  return {
    version: 1,
    kind: "developer_mission_completion",
    status: input.status,
    summary: input.summary.trim() || "The project run reached a terminal state.",
    artifacts,
    progress: input.progress ? cloneProgress(input.progress) : null,
  };
}

/**
 * Exact adapter for the durable host report. This keeps the reporter and Chat
 * on one truth source instead of asking the UI to rediscover provider state.
 */
export function developerMissionCompletionFromProjectRunReportV1(
  report: ProjectRunReportV1,
): DeveloperMissionCompletionViewV1 {
  const progress: DeveloperMissionProgressViewV1 = {
    version: 1,
    kind: "developer_mission_progress",
    phases: report.phases.map((phase) => ({
      id: phase.phase,
      label: labelForPhase(phase.phase),
      status: viewStatusFromReportStatus(phase.status),
    })),
  };
  const artifacts: DeveloperMissionCompletionArtifactV1[] = [
    {
      kind: "results",
      label: report.destination.kind === "jupyter" ? "Results notebook" : "Results",
      vaultPath: report.destination.path,
    },
  ];

  for (const event of report.evidence.filter(
    (candidate) => candidate.evidenceKind === "linear_hierarchy_readback",
  )) {
    artifacts.push({
      kind: "linear",
      label: event.resource.id || "Linear work",
      url: event.resource.url,
    });
  }
  const validations = report.evidence.filter((event) =>
    ["targeted_validation", "full_validation", "commit_readback"].includes(
      event.evidenceKind,
    ),
  );
  if (validations.length > 0) {
    artifacts.push({
      kind: "validation",
      label: `Validation evidence (${validations.length})`,
    });
  }
  const commit = findLastReportEvidence(
    report,
    "commit_readback",
  );
  if (commit) {
    const revision = commit.resource.revision ?? commit.resource.id;
    artifacts.push({
      kind: "commit",
      label: `Commit ${revision.slice(0, 8)}`,
      url: commit.resource.url,
    });
  }
  const pullRequest = findLastReportEvidence(
    report,
    "github_draft_pr_readback",
  );
  if (pullRequest) {
    artifacts.push({
      kind: "pull_request",
      label: `Draft pull request ${pullRequest.resource.id}`,
      url: pullRequest.resource.url,
    });
  }

  const verified = report.phases.filter((phase) => phase.status === "verified").length;
  const blocked = report.phases.some((phase) => phase.status === "blocked");
  return normalizeDeveloperMissionCompletionV1({
    version: 1,
    kind: "developer_mission_completion",
    status: report.complete ? "complete" : blocked ? "blocked" : "paused",
    summary: report.complete
      ? `All ${report.phases.length} project phases are verified.`
      : `${verified} of ${report.phases.length} project phases are verified.`,
    artifacts,
    progress,
  });
}

function phaseForSignalV1(signal: string): DeveloperMissionPhaseIdV1 | null {
  const normalized = signal.trim().toLowerCase();
  if (!normalized) return null;
  // Order matters: validation and reflection nodes often also contain "code"
  // or "publication" in their objective.
  if (/reflect|reflection|results?|jupyter|notebook|retrospective/u.test(normalized)) {
    return "reflect";
  }
  if (/code_validation|validate|validation|\btests?\b|verification suite/u.test(normalized)) {
    return "test";
  }
  if (/github|pull request|pull_request|git push|publication/u.test(normalized)) {
    return "github";
  }
  if (/linear|ticket|work item|hierarchy/u.test(normalized)) return "linear_plan";
  if (/accepted_research|research|technical design|high.level design|source/u.test(normalized)) {
    return "research";
  }
  if (/code_execution|code_implementation|implement|workspace|\bcode\b/u.test(normalized)) {
    return "implement";
  }
  return null;
}

function viewStatusFromReportStatus(
  status: ProjectPhaseStatusV1,
): DeveloperMissionPhaseStatusV1 {
  switch (status) {
    case "verified":
      return "complete";
    case "in_progress":
      return "active";
    case "blocked":
      return "blocked";
    case "pending":
    default:
      return "pending";
  }
}

function findLastReportEvidence(
  report: ProjectRunReportV1,
  evidenceKind: ProjectRunReportV1["evidence"][number]["evidenceKind"],
): ProjectRunReportV1["evidence"][number] | null {
  for (let index = report.evidence.length - 1; index >= 0; index -= 1) {
    const event = report.evidence[index];
    if (event?.evidenceKind === evidenceKind) return event;
  }
  return null;
}

function setPhaseStatus(
  progress: DeveloperMissionProgressViewV1,
  phaseId: DeveloperMissionPhaseIdV1,
  status: DeveloperMissionPhaseStatusV1,
): void {
  const phase = progress.phases.find((candidate) => candidate.id === phaseId);
  if (!phase || phase.status === "complete") return;
  if (status === "active") {
    for (const candidate of progress.phases) {
      if (candidate.id !== phaseId && candidate.status === "active") {
        candidate.status = "pending";
      }
    }
  }
  phase.status = status;
}

function uniquePhaseIds(
  phases: readonly (DeveloperMissionPhaseIdV1 | null)[],
): DeveloperMissionPhaseIdV1[] {
  const seen = new Set<DeveloperMissionPhaseIdV1>();
  const result: DeveloperMissionPhaseIdV1[] = [];
  for (const phase of phases) {
    if (!phase || seen.has(phase)) continue;
    seen.add(phase);
    result.push(phase);
  }
  return result;
}

function labelForPhase(id: DeveloperMissionPhaseIdV1): string {
  return DEVELOPER_MISSION_PHASES_V1.find((phase) => phase.id === id)?.label ?? id;
}

function cloneProgress(
  progress: DeveloperMissionProgressViewV1,
): DeveloperMissionProgressViewV1 {
  return {
    ...progress,
    phases: progress.phases.map((phase) => ({ ...phase })),
  };
}

function safeHttpsUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return /^https:\/\/[^\s]+$/iu.test(trimmed) ? trimmed : null;
}

function safeVaultArtifactPath(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    trimmed.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(trimmed) ||
    /(^|\/)\.\.(\/|$)/u.test(trimmed) ||
    /^[a-z]:/iu.test(trimmed) ||
    !/\.(?:md|ipynb)$/iu.test(trimmed)
  ) {
    return null;
  }
  return trimmed.replace(/\/+$/gu, "");
}
