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
import {
  ACCEPTANCE_CRITERION_ID_DESCRIPTION_V1,
  ACCEPTANCE_CRITERION_ID_PATTERN_V1,
} from "../integrations/linear/acceptanceCriterionIdV1";

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
    // The closing sentence used to read "Omit groundingReferences for
    // independent unverified ideation." -- which is true, and which walked the
    // caller into the one rule it cannot see: omitting grounding makes the
    // brief unverified, and an unverified brief requires a limitation. The
    // advice now carries the consequence with it, stated as an instruction
    // the caller can follow without knowing which status the host will assign.
    description:
      "Create a fingerprinted project-idea brief from narrative options. The host alone resolves requested web, vault, or original-user-mission evidence already observed in this run, assigns hashes/status/time, and caches an exact promotion seed when the brief is grounded and one option is selected. Omit groundingReferences for independent unverified ideation, and always list at least one limitation, which is accepted whether or not the brief ends up grounded. Ids (ideaId, options[].id, selectedOptionId) are slugs: no spaces.",
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

/**
 * Every free-text field is stored exactly as it arrives, so the validator
 * rejects any value whose trimmed form differs from the value itself, and
 * rejects credential-shaped text. Neither rule was written anywhere the model
 * could read it, so an indented bullet or a pasted token cost a whole tool
 * call to discover. It is repeated on each affected field instead of stated
 * once, because a model fills one property at a time and reads the description
 * attached to that property, not the schema as a whole.
 */
const CANONICAL_TEXT_RULE_V1 =
  "Send it exactly as it should be stored: no leading or trailing whitespace, " +
  "no NUL characters, and no credentials, API keys or tokens.";

/**
 * The logical-id shape `createProjectIdeaBriefV1` enforces on `ideaId`, on
 * every `options[].id`, and on `selectedOptionId`. All three were declared as
 * bare strings -- no pattern, no description, no example -- while the
 * validator rejected the first space. "Option A" and "Direction 1", the two
 * most natural things a model writes here, therefore failed a rule they had
 * never been shown, and a qualification cohort died on exactly that. It is the
 * same defect and the same cure as the acceptance-criterion id below: publish
 * the contract rather than only enforcing it.
 *
 * This is deliberately a second spelling of a rule owned by core-api, which is
 * how drift usually starts. The guard against that is behavioural, not a
 * comment: a test runs a corpus of candidate ids through the REAL validator
 * and requires this pattern to accept exactly what the validator accepts, so
 * changing either side alone fails loudly instead of quietly advertising a
 * contract nobody enforces.
 */
const LOGICAL_ID_PATTERN_V1 = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$";
const LOGICAL_ID_DESCRIPTION_V1 =
  "1-160 characters, starting with a letter or digit and otherwise containing " +
  'only letters, digits, ".", "_", ":" or "-". SPACES ARE REJECTED: write ' +
  '"option-a", never "Option A".';

function logicalIdField(purpose: string, example: string): JsonSchemaObject {
  return {
    type: "string",
    pattern: LOGICAL_ID_PATTERN_V1,
    description: `${purpose} ${LOGICAL_ID_DESCRIPTION_V1} Example: "${example}".`,
    examples: [example],
  };
}

/**
 * Length bounds exist on every free-text field in the validator and existed on
 * none of them in the schema. A model cannot ration a 4000-character problem
 * statement it was never told the size of.
 */
function boundedText(
  maximum: number,
  purpose: string,
  singleLine = false,
): JsonSchemaObject {
  return {
    type: "string",
    minLength: 1,
    maxLength: maximum,
    description: `${purpose} 1-${maximum} characters.${
      singleLine ? " One line: line breaks are rejected." : ""
    } ${CANONICAL_TEXT_RULE_V1}`,
  };
}

const NARRATIVE_ENTRY_V1 = boundedText(1_000, "One entry.");

const STRING_LIST: JsonSchemaObject = {
  type: "array",
  items: NARRATIVE_ENTRY_V1,
  maxItems: 20,
  uniqueItems: true,
};

/**
 * The one bound the caller genuinely cannot derive. The enforced minimum is 1
 * while the brief is unverified and 0 once it is grounded -- but which of the
 * two applies is decided by the HOST, after it resolves `groundingReferences`
 * against what this run actually observed. At the moment the arguments are
 * written the model cannot see that outcome, so publishing "0 or 1, depending"
 * would be advice it cannot act on, and publishing 0 invites precisely the
 * call that died: omit grounding, send `[]`, get rejected.
 *
 * The published minimum is therefore 1, the value accepted under BOTH
 * outcomes. It is stricter than the grounded rule and never wrong, and it
 * costs the caller one sentence it should be writing anyway.
 */
