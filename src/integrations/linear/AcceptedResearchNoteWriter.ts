import {
  DiagramArtifactStore,
  DiagramArtifactStoreError,
  type DiagramArtifactCreateTransactionReceipt,
  type DiagramArtifactStoreOptions,
  type DiagramArtifactUpdateReceipt,
  type DiagramArtifactVaultLike,
} from "../../design/diagramArtifactStore";
import {
  createAcceptedResearchArtifactV1,
  type AcceptedResearchArtifactV1,
  type AcceptedResearchEvidenceV1,
} from "./AcceptedResearchArtifactV1";
import type {
  WorkItemAcceptanceCriterionV1,
  WorkItemExecutionClass,
  WorkItemRiskClass,
} from "./WorkItemSpecV1";

const MAX_SECTION_CHARS = 8_000;
const MAX_LIST_ENTRIES = 50;

export interface AcceptedResearchEvidenceNoteEntryV1
  extends AcceptedResearchEvidenceV1 {
  label: string;
  summary: string;
}

export interface AcceptedResearchNotePackageV1 {
  schemaVersion: 1;
  title: string;
  problemImpact: string;
  evidence: AcceptedResearchEvidenceNoteEntryV1[];
  confidenceLimitations: string;
  proposedWork: string[];
  nonGoals: string[];
  scope: string[];
  dependencies: string[];
  acceptanceCriteria: WorkItemAcceptanceCriterionV1[];
  validationRequirementKeys: string[];
  riskClass: WorkItemRiskClass;
  executionClass: WorkItemExecutionClass;
  objective: string;
  repositoryKey?: string;
  vaultBindingKey: string;
  originRunId: string;
}

export interface AcceptedResearchNoteWriteRequestV1 {
  path: string;
  mode: "create" | "append";
  baseHash?: string;
  artifactId: string;
  acceptedAt: string;
  package: AcceptedResearchNotePackageV1;
}

export interface AcceptedResearchNoteWriteResultV1 {
  path: string;
  operation: "create" | "append";
  beforeSha256: string | null;
  afterSha256: string;
  noteReceiptId: string;
  artifact: AcceptedResearchArtifactV1;
  transaction: DiagramArtifactCreateTransactionReceipt | DiagramArtifactUpdateReceipt;
}

export interface ResearchNoteBacklinkResultV1 {
  path: string;
  operation: "append" | "no_op";
  beforeSha256: string;
  afterSha256: string;
  issueUrl: string;
  transaction: DiagramArtifactUpdateReceipt | null;
}

export interface ResearchNoteGitHubCompletionResultV1 {
  path: string;
  operation: "append" | "no_op";
  beforeSha256: string;
  afterSha256: string;
  pullRequestUrl: string;
  mergeCommitUrl: string | null;
  transaction: DiagramArtifactUpdateReceipt | null;
}

/** Host-owned note writer. External integration code never receives the vault. */
export class AcceptedResearchNoteWriter {
  private readonly store: DiagramArtifactStore;

  constructor(
    vault: DiagramArtifactVaultLike,
    options: DiagramArtifactStoreOptions = {},
  ) {
    this.store = new DiagramArtifactStore(vault, options);
  }

