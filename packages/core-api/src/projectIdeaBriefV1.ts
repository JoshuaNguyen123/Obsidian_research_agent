import {
  ACCEPTANCE_CRITERION_ID_PATTERN_V1,
  normalizeAcceptanceCriterionIdV1,
} from "./acceptanceCriterionIdV1";
import { portableSha256Text } from "./portableSha256";

export const PROJECT_IDEA_BRIEF_VERSION_V1 = 1 as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SECRET_VALUE =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*\S+)/iu;

/**
 * Which control characters text may carry, asked once for every free-text
 * field in this module.
 *
 * The answer is not chosen here: it is READ OFF the strictest consumer a brief
 * reaches. `AcceptedResearchNoteWriter` validates every field a promotion seed
 * feeds it -- title, problemImpact, objective, proposed work, non-goals,
 * criterion text, evidence label and summary -- through `expectString` with
 * `allowNewlines`, whose reject class is exactly this one, and re-checks the
 * same set in `boundedText`. Adopting anything narrower would refuse briefs
 * that the note writer accepts; adopting anything wider re-opens the gap this
 * constant closes.
 *
 * Tab survives deliberately. It is the one control character in legitimate
 * narrative text -- an indented list, a pasted table -- and the note writer
 * already accepts it, so banning it upstream would refuse content no reader
 * downstream objects to. CR and LF survive for the same reason; `oneLine`
 * refuses them for its own separate reason, that a title is one line.
 */
const UNSUPPORTED_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Every rejection below states the RULE it enforced, not only the field that
 * broke it. A cohort died here: `create_project_idea_brief` was refused with
 * "project idea option 1 id is invalid", which names a field and no constraint,
 * so the retry the model is given was a guess. Messages travel to the model
 * inside a tool result and are truncated downstream at 400 characters, so each
 * one states its constraint and stops.
 *
 * The second half of the contract is what a message must NOT carry. This
 * module already refuses credential-shaped values, and a rejection that quoted
 * the offending text would hand that value straight back into a transcript. So
 * free-text fields are never quoted, and neither are ids: LOGICAL_ID admits 160
 * characters of `[A-Za-z0-9._:-]`, which is exactly the shape of an API token.
 * Positions, lengths and counts are reported instead -- they locate the problem
 * without reproducing the value. The one id that IS quoted is a normalized
 * acceptance-criterion id, and only after normalization has reduced it to one
 * of the 99 fixed strings "AC-1".."AC-99".
 */
