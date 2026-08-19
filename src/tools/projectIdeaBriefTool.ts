import {
  createProjectIdeaBriefV1,
  deriveAcceptedResearchSeedFromProjectIdeaBriefV1,
  type ProjectIdeaAcceptedResearchSeedV1,
  type ProjectIdeaBriefV1,
  type ProjectIdeaEvidenceKindV1,
  type ProjectIdeaEvidenceV1,
  type ProjectIdeaRiskClassV1,
} from "@agentic-researcher/core-api";
import type { ToolDescriptor } from "../agent/actions";
import { sha256DiagramContent } from "../design/diagramArtifactStore";
import type { JsonSchemaObject } from "../model/types";
import type {
  AgentRuntimeCache,
  AgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types";
import { ToolExecutionError } from "./types";

export const CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME =
  "create_project_idea_brief" as const;

type GroundingReferenceV1 = {
  kind: ProjectIdeaEvidenceKindV1;
  reference: string;
};

export interface ProjectIdeaBriefToolOutputV1 {
  brief: ProjectIdeaBriefV1;
  promotion: {
    eligible: boolean;
    seed: ProjectIdeaAcceptedResearchSeedV1 | null;
  };
  durability: {
    scope: "run_local";
    restartRequiresBriefRecreation: true;
  };
}

/**
 * Native, independently callable ideation boundary. The provider supplies only
 * narrative choices. Evidence hashes/status, the canonical timestamp, and the
 * promotion seed are all resolved or minted by the host.
 *
 * The bridge is intentionally run-local for this bounded integration. A host
 * restart clears the cached brief/seed, so a joined publication must recreate
 * the brief from verified context before it can regain ideation binding.
 */
export function createProjectIdeaBriefTool(): AgentTool {
  return {
    name: CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME,
    description:
      "Create a fingerprinted project-idea brief from narrative options. The host alone resolves requested web, vault, or original-user-mission evidence already observed in this run, assigns hashes/status/time, and caches an exact promotion seed when the brief is grounded and one option is selected. Omit groundingReferences for independent unverified ideation.",
    parameters: PROJECT_IDEA_BRIEF_PARAMETERS,
    descriptor: PROJECT_IDEA_BRIEF_DESCRIPTOR,
    async execute(args, context) {
      return executeProjectIdeaBriefToolV1(args, context);
    },
  };
}

export async function executeProjectIdeaBriefToolV1(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ProjectIdeaBriefToolOutputV1> {
  assertExactKeys(
    args,
    [
      "ideaId",
      "title",
      "problem",
      "hypothesis",
      "options",
      "selectedOptionId",
      "proposedWork",
      "nonGoals",
      "constraints",
      "risks",
      "acceptanceCriteria",
      "riskClass",
      "limitations",
    ],
    ["groundingReferences"],
  );
  const groundingReferences = parseGroundingReferences(
    args.groundingReferences,
  );
  const evidence = await resolveGroundingEvidenceV1(
    groundingReferences,
    context,
  );
  const createdAt = canonicalNow(context.now);
  let brief: ProjectIdeaBriefV1;
  try {
    brief = createProjectIdeaBriefV1({
      ideaId: args.ideaId as string,
      title: args.title as string,
      problem: args.problem as string,
      hypothesis: args.hypothesis as string,
      options: args.options as never,
      selectedOptionId: args.selectedOptionId as string | null,
      proposedWork: args.proposedWork as string[],
      nonGoals: args.nonGoals as string[],
      constraints: args.constraints as string[],
      risks: args.risks as string[],
      acceptanceCriteria: args.acceptanceCriteria as never,
      evidenceStatus: evidence.length > 0 ? "grounded" : "unverified",
      evidence,
      riskClass: args.riskClass as ProjectIdeaRiskClassV1,
      limitations: args.limitations as string[],
      createdAt,
    });
  } catch (cause) {
    throw notApplied(
      "project_idea_brief_invalid",
      cause instanceof Error
        ? cause.message
        : "The project idea brief is invalid.",
    );
  }

  const seed =
    brief.evidenceStatus === "grounded" && brief.selectedOptionId !== null
      ? deriveAcceptedResearchSeedFromProjectIdeaBriefV1(brief)
      : null;
  if (context.runtimeCache) {
    context.runtimeCache.projectIdeaBrief = structuredClone(brief);
    context.runtimeCache.projectIdeaAcceptedResearchSeed = seed
      ? structuredClone(seed)
      : undefined;
  }
  return {
    brief,
    promotion: { eligible: seed !== null, seed },
    durability: {
      scope: "run_local",
      restartRequiresBriefRecreation: true,
    },
  };
}

async function resolveGroundingEvidenceV1(
  requested: readonly GroundingReferenceV1[],
  context: ToolExecutionContext,
): Promise<ProjectIdeaEvidenceV1[]> {
  if (requested.length === 0) return [];
  const candidates = await collectHostEvidenceCandidatesV1(context);
  const resolved: ProjectIdeaEvidenceV1[] = [];
  for (const request of requested) {
    const reference = normalizeRequestedReference(request);
    const match = candidates.find(
      (candidate) =>
        candidate.kind === request.kind &&
        normalizedEvidenceKey(candidate.kind, candidate.reference) ===
          normalizedEvidenceKey(request.kind, reference),
    );
    if (!match) {
      throw notApplied(
        "project_idea_grounding_unavailable",
        `No host-verified ${request.kind} evidence for ${reference} is available in this run. Read or fetch it first, or omit groundingReferences for an unverified brief.`,
      );
    }
    if (!resolved.some((item) => item.id === match.id)) {
      resolved.push(match);
    }
  }
  return [
    ...resolved.filter((item) => item.kind !== "web"),
    ...resolved
      .filter((item) => item.kind === "web")
      .sort((left, right) => left.reference.localeCompare(right.reference)),
  ];
}

async function collectHostEvidenceCandidatesV1(
  context: ToolExecutionContext,
): Promise<ProjectIdeaEvidenceV1[]> {
  const result: ProjectIdeaEvidenceV1[] = [];
  const cache = context.runtimeCache;
  if (cache) {
    const webResults = [
      ...(cache.trustedWebFetchResults?.values() ?? []),
      ...[...cache.toolResults.entries()]
        .filter(([key]) => key.startsWith("web_fetch:"))
        .map(([, value]) => value),
    ];
    for (const candidate of webResults) {
      const output = record(candidate.ok ? candidate.output : null);
      const reference = normalizeHttpUrl(output?.normalizedUrl ?? output?.url);
      const contentSha256 = sha(output?.contentHash);
      if (!reference || !contentSha256) continue;
      const contentHex = contentSha256.slice("sha256:".length);
      const urlHash =
        typeof output?.urlHash === "string" && /^[a-f0-9]{16}$/u.test(output.urlHash)
          ? output.urlHash
          : "";
      result.push({
        id: urlHash
          ? `evidence-${contentHex.slice(0, 48)}-${urlHash}`
          : `evidence-${contentHex}`,
        kind: "web",
        reference,
        contentSha256,
      });
    }
    for (const [key, candidate] of cache.toolResults) {
      if (!candidate.ok || !/^(?:read_current_file|read_file|read_markdown_files):/u.test(key)) {
        continue;
      }
      for (const observed of extractCompleteVaultReads(candidate)) {
        const contentSha256 = await sha256DiagramContent(observed.content);
        result.push({
          id: `vault-${contentSha256.slice("sha256:".length, 40)}`,
          kind: "vault",
          reference: observed.path,
          contentSha256,
        });
      }
    }
  }
  if (context.originalPrompt.trim()) {
    result.push({
      id: "user-original-mission",
      kind: "user",
      reference: "original_mission",
      contentSha256: await sha256DiagramContent(context.originalPrompt),
    });
  }
  const unique = new Map<string, ProjectIdeaEvidenceV1>();
  for (const item of result) {
    unique.set(`${item.kind}:${normalizedEvidenceKey(item.kind, item.reference)}`, item);
  }
  return [...unique.values()];
}

function extractCompleteVaultReads(
  result: ToolExecutionResult,
): Array<{ path: string; content: string }> {
  const output = record(result.output);
  if (!output) return [];
  if (Array.isArray(output.files)) {
    return output.files.flatMap((value) => {
      const file = record(value);
      return file && file.truncated !== true
        ? completeVaultRead(file.path, file.content)
        : [];
    });
  }
  if (output.truncated === true) return [];
  return completeVaultRead(output.path, output.content);
}

function completeVaultRead(path: unknown, content: unknown) {
  if (
    typeof path !== "string" ||
    typeof content !== "string" ||
    content.endsWith("\n\n[truncated]") ||
    !isSafeVaultMarkdownPath(path)
  ) {
    return [];
  }
  return [{ path, content }];
}

function parseGroundingReferences(value: unknown): GroundingReferenceV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw notApplied(
      "project_idea_brief_invalid",
      "groundingReferences must contain at most 50 entries.",
    );
  }
  return value.map((item, index) => {
    const entry = record(item);
    if (!entry || Object.keys(entry).sort().join("\0") !== "kind\0reference") {
      throw notApplied(
        "project_idea_brief_invalid",
        `Grounding reference ${index + 1} does not match its closed contract.`,
      );
    }
    if (!(["web", "vault", "user"] as const).includes(entry.kind as never)) {
      throw notApplied(
        "project_idea_brief_invalid",
        `Grounding reference ${index + 1} has an unsupported kind.`,
      );
    }
    if (typeof entry.reference !== "string" || !entry.reference.trim()) {
      throw notApplied(
        "project_idea_brief_invalid",
        `Grounding reference ${index + 1} must name a host-observed reference.`,
      );
    }
    return {
      kind: entry.kind as ProjectIdeaEvidenceKindV1,
      reference: entry.reference,
    };
  });
}