const LIMITATION_LIST: JsonSchemaObject = {
  type: "array",
  items: NARRATIVE_ENTRY_V1,
  minItems: 1,
  maxItems: 10,
  uniqueItems: true,
  description:
    "Known limitations of this idea. Supply at least 1 and at most 10 " +
    "distinct entries. Always send at least one: whether an empty list is " +
    "allowed depends on grounding the host resolves after this call, so an " +
    "empty list is a coin flip and one entry always passes.",
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
    ideaId: logicalIdField(
      "Stable id for this brief.",
      "idea-checkers-guidance",
    ),
    title: boundedText(200, "Short name for the idea.", true),
    problem: boundedText(4_000, "The problem this idea addresses, and its impact."),
    hypothesis: boundedText(4_000, "The hypothesis this idea would test."),
    options: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      description:
        "1-5 directions evaluated for this idea. Every id must be distinct.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "summary"],
        properties: {
          id: logicalIdField(
            "Id for this option, unique within options and the value selectedOptionId refers to.",
            "option-a",
          ),
          title: boundedText(200, "Short name for this option.", true),
          summary: boundedText(2_000, "What this option would do."),
        },
      },
    },
    selectedOptionId: {
      type: ["string", "null"],
      pattern: LOGICAL_ID_PATTERN_V1,
      description:
        "The chosen direction, copied character-for-character from one " +
        "options[].id, or null when no direction is selected yet. " +
        `${LOGICAL_ID_DESCRIPTION_V1} Example: "option-a".`,
      examples: ["option-a", null],
    },
    proposedWork: {
      ...STRING_LIST,
      minItems: 1,
      description:
        "1-20 distinct pieces of work this idea proposes. Entries must not repeat.",
    },
    nonGoals: {
      ...STRING_LIST,
      minItems: 1,
      description:
        "1-20 distinct things this idea deliberately will not do. Entries must not repeat.",
    },
    constraints: {
      ...STRING_LIST,
      description:
        "0-20 distinct constraints the work must respect. Entries must not repeat.",
    },
    risks: {
      ...STRING_LIST,
      description:
        "0-20 distinct risks this idea carries. Entries must not repeat.",
    },
    acceptanceCriteria: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      description:
        "1-20 acceptance criteria, each with a distinct id and its own text.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text"],
        // The id contract is PUBLISHED here, not merely enforced later. It was
        // previously a bare string with no pattern and no description, while
        // three validators rejected anything but `AC-<n>` -- so a real run
        // burned a tool call discovering by failure a rule the schema could
        // have stated. A contract the caller cannot see is not a contract.
        properties: {
          id: {
            type: "string",
            pattern: ACCEPTANCE_CRITERION_ID_PATTERN_V1,
            description: ACCEPTANCE_CRITERION_ID_DESCRIPTION_V1,
            examples: ["AC-1"],
          },
          text: boundedText(500, "What this criterion requires."),
        },
      },
    },
    riskClass: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "Overall risk class for the idea.",
    },
    limitations: LIMITATION_LIST,
    // The old description read naturally as "an array of URLs", and a caller
    // that believed it sent bare strings and was rejected for breaking a
    // closed contract it had been shown an ambiguous summary of. The shape is
    // now stated as objects, with the exact keys, a worked example, and the
    // reference spelling each kind requires.
    groundingReferences: {
      type: "array",
      maxItems: 50,
      description:
        "Optional. An ARRAY OF OBJECTS -- not URLs -- each with exactly the " +
        "keys kind and reference, naming a source this run already observed. " +
        'Example: [{"kind": "web", "reference": "https://example.com/a"}]. ' +
        "Supply references only; the host resolves their hashes and decides " +
        "grounded/unverified status. A reference this run did not observe is " +
        "rejected, so fetch or read the source first.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "reference"],
        properties: {
          kind: {
            type: "string",
            enum: ["web", "vault", "user"],
            description:
              'Which host record to resolve: "web" for a page fetched in this ' +
              'run, "vault" for a note read in this run, "user" for the ' +
              "original mission text.",
          },
          reference: {
            type: "string",
            minLength: 1,
            description:
              'For "web", the absolute http(s) URL exactly as fetched. For ' +
              '"vault", the vault-relative Markdown path exactly as read, ' +
              'ending in ".md". For "user", the literal "original_mission".',
            examples: [
              "https://example.com/a",
              "Research/topic.md",
              "original_mission",
            ],
          },
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