const LOGICAL_ID_RULE =
  'must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$: 1-160 characters, starting with a letter or digit, then only letters, digits, ".", "_", ":" and "-"';

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
    fail(
      `Unsupported project idea brief contract: version must be ${PROJECT_IDEA_BRIEF_VERSION_V1} and kind must be "project_idea_brief".`,
    );
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
    fail(
      "Project idea brief fingerprint does not match its canonical payload: the fingerprint must be recomputed over every other field, so a brief cannot be edited in place.",
    );
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
      'An unverified project idea cannot seed accepted research; attach exact evidence first and set evidenceStatus to "grounded".',
    );
  }
  if (brief.selectedOptionId === null) {
    fail(
      "A project idea must select one evaluated option before it can seed accepted research: set selectedOptionId to the id of one of its options.",
    );
  }
  const selectedDirection = brief.options.find(
    (option) => option.id === brief.selectedOptionId,
  );
  if (!selectedDirection) {
    fail(
      "The selected project idea option is missing: selectedOptionId must equal the id of an entry in options.",
    );
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
    fail(
      'Unsupported project idea accepted research seed contract: kind must be "project_idea_accepted_research_seed".',
    );
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
    fail(
      "The durable project idea selected direction is missing: selectedOptionId must equal the id of an entry in the seed's options.",
    );
  }
  const expected = seedFromGroundedBrief(sourceBrief, selectedDirection);
  if (canonicalJson(record) !== canonicalJson(expected)) {
    fail(
      "Project idea accepted research seed does not match its fingerprinted source brief: every seed field must be copied verbatim from the brief the fingerprint was taken over.",
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
    fail(
      'Only grounded, selected project ideas can produce a promotion seed: evidenceStatus must be "grounded", evidence must hold at least one entry, and selectedOptionId must not be null.',
    );
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
    fail(
      "Selected option id must reference one of the project idea options: it must equal the id of an entry in options, or be null.",
    );
  }
  const evidenceStatus = enumeration<ProjectIdeaEvidenceStatusV1>(
    record.evidenceStatus,
    "evidence status",
    ["grounded", "unverified"],
  );
  const evidence = evidenceList(record.evidence);
  // One condition per message. The combined form fired for two opposite
  // mistakes and named neither, so a caller who had over-claimed evidence read
  // the same sentence as a caller who had under-supplied it.
  if (evidenceStatus === "grounded" && evidence.length === 0) {
    fail(
      'Grounded project ideas require exact evidence: evidenceStatus "grounded" needs at least one evidence entry, or set evidenceStatus to "unverified".',
    );
  }
  if (evidenceStatus === "unverified" && evidence.length !== 0) {
    fail(
      'An unverified project idea must claim no evidence: evidence must be empty when evidenceStatus is "unverified", or set evidenceStatus to "grounded".',
    );
  }
  const limitations = narrativeList(
    record.limitations,
    "project idea limitation",
    evidenceStatus === "unverified" ? 1 : 0,
    10,
    evidenceStatus === "unverified"
      ? "an unverified idea must state at least one thing it could not verify"
      : undefined,
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
  if (!Array.isArray(value)) {
    fail("Project idea options must be an array of 1-5 option objects.");
  }
  if (value.length < 1 || value.length > 5) {
    fail(
      `Project idea options require 1-5 entries; received ${value.length}.`,
    );
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const record = exactRecord(
      entry,
      ["id", "title", "summary"],
      `project idea option ${index + 1}`,
    );
    const id = logicalId(record.id, `project idea option ${index + 1} id`);
    if (ids.has(id)) {
      // Positional, never the id itself. An option id is caller-supplied and
      // LOGICAL_ID is wide enough to admit an API token, so the collision is
      // described rather than quoted.
      fail(
        `Project idea option ${index + 1} repeats the id of an earlier option; option ids must be unique within the list.`,
      );
    }
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
  if (!Array.isArray(value)) {
    fail(
      "Project idea acceptance criteria must be an array of 1-20 criterion objects.",
    );
  }
  if (value.length < 1 || value.length > 20) {
    fail(
      `Project idea acceptance criteria require 1-20 entries; received ${value.length}.`,
    );
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const record = exactRecord(
      entry,
      ["id", "text"],
      `project idea acceptance criterion ${index + 1}`,
    );
    // The shared normalizer, not a fourth private copy of the same regex. This
    // seat is the one whose rejection motivated the normalizer, and it was the
    // only one still refusing "ac-01", "AC1" and "AC-01" -- forms the three
    // Linear validators downstream already accept. A brief that clears this
    // gate is now accepted verbatim by every seat it feeds.
    const id = normalizeAcceptanceCriterionIdV1(record.id);
    if (!id) {
      fail(
        `Project idea acceptance criterion ${index + 1} id must match ${ACCEPTANCE_CRITERION_ID_PATTERN_V1}: "AC-<n>" with n from 1 to 99 and no leading zeros. The variants "ac-1", "AC1" and "AC-01" are accepted and stored in the canonical form.`,
      );
    }
    if (ids.has(id)) {
      // The only value this module quotes back. Normalization has already
      // reduced it to one of the 99 fixed strings "AC-1".."AC-99", so it
      // carries no caller-supplied text and cannot be a credential.
      fail(
        `Project idea acceptance criterion id ${id} is duplicated; each id must appear once. "AC-1", "ac-01" and "AC1" are the same id.`,
      );
    }
    ids.add(id);
    return {
      // The canonical form is what persists, so a tolerated variant never
      // reaches the fingerprint, a promotion seed, or a rendered Linear issue.
      id,
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
  if (!Array.isArray(value)) {
    fail("Project idea evidence must be an array of 0-50 evidence objects.");
  }
  if (value.length > 50) {
    fail(
      `Project idea evidence requires 0-50 entries; received ${value.length}.`,
    );
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const record = exactRecord(
      entry,
      ["id", "kind", "reference", "contentSha256"],
      `project idea evidence ${index + 1}`,
    );
    const id = logicalId(record.id, `project idea evidence ${index + 1} id`);
    if (ids.has(id)) {
      // Positional for the same reason as an option id: LOGICAL_ID admits a
      // token-shaped string, so the value is never quoted back.
      fail(
        `Project idea evidence ${index + 1} repeats the id of an earlier entry; evidence ids must be unique within the list.`,
      );
    }
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
    const reference = locator(value, label, 1, 2_048);
    let url: URL;
    try {
      url = new URL(reference);
    } catch {
      fail(
        `${label} must be an absolute HTTP(S) URL such as https://example.com/page; a relative or unparseable URL is rejected. The value is not echoed here because a URL can carry a credential.`,
      );
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      fail(`${label} must use the http: or https: scheme.`);
    }
    if (url.username.length > 0 || url.password.length > 0) {
      // The userinfo component IS the credential, so the URL stays unquoted.
      fail(
        `${label} must be an absolute HTTP(S) URL without credentials: it must not carry a user:password@ component before the host.`,
      );
    }
    return reference;
  }
  if (kind === "vault") {
    const reference = locator(value, label, 1, 1_024);
    // One condition per message. The combined form fired for five distinct
    // path mistakes and named none of them.
    if (reference.includes("\\")) {
      fail(
        `${label} must be a safe vault-relative Markdown path: separate folders with "/" only, and never with a backslash.`,
      );
    }
    if (reference.startsWith("/") || /^[A-Za-z]:/u.test(reference)) {
      fail(
        `${label} must be a safe vault-relative Markdown path: it must be relative to the vault root, with no leading "/" and no drive letter.`,
      );
    }
    if (reference.split("/").some((part) => part === ".." || part === ".")) {
      fail(
        `${label} must be a safe vault-relative Markdown path: it must not contain a "." or ".." segment.`,
      );
    }
    if (!reference.toLowerCase().endsWith(".md")) {
      fail(
        `${label} must be a safe vault-relative Markdown path: it must end with the ".md" extension.`,
      );
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
  reason?: string,
): string[] {
  if (!Array.isArray(value)) {
    fail(`${label} list must be an array of ${minimum}-${maximum} strings.`);
  }
  if (value.length < minimum || value.length > maximum) {
    // A bound the caller cannot derive from the field alone deserves its
    // reason: `limitations` is optional for a grounded brief and mandatory for
    // an unverified one, and only the caller's own evidenceStatus says which.
    const because = reason === undefined ? "" : ` ${capitalize(reason)}.`;
    fail(
      `${label} list requires ${minimum}-${maximum} entries; received ${value.length}.${because}`,
    );
  }
  const parsed = value.map((entry, index) =>
    narrative(entry, `${label} ${index + 1}`, 1, 1_000),
  );
  // Report WHICH entry collides. The set-size comparison rejected exactly the
  // same lists but told the caller only that one of up to twenty entries was a
  // repeat, which is a search rather than a fix.
  const seen = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    if (seen.has(entry)) {
      // Positional, never the text: these are free-text fields, and this
      // module does not quote free text back to the caller.
      fail(
        `${label} list entry ${index + 1} repeats an earlier entry; the list must not contain duplicates.`,
      );
    }
    seen.add(entry);
  }
  return parsed;
}

/**
 * The single body behind both text seats. The two used to be independent
 * copies of the same four rules, and they had already drifted on the one rule
 * below that is not obvious: `oneLine` refused NUL, CR and LF, `narrative`
 * refused only NUL, and so a narrative field accepted the twenty-eight
 * remaining C0 controls plus DEL. The accepted-research note writer refuses
 * every one of them, so a brief could clear this validator and be rejected two
 * stages later -- the failure shape this repository keeps paying for, two
 * places answering one question differently.
 *
 * Both seats now ask the shared question once, here. `oneLine` adds a rule
 * about line STRUCTURE on top; that is a different question, it is published
 * on the two one-line fields, and it is stricter than anything downstream, so
 * it can refuse text but can never let text through that a later stage
 * refuses.
 */
function canonicalText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string") {
    fail(`${label} must be a string.`);
  }
  if (value.length < minimum || value.length > maximum) {
    fail(
      `${label} must be ${minimum}-${maximum} characters; received ${value.length}.`,
    );
  }
  if (value.trim() !== value) {
    fail(`${label} must not begin or end with whitespace.`);
  }
  const control = UNSUPPORTED_CONTROL.exec(value);
  if (control) {
    // The position and the code point, never the surrounding text. A control
    // character is not caller prose, so naming it cannot leak a credential,
    // and a caller who cannot see the character needs to be told which one it
    // is and where.
    fail(
      `${label} must not contain a control character: tab, line feed and carriage return are the only ones text may carry. Found U+${control[0]
        .codePointAt(0)!
        .toString(16)
        .toUpperCase()
        .padStart(4, "0")} at position ${control.index}.`,
    );
  }
  if (SECRET_VALUE.test(value)) {
    fail(secretShapedFailure(label));
  }
  return value;
}

function oneLine(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  const text = canonicalText(value, label, minimum, maximum);
  if (/[\r\n]/u.test(text)) {
    fail(
      `${label} must be a single line: it must contain no carriage return and no line feed. A tab is accepted here; a line break is not.`,
    );
  }
  return text;
}

/**
 * A reference is a locator, not prose, and that is a different question
 * from the one {@link canonicalText} answers. The strictest reader a stored
 * reference reaches is `parseHttpUrl` / `parseVaultMarkdownPath`, which run
 * `expectString` in its DEFAULT mode and admit no control character at all --
 * tab included -- so a tab was accepted here and refused there.
 *
 * Refusing it costs nothing real: a URL and a vault path have no legitimate
 * use for a tab, and WHATWG URL parsing silently STRIPS tabs and line breaks,
 * so tolerating one would also mean the reference a brief stores and the URL a
 * host actually fetches are two different strings.
 */
function locator(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  const text = canonicalText(value, label, minimum, maximum);
  if (/[\t\r\n]/u.test(text)) {
    fail(
      `${label} must be a single-line locator: it must contain no tab, no carriage return and no line feed. Only free-text fields may carry them.`,
    );
  }
  return text;
}

function narrative(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  return canonicalText(value, label, minimum, maximum).replace(/\r\n?/gu, "\n");
}

/**
 * The one rejection that must describe the value without reproducing any of
 * it. Naming the shapes SECRET_VALUE looks for is what makes the message
 * actionable; echoing the match would copy a live credential into a tool
 * result, a run note and a transcript.
 *
 * One copy, shared by the single-line and the narrative validator, so the two
 * seats cannot drift into describing the same refusal differently.
 */
function secretShapedFailure(label: string): string {
  return `${label} must be secret-free text: it matches a credential shape ("Bearer <token>", or api_key / access_token / password / secret set to a value). The offending text is deliberately not quoted here; remove the credential and refer to it indirectly.`;
}

function nullableLogicalId(value: unknown, label: string): string | null {
  return value === null ? null : logicalId(value, label);
}

function logicalId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail(`${label} must be a string.`);
  }
  if (!LOGICAL_ID.test(value)) {
    fail(
      `${label} must be a logical id: it ${LOGICAL_ID_RULE}. The value is not quoted back because an id of that shape can carry a credential.`,
    );
  }
  return value;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail(`${label} must be a string.`);
  }
  if (!SHA256.test(value)) {
    fail(
      `${label} must be a SHA-256 fingerprint matching ${SHA256.source}: the literal prefix "sha256:" followed by exactly 64 lowercase hexadecimal characters.`,
    );
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail(`${label} must be a string.`);
  }
  if (!Number.isFinite(Date.parse(value))) {
    fail(
      `${label} must be an ISO-8601 timestamp such as 2026-08-19T12:00:00.000Z; this value could not be parsed as a date.`,
    );
  }
  if (new Date(Date.parse(value)).toISOString() !== value) {
    fail(
      `${label} must be a canonical ISO timestamp: the exact UTC spelling YYYY-MM-DDTHH:MM:SS.sssZ, for example 2026-08-19T12:00:00.000Z. A local offset, a missing millisecond field or a lowercase z is rejected.`,
    );
  }
  return value;
}