function normalizeRequestedReference(value: GroundingReferenceV1): string {
  if (value.kind === "web") {
    const normalized = normalizeHttpUrl(value.reference);
    if (!normalized) {
      throw notApplied(
        "project_idea_brief_invalid",
        "Web grounding references must be absolute HTTP(S) URLs without credentials.",
      );
    }
    return normalized;
  }
  if (value.kind === "vault" && !isSafeVaultMarkdownPath(value.reference)) {
    throw notApplied(
      "project_idea_brief_invalid",
      "Vault grounding references must be safe vault-relative Markdown paths.",
    );
  }
  if (value.kind === "user" && value.reference !== "original_mission") {
    throw notApplied(
      "project_idea_brief_invalid",
      "User grounding may reference only the host-owned original_mission input.",
    );
  }
  return value.reference;
}

function normalizedEvidenceKey(
  kind: ProjectIdeaEvidenceKindV1,
  reference: string,
): string {
  return kind === "web"
    ? normalizeHttpUrl(reference) ?? reference
    : kind === "vault"
      ? reference.toLowerCase()
      : reference;
}

function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value.trim());
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function isSafeVaultMarkdownPath(value: string): boolean {
  return (
    value.trim() === value &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    value.toLowerCase().endsWith(".md") &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  );
}