  async writeAcceptedPackage(
    request: AcceptedResearchNoteWriteRequestV1,
  ): Promise<AcceptedResearchNoteWriteResultV1> {
    const normalized = normalizePackage(request.package);
    const artifactEvidence = normalized.evidence.map(
      ({ id, kind, reference, contentSha256 }) => ({
        id,
        kind,
        reference,
        contentSha256,
      }),
    );
    // Validate every artifact-bound field before any vault mutation.
    createAcceptedResearchArtifactV1({
      schemaVersion: 1,
      artifactId: request.artifactId,
      originRunId: normalized.originRunId,
      vaultBindingKey: normalized.vaultBindingKey,
      notePath: request.path,
      noteSha256: `sha256:${"0".repeat(64)}`,
      noteReceiptId: "research-note-preflight",
      evidence: artifactEvidence,
      acceptanceCriteria: normalized.acceptanceCriteria,
      riskClass: normalized.riskClass,
      acceptedAt: request.acceptedAt,
      acceptedBy: "host",
    });
    const rendered = renderAcceptedResearchNotePackageV1(normalized);
    let beforeSha256: string | null = null;
    let afterSha256: string;
    let operation: "create" | "append";
    let transaction: DiagramArtifactCreateTransactionReceipt | DiagramArtifactUpdateReceipt;

    if (request.mode === "create") {
      const created = await this.store.createMany([{
        path: request.path,
        content: rendered,
        validator: ({ content }) => validateRenderedResearchNote(content, normalized.title),
      }]);
      if (created.status !== "committed" || !created.artifacts[0]?.afterSha256) {
        throw new Error(created.error?.message ?? "Accepted research note create rolled back.");
      }
      operation = "create";
      afterSha256 = created.artifacts[0].afterSha256;
      transaction = created;
    } else {
      const current = await this.store.read(request.path);
      beforeSha256 = current.sha256;
      if (!request.baseHash || request.baseHash !== current.sha256) {
        throw new DiagramArtifactStoreError(
          "expected_hash_mismatch",
          "Accepted research note changed before append.",
        );
      }
      const content = appendSection(current.content, rendered);
      const updated = await this.store.update({
        path: request.path,
        expectedSha256: current.sha256,
        content,
        validator: ({ content: persisted }) =>
          validateRenderedResearchNote(persisted, normalized.title),
      });
      if (updated.status !== "committed" || !updated.afterSha256) {
        throw new Error(updated.error?.message ?? "Accepted research note append rolled back.");
      }
      operation = "append";
      afterSha256 = updated.afterSha256;
      transaction = updated;
    }

    const noteReceiptId = `research-note-${afterSha256.slice(7, 39)}`;
    const artifact = createAcceptedResearchArtifactV1({
      schemaVersion: 1,
      artifactId: request.artifactId,
      originRunId: normalized.originRunId,
      vaultBindingKey: normalized.vaultBindingKey,
      notePath: request.path,
      noteSha256: afterSha256,
      noteReceiptId,
      evidence: artifactEvidence,
      acceptanceCriteria: normalized.acceptanceCriteria,
      riskClass: normalized.riskClass,
      acceptedAt: request.acceptedAt,
      acceptedBy: "host",
    });
    return {
      path: request.path,
      operation,
      beforeSha256,
      afterSha256,
      noteReceiptId,
      artifact,
      transaction,
    };
  }

  async appendLinearBacklink(input: {
    artifact: AcceptedResearchArtifactV1;
    expectedNoteSha256: string;
    issueIdentifier: string;
    issueUrl: string;
  }): Promise<ResearchNoteBacklinkResultV1> {
    const current = await this.store.read(input.artifact.notePath);
    if (current.sha256 !== input.expectedNoteSha256) {
      throw new DiagramArtifactStoreError(
        "expected_hash_mismatch",
        "Research note changed before Linear backlink append.",
      );
    }
    const issueUrl = normalizeHttpsUrl(input.issueUrl);
    if (current.content.includes(issueUrl)) {
      return {
        path: current.path,
        operation: "no_op",
        beforeSha256: current.sha256,
        afterSha256: current.sha256,
        issueUrl,
        transaction: null,
      };
    }
    const identifier = boundedText(input.issueIdentifier, "issue identifier", 100);
    const backlink = `## Linear\n\n- [${escapeMarkdown(identifier)}](${issueUrl})`;
    const candidate = appendSection(current.content, backlink);
    const update = await this.store.update({
      path: current.path,
      expectedSha256: current.sha256,
      content: candidate,
      validator: ({ content }) => ({
        ok: content.includes(issueUrl) && content.includes(identifier),
        errors: ["Linear backlink was not persisted."],
      }),
    });
    if (update.status !== "committed" || !update.afterSha256) {
      throw new Error(update.error?.message ?? "Linear backlink append rolled back.");
    }
    return {
      path: current.path,
      operation: "append",
      beforeSha256: current.sha256,
      afterSha256: update.afterSha256,
      issueUrl,
      transaction: update,
    };
  }