function enumeration<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    // The catalog is a compile-time literal union, so listing its members
    // cannot echo anything the caller supplied.
    fail(
      `${label} must be exactly one of the fixed catalog: ${allowed.join(", ")}.`,
    );
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
    // Missing keys are named because they come from this module's own closed
    // list, a compile-time constant that is provably not a credential.
    // Supplied-but-unexpected keys are only counted: a key name is caller data
    // like any other, and a caller who sent an extra key can find it by
    // diffing against the required list.
    const missing = expected.filter((key) => !actual.includes(key));
    const unexpected = actual.length - (expected.length - missing.length);
    fail(
      `${label} does not match its closed contract: it must carry exactly these ${expected.length} keys and no others. Missing: ${describeMissingKeys(
        missing,
      )}. Unexpected keys supplied: ${unexpected}.`,
    );
  }
  return record as Record<T[number], unknown>;
}

/**
 * Bounded on purpose. Every message here travels to the model inside a tool
 * result that is truncated at 400 characters, and the widest contract in this
 * module has nineteen keys -- listing all of them would push the useful half
 * of the sentence past the cut.
 */
function describeMissingKeys(missing: readonly string[]): string {
  if (missing.length === 0) {
    return "none";
  }
  const shown = missing.slice(0, 6);
  const remainder = missing.length - shown.length;
  return remainder === 0
    ? shown.join(", ")
    : `${shown.join(", ")} and ${remainder} more`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      `${label} must be a JSON object; an array, null, or a primitive is rejected.`,
    );
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
      fail(
        "Project idea fingerprint evidence contains an unsafe number: every number must be finite, and an integer must be within the safe-integer range.",
      );
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    fail(
      "Project idea fingerprint evidence contains an unsupported value: only null, boolean, number, string, array and plain object can be canonicalized.",
    );
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
