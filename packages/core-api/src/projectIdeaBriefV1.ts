import { portableSha256Text } from "./portableSha256";

export const PROJECT_IDEA_BRIEF_VERSION_V1 = 1 as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SECRET_VALUE =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*\S+)/iu;

export type ProjectIdeaEvidenceKindV1 = "web" | "vault" | "user";
export type ProjectIdeaEvidenceStatusV1 = "grounded" | "unverified";
export type ProjectIdeaRiskClassV1 = "low" | "medium" | "high";

export interface ProjectIdeaEvidenceV1 {
  id: string;
  kind: ProjectIdeaEvidenceKindV1;
  reference: string;
  contentSha256: string;
}

export interface ProjectIdeaOptionV1 {
  id: string;
  title: string;
  summary: string;
}

export interface ProjectIdeaAcceptanceCriterionV1 {
  id: string;
  text: string;
}

/**
 * A provider-neutral, independently callable project-ideation artifact.
 *
 * `unverified` briefs are deliberately valid so ideation can run without web,
 * vault, Linear, code, or GitHub access. They cannot be promoted through
 * `deriveAcceptedResearchSeedFromProjectIdeaBriefV1`; only an exact grounded
 * brief with a selected option can cross that boundary.
 */
export interface ProjectIdeaBriefV1 {
  version: typeof PROJECT_IDEA_BRIEF_VERSION_V1;
  kind: "project_idea_brief";
  ideaId: string;
  title: string;
  problem: string;
  hypothesis: string;
  options: ProjectIdeaOptionV1[];
  selectedOptionId: string | null;
  proposedWork: string[];
  nonGoals: string[];
  constraints: string[];
  risks: string[];
  acceptanceCriteria: ProjectIdeaAcceptanceCriterionV1[];
  evidenceStatus: ProjectIdeaEvidenceStatusV1;
  evidence: ProjectIdeaEvidenceV1[];
  riskClass: ProjectIdeaRiskClassV1;
  limitations: string[];
  createdAt: string;
  fingerprint: string;
}

export type ProjectIdeaBriefUnsignedV1 = Omit<
  ProjectIdeaBriefV1,
  "version" | "kind" | "fingerprint"
>;

/**
 * Exact, non-authoritative input for the existing accepted-research host.
 * This is not an AcceptedResearchArtifact: the host must still write and hash
 * the note, persist a write receipt, and explicitly accept the evidence-bound
 * artifact before any Linear mutation is prepared.
 */
export interface ProjectIdeaAcceptedResearchSeedV1 {
  kind: "project_idea_accepted_research_seed";
  projectIdeaFingerprint: string;
  ideaId: string;
  title: string;
  problemImpact: string;
  hypothesis: string;
  options: ProjectIdeaOptionV1[];
  selectedOptionId: string;
  selectedDirection: ProjectIdeaOptionV1;
  proposedWork: string[];
  nonGoals: string[];
  constraints: string[];
  risks: string[];
  acceptanceCriteria: ProjectIdeaAcceptanceCriterionV1[];
  evidence: ProjectIdeaEvidenceV1[];
  evidenceStatus: "grounded";
  riskClass: ProjectIdeaRiskClassV1;
  limitations: string[];
  createdAt: string;
}

export class ProjectIdeaBriefErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectIdeaBriefErrorV1";
  }
}

export function createProjectIdeaBriefV1(
  input: ProjectIdeaBriefUnsignedV1,
): ProjectIdeaBriefV1 {
  const evidence = normalizeUnsigned(input);
  const fixed = {
    version: PROJECT_IDEA_BRIEF_VERSION_V1,
    kind: "project_idea_brief" as const,
    ...evidence,
  };
  return {
    ...fixed,
    fingerprint: fingerprintProjectIdeaBriefV1(fixed),
  };
}

export function parseProjectIdeaBriefV1(value: unknown): ProjectIdeaBriefV1 {
  const record = exactRecord(
    value,
    [
      "version", "kind", "ideaId", "title", "problem", "hypothesis",
      "options", "selectedOptionId", "proposedWork", "nonGoals",
      "constraints", "risks", "acceptanceCriteria", "evidenceStatus",
      "evidence", "riskClass", "limitations", "createdAt", "fingerprint",
    ],
    "project idea brief",
  );
  if (
    record.version !== PROJECT_IDEA_BRIEF_VERSION_V1 ||
    record.kind !== "project_idea_brief"
  ) {
    fail("Unsupported project idea brief contract.");
  }
  const observedFingerprint = fingerprint(
    record.fingerprint,
    "project idea brief fingerprint",
  );
  const {
    version: _version,
    kind: _kind,
    fingerprint: _fingerprint,
    ...rawUnsigned
  } = record;
  const unsigned = normalizeUnsigned(rawUnsigned);
  const fixed = {
    version: PROJECT_IDEA_BRIEF_VERSION_V1,
    kind: "project_idea_brief" as const,
    ...unsigned,
  };
  if (observedFingerprint !== fingerprintProjectIdeaBriefV1(fixed)) {
    fail("Project idea brief fingerprint does not match its canonical payload.");
  }
  return { ...fixed, fingerprint: observedFingerprint };
}