function sha(value: unknown): string | null {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value)
    ? value
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalNow(provider?: () => Date): string {
  const now = provider?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw notApplied(
      "project_idea_clock_invalid",
      "The host project-idea clock is invalid.",
    );
  }
  return now.toISOString();
}

function assertExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw notApplied(
      "project_idea_brief_invalid",
      "Project idea arguments do not match the closed native tool contract.",
    );
  }
}

function notApplied(code: string, message: string): ToolExecutionError {
  return new ToolExecutionError(code, message, { mutationState: "not_applied" });
}

const STRING: JsonSchemaObject = { type: "string" };
const STRING_LIST: JsonSchemaObject = {
  type: "array",
  items: STRING,
  maxItems: 20,
};
const PROJECT_IDEA_BRIEF_PARAMETERS: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "ideaId",
    "title",
    "problem",
    "hypothesis",
    "options",
    "selectedOptionId",
    "proposedWork",
    "nonGoals",
    "constraints",
    "risks",
    "acceptanceCriteria",
    "riskClass",
    "limitations",
  ],
  properties: {
    ideaId: STRING,
    title: STRING,
    problem: STRING,
    hypothesis: STRING,
    options: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "summary"],
        properties: { id: STRING, title: STRING, summary: STRING },
      },
    },
    selectedOptionId: { type: ["string", "null"] },
    proposedWork: { ...STRING_LIST, minItems: 1 },
    nonGoals: { ...STRING_LIST, minItems: 1 },
    constraints: STRING_LIST,
    risks: STRING_LIST,
    acceptanceCriteria: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text"],
        properties: { id: STRING, text: STRING },
      },
    },
    riskClass: { type: "string", enum: ["low", "medium", "high"] },
    limitations: STRING_LIST,
    groundingReferences: {
      type: "array",
      maxItems: 50,
      description:
        "Optional references already observed in this run. Supply references only; the host resolves their hashes and determines grounded/unverified status.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "reference"],
        properties: {
          kind: { type: "string", enum: ["web", "vault", "user"] },
          reference: STRING,
        },
      },
    },
  },
};

const PROJECT_IDEA_BRIEF_DESCRIPTOR: ToolDescriptor = {
  version: 1,
  name: CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME,
  capability: { system: "workspace", resourceType: "project_idea", action: "read" },
  effect: "read",
  risk: "low",
  approval: {
    allowPromptGrant: true,
    allowPersistentGrant: true,
    fallback: "none",
  },
  execution: {
    preparation: "none",
    cacheable: false,
    parallelSafe: false,
  },
  durability: {
    journal: false,
    receipt: false,
    readback: "none",
    reconciliation: "none",
  },
  allowedPrincipals: ["single_agent", "lead", "researcher"],
};
