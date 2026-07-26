import type { ToolExecutionContext } from "../../tools/types";
import {
  decideLinearProjectAssociationPolicy,
  hasPlainLinearIssueOnlyIntent,
  type LinearProjectAssociationCandidate,
  type LinearProjectAssociationDecision,
} from "./linearProjectAssociation";
import type { LinearToolClient } from "./LinearTools";
import type { LinearBaseRecord, LinearPage, LinearRequestOptions } from "./types";

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
  const output = await client.execute(
    "projects.list",
    { first: 50, includeArchived: false },
    options,
  );
  const items = isLinearPage(output) ? output.items : [];
  return items
    .filter((item) => item.resourceType === "project")
    .map((item) => ({
      id: item.id,
      name: String(item.name ?? item.title ?? "").trim() || item.id,
      teamIds: teamIdsFromRecord(item),
    }))
    .filter(
      (item) =>
        item.teamIds.length === 0 || item.teamIds.includes(teamId),
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
  const raw = record.attributes?.teams;
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value).trim()).filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim()) {
    return [raw.trim()];
  }
  return [];
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

function isLinearPage(value: unknown): value is LinearPage<LinearBaseRecord> {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as LinearPage<LinearBaseRecord>).items)
  );
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