export function fingerprintProjectIdeaBriefV1(
  value: Omit<ProjectIdeaBriefV1, "fingerprint"> | ProjectIdeaBriefV1,
): string {
  const record = objectRecord(value, "project idea brief fingerprint input");
  const { fingerprint: _ignored, ...unsigned } = record;
  return `sha256:${portableSha256Text(canonicalJson(unsigned))}`;
}

/**
 * Promote only exact grounded ideation. No evidence, acceptance criterion, or
 * narrative is generated here; every downstream field is copied from the
 * fingerprint-verified brief.
 */
export function deriveAcceptedResearchSeedFromProjectIdeaBriefV1(
  value: unknown,
): ProjectIdeaAcceptedResearchSeedV1 {
  const brief = parseProjectIdeaBriefV1(value);
  if (brief.evidenceStatus !== "grounded" || brief.evidence.length === 0) {
    fail(
      "An unverified project idea cannot seed accepted research; attach exact evidence first.",
    );
  }
  if (brief.selectedOptionId === null) {
    fail(
      "A project idea must select one evaluated option before it can seed accepted research.",
    );
  }
  const selectedDirection = brief.options.find(
    (option) => option.id === brief.selectedOptionId,
  );
  if (!selectedDirection) {
    fail("The selected project idea option is missing.");
  }
  return seedFromGroundedBrief(brief, selectedDirection);
}

/**
 * Parse a durable ideation promotion seed without relying on process-local
 * state. The seed deliberately carries every field required to reconstruct
 * the source brief, so its projectIdeaFingerprint remains independently
 * verifiable after a host restart.
 */
export function parseProjectIdeaAcceptedResearchSeedV1(
  value: unknown,
): ProjectIdeaAcceptedResearchSeedV1 {
  const record = exactRecord(
    value,
    [
      "kind", "projectIdeaFingerprint", "ideaId", "title", "problemImpact",
      "hypothesis", "options", "selectedOptionId", "selectedDirection",
      "proposedWork", "nonGoals", "constraints", "risks",
      "acceptanceCriteria", "evidence", "evidenceStatus", "riskClass",
      "limitations", "createdAt",
    ],
    "project idea accepted research seed",
  );
  if (record.kind !== "project_idea_accepted_research_seed") {
    fail("Unsupported project idea accepted research seed contract.");
  }
  const projectIdeaFingerprint = fingerprint(
    record.projectIdeaFingerprint,
    "project idea promotion fingerprint",
  );
  const selectedOptionId = logicalId(
    record.selectedOptionId,
    "project idea promotion selected option id",
  );
  const sourceBrief = parseProjectIdeaBriefV1({
    version: PROJECT_IDEA_BRIEF_VERSION_V1,
    kind: "project_idea_brief",
    ideaId: record.ideaId,
    title: record.title,
    problem: record.problemImpact,
    hypothesis: record.hypothesis,
    options: record.options,
    selectedOptionId,
    proposedWork: record.proposedWork,
    nonGoals: record.nonGoals,
    constraints: record.constraints,
    risks: record.risks,
    acceptanceCriteria: record.acceptanceCriteria,
    evidenceStatus: record.evidenceStatus,
    evidence: record.evidence,
    riskClass: record.riskClass,
    limitations: record.limitations,
    createdAt: record.createdAt,
    fingerprint: projectIdeaFingerprint,
  });
  const selectedDirection = sourceBrief.options.find(
    (option) => option.id === sourceBrief.selectedOptionId,
  );
  if (!selectedDirection) {
    fail("The durable project idea selected direction is missing.");
  }
  const expected = seedFromGroundedBrief(sourceBrief, selectedDirection);
  if (canonicalJson(record) !== canonicalJson(expected)) {
    fail(
      "Project idea accepted research seed does not match its fingerprinted source brief.",
    );
  }
  return expected;
}

