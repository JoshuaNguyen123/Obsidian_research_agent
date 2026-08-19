import type { ToolExecutionContext } from "../../tools/types";
import {
  decideLinearProjectAssociationPolicy,
  hasPlainLinearIssueOnlyIntent,
  type LinearProjectAssociationCandidate,
  type LinearProjectAssociationDecision,
} from "./linearProjectAssociation";
import type { LinearToolClient } from "./LinearTools";
import { listAllLinearPages } from "./linearPagination";
import type { LinearBaseRecord, LinearRequestOptions } from "./types";

export interface ResolveLinearProjectAssociationInput {
  client: LinearToolClient;
  prompt: string;
  associationText: string;
  teamId: string;
  configuredProjectId?: string | null;
  lineageProjectIds?: readonly string[];
  context?: Pick<ToolExecutionContext, "abortSignal" | "deadlineAt">;
  reportProgress?: (message: string) => void;
}

export interface ResolveLinearProjectAssociationResult {
  projectId: string | null;
  decision: LinearProjectAssociationDecision;
  created: boolean;
}

/**
 * Resolve which Linear project should own new issues for a mission.
 * Plain issue intent returns null projectId. Otherwise find an associated
 * project or create one under the destination team.
 */
export async function resolveLinearProjectAssociation(
  input: ResolveLinearProjectAssociationInput,
): Promise<ResolveLinearProjectAssociationResult> {
  const teamId = input.teamId.trim();
  if (!teamId) {
    throw new Error("Linear project association requires a team id.");
  }

  if (hasPlainLinearIssueOnlyIntent(input.prompt)) {
    input.reportProgress?.(
      "Linear: filing a general team issue without creating a project.",
    );
    return {
      projectId: null,
      decision: { mode: "team_only", reason: "plain_issue_intent" },
      created: false,
    };
  }

  const requestOptions = toRequestOptions(input.context);
  const candidates = await listTeamProjects(
    input.client,
    teamId,
    requestOptions,
  );

  const decision = decideLinearProjectAssociationPolicy({
    prompt: input.prompt,
    associationText: input.associationText,
    configuredProjectId: input.configuredProjectId,
    lineageProjectIds: input.lineageProjectIds,
    candidates,
    teamId,
  });

  if (decision.mode === "team_only") {
    input.reportProgress?.(
      "Linear: filing a general team issue without creating a project.",
    );
    return { projectId: null, decision, created: false };
  }

  if (decision.mode === "use_existing") {
    input.reportProgress?.(
      `Linear: using associated project${
        decision.projectName ? ` "${decision.projectName}"` : ""
      }.`,
    );
    return {
      projectId: decision.projectId,
      decision,
      created: false,
    };
  }

  input.reportProgress?.(
    `Linear: no associated project found; creating "${decision.projectName}".`,
  );
  const created = await createTeamProject(
    input.client,
    teamId,
    decision.projectName,
    requestOptions,
  );
  return {
    projectId: created.id,
    decision,
    created: true,
  };
}

async function listTeamProjects(
  client: LinearToolClient,
  teamId: string,
  options?: LinearRequestOptions,
): Promise<LinearProjectAssociationCandidate[]> {
  // Paginate rather than trusting page one: `first` is server-clamped to 50
  // and team filtering happens client-side, so a workspace past 50 projects
  // used to spend its whole budget on unrelated rows, miss the existing
  // project, and create a duplicate — which the host then persisted as the
  // sticky queue default. Five pages covers 250 projects; beyond that the
  // sweep reports truncation. A capped search cannot prove that an associated
  // project is absent, so fail closed before the create policy can mutate the
  // provider or create a duplicate.
  const sweep = await listAllLinearPages(
    client,
    "projects.list",
    { first: 50, includeArchived: false },
    options,
    { maxPages: 5 },
  );
  if (sweep.truncated) {
    throw new Error(
      "Linear project association search exceeded the bounded 250-project sweep; project absence cannot be verified safely.",
    );
  }
  return sweep.items
    .filter((item) => item.resourceType === "project")
    .map((item) => ({
      id: item.id,
      name: String(item.name ?? item.title ?? "").trim() || item.id,
      teamIds: teamIdsFromRecord(item),
    }))
    .filter(
      (item) => item.teamIds.includes(teamId),
    );
}

async function createTeamProject(
  client: LinearToolClient,
  teamId: string,
  name: string,
  options?: LinearRequestOptions,
): Promise<{ id: string; name: string }> {
  const result = await client.execute(
    "projects.create",
    {
      input: {
        name,
        teamIds: [teamId],
      },
    },
    options,
  );

  const directId = extractId(result);
  if (directId) {
    return { id: directId, name };
  }

  // Some adapters return a mutation ack; read back via list match on name.
  const candidates = await listTeamProjects(client, teamId, options);
  const match = candidates.find(
    (item) => item.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `Linear project create did not return an id for "${name}".`,
    );
  }
  return { id: match.id, name: match.name };
}

function teamIdsFromRecord(record: LinearBaseRecord): string[] {
  const extended = record as LinearBaseRecord & {
    team?: { id?: unknown };
    teams?: Array<{ id?: unknown } | string>;
  };
  const values: unknown[] = [
    record.attributes?.teamId,
    record.attributes?.teamIds,
    record.attributes?.team,
    record.attributes?.teams,
    extended.team?.id,
    extended.teams,
  ];
  return [...new Set(values.flatMap((value) =>
    Array.isArray(value) ? value : [value],
  ).map((value) => {
    if (typeof value === "string") return value.trim();
    if (value && typeof value === "object") {
      const id = (value as { id?: unknown }).id;
      return typeof id === "string" ? id.trim() : "";
    }
    return "";
  }).filter(Boolean))];
}

function extractId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && record.id.trim()) {
    return record.id.trim();
  }
  const nested = record.project;
  if (nested && typeof nested === "object") {
    const project = nested as Record<string, unknown>;
    if (typeof project.id === "string" && project.id.trim()) {
      return project.id.trim();
    }
  }
  return null;
}

function toRequestOptions(
  context?: Pick<ToolExecutionContext, "abortSignal" | "deadlineAt">,
): LinearRequestOptions | undefined {
  if (!context) return undefined;
  return {
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
    ...(typeof context.deadlineAt === "number"
      ? { deadlineAt: context.deadlineAt }
      : {}),
  };
}