  async appendGitHubCompletionLinks(input: {
    artifact: AcceptedResearchArtifactV1;
    expectedNoteSha256: string;
    pullRequestNumber: number;
    pullRequestUrl: string;
    mergeCommitUrl?: string;
    mergeSha?: string;
  }): Promise<ResearchNoteGitHubCompletionResultV1> {
    const current = await this.store.read(input.artifact.notePath);
    if (current.sha256 !== input.expectedNoteSha256) {
      throw new DiagramArtifactStoreError(
        "expected_hash_mismatch",
        "Research note changed before GitHub completion backlink append.",
      );
    }
    const pullRequestUrl = normalizeGitHubUrl(
      input.pullRequestUrl,
      "GitHub pull request URL",
    );
    if ((input.mergeCommitUrl === undefined) !== (input.mergeSha === undefined)) {
      throw new Error("GitHub publication links require both merge URL and merge SHA, or neither.");
    }
    const mergeCommitUrl = input.mergeCommitUrl === undefined
      ? null
      : normalizeGitHubUrl(input.mergeCommitUrl, "GitHub merge commit URL");
    const pullRequestNumber = positiveInteger(
      input.pullRequestNumber,
      "GitHub pull request number",
    );
    const mergeSha = input.mergeSha === undefined ? null : gitSha(input.mergeSha);
    if (
      current.content.includes(pullRequestUrl) &&
      (mergeCommitUrl === null || current.content.includes(mergeCommitUrl))
    ) {
      return {
        path: current.path,
        operation: "no_op",
        beforeSha256: current.sha256,
        afterSha256: current.sha256,
        pullRequestUrl,
        mergeCommitUrl,
        transaction: null,
      };
    }
    const backlink = [
      "## GitHub",
      "",
      `- [${mergeSha ? "Pull request" : "Draft pull request"} #${pullRequestNumber}](${pullRequestUrl})`,
      ...(mergeSha && mergeCommitUrl
        ? [`- [Merge commit \`${mergeSha.slice(0, 12)}\`](${mergeCommitUrl})`]
        : []),
    ].join("\n");
    const candidate = appendSection(current.content, backlink);
    const update = await this.store.update({
      path: current.path,
      expectedSha256: current.sha256,
      content: candidate,
      validator: ({ content }) => ({
        ok:
          content.includes(pullRequestUrl) &&
          (mergeCommitUrl === null || content.includes(mergeCommitUrl)) &&
          (mergeSha === null || content.includes(mergeSha.slice(0, 12))),
        errors: ["GitHub publication backlinks were not persisted."],
      }),
    });
    if (update.status !== "committed" || !update.afterSha256) {
      throw new Error(
        update.error?.message ?? "GitHub completion backlink append rolled back.",
      );
    }
    return {
      path: current.path,
      operation: "append",
      beforeSha256: current.sha256,
      afterSha256: update.afterSha256,
      pullRequestUrl,
      mergeCommitUrl,
      transaction: update,
    };
  }
}

export function renderAcceptedResearchNotePackageV1(
  input: AcceptedResearchNotePackageV1,
): string {
  const value = normalizePackage(input);
  const evidence = value.evidence.map((entry) => {
    const reference = entry.kind === "web"
      ? `[${escapeMarkdown(entry.label)}](${entry.reference})`
      : entry.kind === "vault"
        ? `[[${entry.reference}|${escapeMarkdown(entry.label)}]]`
        : `\`${escapeInline(entry.reference)}\``;
    return `- ${reference} — ${entry.summary} (evidence \`${entry.id}\`, \`${entry.contentSha256}\`)`;
  });
  const contract = {
    schemaVersion: 1,
    objective: value.objective,
    executionClass: value.executionClass,
    riskClass: value.riskClass,
    repositoryKey: value.repositoryKey ?? null,
    vaultBindingKey: value.vaultBindingKey,
    acceptanceCriteria: value.acceptanceCriteria,
    validationRequirementKeys: value.validationRequirementKeys,
    evidenceIds: value.evidence.map((entry) => entry.id),
    originRunId: value.originRunId,
  };
  return [
    `# ${value.title}`,
    "## Problem and impact",
    value.problemImpact,
    "## Evidence and source links",
    evidence.join("\n"),
    "## Confidence and limitations",
    value.confidenceLimitations,
    "## Proposed work",
    renderList(value.proposedWork),
    "## Non-goals",
    renderList(value.nonGoals, "No non-goals recorded."),
    "## Scope and dependencies",
    "### Scope",
    renderList(value.scope),
    "### Dependencies",
    renderList(value.dependencies, "No dependencies recorded."),
    "## Acceptance criteria",
    value.acceptanceCriteria
      .map((criterion) => `- [ ] **${criterion.id}** — ${criterion.text}`)
      .join("\n"),
    "## Validation requirements",
    renderList(value.validationRequirementKeys.map((key) => `\`${escapeInline(key)}\``)),
    "## Risk and execution class",
    `- Risk: \`${value.riskClass}\``,
    `- Execution class: \`${value.executionClass}\``,
    "## Machine contract",
    "```json",
    JSON.stringify(contract, null, 2),
    "```",
    "",
  ].join("\n\n");
}