function seedFromGroundedBrief(
  brief: ProjectIdeaBriefV1,
  selectedDirection: ProjectIdeaOptionV1,
): ProjectIdeaAcceptedResearchSeedV1 {
  if (
    brief.evidenceStatus !== "grounded" ||
    brief.evidence.length === 0 ||
    brief.selectedOptionId === null
  ) {
    fail("Only grounded, selected project ideas can produce a promotion seed.");
  }
  return {
    kind: "project_idea_accepted_research_seed",
    projectIdeaFingerprint: brief.fingerprint,
    ideaId: brief.ideaId,
    title: brief.title,
    problemImpact: brief.problem,
    hypothesis: brief.hypothesis,
    options: clone(brief.options),
    selectedOptionId: brief.selectedOptionId,
    selectedDirection: clone(selectedDirection),
    proposedWork: clone(brief.proposedWork),
    nonGoals: clone(brief.nonGoals),
    constraints: clone(brief.constraints),
    risks: clone(brief.risks),
    acceptanceCriteria: clone(brief.acceptanceCriteria),
    evidence: clone(brief.evidence),
    evidenceStatus: "grounded",
    riskClass: brief.riskClass,
    limitations: clone(brief.limitations),
    createdAt: brief.createdAt,
  };
}

function normalizeUnsigned(value: unknown): ProjectIdeaBriefUnsignedV1 {
  const record = exactRecord(
    value,
    [
      "ideaId", "title", "problem", "hypothesis", "options",
      "selectedOptionId", "proposedWork", "nonGoals", "constraints",
      "risks", "acceptanceCriteria", "evidenceStatus", "evidence",
      "riskClass", "limitations", "createdAt",
    ],
    "project idea brief evidence",
  );
  const options = optionList(record.options);
  const selectedOptionId = nullableLogicalId(
    record.selectedOptionId,
    "selected option id",
  );
  if (
    selectedOptionId !== null &&
    !options.some((option) => option.id === selectedOptionId)
  ) {
    fail("Selected option id must reference one of the project idea options.");
  }
  const evidenceStatus = enumeration<ProjectIdeaEvidenceStatusV1>(
    record.evidenceStatus,
    "evidence status",
    ["grounded", "unverified"],
  );
  const evidence = evidenceList(record.evidence);
  if (
    (evidenceStatus === "grounded" && evidence.length === 0) ||
    (evidenceStatus === "unverified" && evidence.length !== 0)
  ) {
    fail(
      "Grounded project ideas require exact evidence; unverified ideas must not claim evidence.",
    );
  }
  const limitations = narrativeList(
    record.limitations,
    "project idea limitation",
    evidenceStatus === "unverified" ? 1 : 0,
    10,
  );
  return {
    ideaId: logicalId(record.ideaId, "project idea id"),
    title: oneLine(record.title, "project idea title", 1, 200),
    problem: narrative(record.problem, "project idea problem", 1, 4_000),
    hypothesis: narrative(
      record.hypothesis,
      "project idea hypothesis",
      1,
      4_000,
    ),
    options,
    selectedOptionId,
    proposedWork: narrativeList(
      record.proposedWork,
      "project idea proposed work",
      1,
      20,
    ),
    nonGoals: narrativeList(record.nonGoals, "project idea non-goal", 1, 20),
    constraints: narrativeList(
      record.constraints,
      "project idea constraint",
      0,
      20,
    ),
    risks: narrativeList(record.risks, "project idea risk", 0, 20),
    acceptanceCriteria: acceptanceCriterionList(record.acceptanceCriteria),
    evidenceStatus,
    evidence,
    riskClass: enumeration<ProjectIdeaRiskClassV1>(
      record.riskClass,
      "project idea risk class",
      ["low", "medium", "high"],
    ),
    limitations,
    createdAt: timestamp(record.createdAt, "project idea createdAt"),
  };
}

function optionList(value: unknown): ProjectIdeaOptionV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    fail("Project idea options require 1-5 entries.");
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const record = exactRecord(
      entry,
      ["id", "title", "summary"],
      `project idea option ${index + 1}`,
    );
    const id = logicalId(record.id, `project idea option ${index + 1} id`);
    if (ids.has(id)) fail(`Project idea option id ${id} is duplicated.`);
    ids.add(id);
    return {
      id,
      title: oneLine(
        record.title,
        `project idea option ${index + 1} title`,
        1,
        200,
      ),
      summary: narrative(
        record.summary,
        `project idea option ${index + 1} summary`,
        1,
        2_000,
      ),
    };
  });
}

function acceptanceCriterionList(
  value: unknown,
): ProjectIdeaAcceptanceCriterionV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    fail("Project idea acceptance criteria require 1-20 entries.");
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const record = exactRecord(
      entry,
      ["id", "text"],
      `project idea acceptance criterion ${index + 1}`,
    );
    if (typeof record.id !== "string" || !/^AC-[1-9][0-9]?$/u.test(record.id)) {
      fail(
        `Project idea acceptance criterion ${index + 1} id must match AC-1 through AC-99.`,
      );
    }
    if (ids.has(record.id)) {
      fail(`Project idea acceptance criterion id ${record.id} is duplicated.`);
    }
    ids.add(record.id);
    return {
      id: record.id,
      text: narrative(
        record.text,
        `project idea acceptance criterion ${index + 1} text`,
        1,
        500,
      ),
    };
  });
}

function evidenceList(value: unknown): ProjectIdeaEvidenceV1[] {
  if (!Array.isArray(value) || value.length > 50) {
    fail("Project idea evidence requires 0-50 entries.");
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const record = exactRecord(
      entry,
      ["id", "kind", "reference", "contentSha256"],
      `project idea evidence ${index + 1}`,
    );
    const id = logicalId(record.id, `project idea evidence ${index + 1} id`);
    if (ids.has(id)) fail(`Project idea evidence id ${id} is duplicated.`);
    ids.add(id);
    const kind = enumeration<ProjectIdeaEvidenceKindV1>(
      record.kind,
      `project idea evidence ${index + 1} kind`,
      ["web", "vault", "user"],
    );
    return {
      id,
      kind,
      reference: evidenceReference(
        record.reference,
        kind,
        `project idea evidence ${index + 1} reference`,
      ),
      contentSha256: fingerprint(
        record.contentSha256,
        `project idea evidence ${index + 1} content hash`,
      ),
    };
  });
}

function evidenceReference(
  value: unknown,
  kind: ProjectIdeaEvidenceKindV1,
  label: string,
): string {
  if (kind === "web") {
    const reference = oneLine(value, label, 1, 2_048);
    let url: URL;
    try {
      url = new URL(reference);
    } catch {
      fail(`${label} must be an absolute HTTP(S) URL.`);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      fail(`${label} must be an absolute HTTP(S) URL without credentials.`);
    }
    return reference;
  }
  if (kind === "vault") {
    const reference = oneLine(value, label, 1, 1_024);
    if (
      reference.includes("\\") ||
      reference.startsWith("/") ||
      /^[A-Za-z]:/u.test(reference) ||
      reference.split("/").some((part) => part === ".." || part === ".") ||
      !reference.toLowerCase().endsWith(".md")
    ) {
      fail(`${label} must be a safe vault-relative Markdown path.`);
    }
    return reference;
  }
  return logicalId(value, label);
}

function narrativeList(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${label} list requires ${minimum}-${maximum} entries.`);
  }
  const parsed = value.map((entry, index) =>
    narrative(entry, `${label} ${index + 1}`, 1, 1_000),
  );
  if (new Set(parsed).size !== parsed.length) {
    fail(`${label} list must not contain duplicates.`);
  }
  return parsed;
}

function oneLine(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\0\r\n]/u.test(value) ||
    SECRET_VALUE.test(value)
  ) {
    fail(`${label} must be canonical bounded secret-free text.`);
  }
  return value;
}

function narrative(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.trim() !== value ||
    value.includes("\0") ||
    SECRET_VALUE.test(value)
  ) {
    fail(`${label} must be canonical bounded secret-free text.`);
  }
  return value.replace(/\r\n?/gu, "\n");
}

function nullableLogicalId(value: unknown, label: string): string | null {
  return value === null ? null : logicalId(value, label);
}

function logicalId(value: unknown, label: string): string {
  if (typeof value !== "string" || !LOGICAL_ID.test(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label} must be a SHA-256 fingerprint.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function enumeration<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`${label} is outside the fixed catalog.`);
  }
  return value as T;
}

function exactRecord<const T extends readonly string[]>(
  value: unknown,
  keys: T,
  label: string,
): Record<T[number], unknown> {
  const record = objectRecord(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) {
    fail(`${label} does not match its closed contract.`);
  }
  return record as Record<T[number], unknown>;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      fail("Project idea fingerprint evidence contains an unsafe number.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    fail("Project idea fingerprint evidence contains an unsupported value.");
  }
  return `{${Object.keys(value as object)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(",")}}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fail(message: string): never {
  throw new ProjectIdeaBriefErrorV1(message);
}