function validateRenderedResearchNote(content: string, title: string): { ok: boolean; errors: string[] } {
  const required = [
    `# ${title}`,
    "## Problem and impact",
    "## Evidence and source links",
    "## Confidence and limitations",
    "## Proposed work",
    "## Non-goals",
    "## Scope and dependencies",
    "## Acceptance criteria",
    "## Validation requirements",
    "## Risk and execution class",
    "## Machine contract",
  ];
  const missing = required.filter((heading) => !content.includes(heading));
  return { ok: missing.length === 0, errors: missing.map((heading) => `Missing ${heading}.`) };
}

function normalizePackage(input: AcceptedResearchNotePackageV1): AcceptedResearchNotePackageV1 {
  if (!input || input.schemaVersion !== 1) throw new Error("Unsupported research note package version.");
  return {
    schemaVersion: 1,
    title: boundedText(input.title, "title", 240),
    problemImpact: boundedText(input.problemImpact, "problem and impact", MAX_SECTION_CHARS),
    evidence: normalizeEvidence(input.evidence),
    confidenceLimitations: boundedText(
      input.confidenceLimitations,
      "confidence and limitations",
      MAX_SECTION_CHARS,
    ),
    proposedWork: boundedList(input.proposedWork, "proposed work", 1),
    nonGoals: boundedList(input.nonGoals, "non-goals", 0),
    scope: boundedList(input.scope, "scope", 1),
    dependencies: boundedList(input.dependencies, "dependencies", 0),
    acceptanceCriteria: input.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    validationRequirementKeys: boundedList(
      input.validationRequirementKeys,
      "validation requirement keys",
      1,
    ),
    riskClass: input.riskClass,
    executionClass: input.executionClass,
    objective: boundedText(input.objective, "objective", 4_000),
    ...(input.repositoryKey
      ? { repositoryKey: boundedText(input.repositoryKey, "repository key", 128) }
      : {}),
    vaultBindingKey: boundedText(input.vaultBindingKey, "vault binding key", 128),
    originRunId: boundedText(input.originRunId, "origin run id", 160),
  };
}

function normalizeEvidence(
  value: AcceptedResearchEvidenceNoteEntryV1[],
): AcceptedResearchEvidenceNoteEntryV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new Error("Research note evidence requires 1-50 entries.");
  }
  return value.map((entry, index) => ({
    id: boundedText(entry.id, `evidence ${index + 1} id`, 80),
    kind: entry.kind,
    reference: boundedText(entry.reference, `evidence ${index + 1} reference`, 2_000),
    contentSha256: entry.contentSha256,
    label: boundedText(entry.label, `evidence ${index + 1} label`, 240),
    summary: boundedText(entry.summary, `evidence ${index + 1} summary`, 1_000),
  }));
}

function boundedList(value: string[], label: string, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAX_LIST_ENTRIES) {
    throw new Error(`${label} requires ${minimum}-${MAX_LIST_ENTRIES} entries.`);
  }
  return value.map((entry, index) => boundedText(entry, `${label} ${index + 1}`, 1_000));
}

function boundedText(value: unknown, label: string, maximum: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum || /[\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} must contain safe bounded text.`);
  }
  return normalized;
}

function appendSection(existing: string, section: string): string {
  return `${existing.replace(/\s*$/u, "")}\n\n${section.replace(/^\s*/u, "").replace(/\s*$/u, "")}\n`;
}

function renderList(values: readonly string[], empty = "No entries recorded."): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `_${empty}_`;
}

function normalizeHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Linear issue URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hostname !== "linear.app") {
    throw new Error("Linear issue URL must be an HTTPS linear.app URL without credentials.");
  }
  url.hash = "";
  return url.toString();
}

function normalizeGitHubUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname !== "github.com"
  ) {
    throw new Error(`${label} must be an HTTPS github.com URL without credentials.`);
  }
  url.hash = "";
  return url.toString();
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function gitSha(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    throw new Error("GitHub merge SHA is invalid.");
  }
  return value;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\[\]()*_`])/gu, "\\$1");
}

function escapeInline(value: string): string {
  return value.replace(/([`\\])/gu, "\\$1");
}
