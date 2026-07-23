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
  operation: "create" | "append" | "no_op";
  beforeSha256: string | null;
  afterSha256: string;
  noteReceiptId: string;
  artifact: AcceptedResearchArtifactV1;
  transaction: DiagramArtifactCreateTransactionReceipt | DiagramArtifactUpdateReceipt | null;
}

export interface AcceptedResearchNoteReadRequestV1 {
  artifact: AcceptedResearchArtifactV1;
  package: AcceptedResearchNotePackageV1;
  /** Exact checkpoint-bound note revision expected before a resume proceeds. */
  expectedNoteSha256: string;
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

export interface ResearchNoteProjectReflectionResultV1
  extends ResearchNoteGitHubCompletionResultV1 {
  issueUrl: string;
  publicationId: string;
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
    const renderedPackage = renderAcceptedResearchNotePackageV1(normalized);
    const marker = acceptedResearchMarker(request.artifactId);
    const rendered = `${marker}\n${renderedPackage}`;
    let beforeSha256: string | null = null;
    let afterSha256: string;
    let operation: "create" | "append" | "no_op";
    let transaction: DiagramArtifactCreateTransactionReceipt | DiagramArtifactUpdateReceipt | null;

    if (request.mode === "create") {
      let existing = null;
      try {
        existing = await this.store.read(request.path);
      } catch (error) {
        if (!(error instanceof DiagramArtifactStoreError && error.code === "artifact_not_found")) {
          throw error;
        }
      }
      if (existing) {
        if (existing.content !== rendered) {
          throw new DiagramArtifactStoreError(
            "path_exists",
            `Accepted research note cannot overwrite changed content: ${existing.path}.`,
          );
        }
        const validation = validateRenderedResearchNote(existing.content, normalized.title);
        if (!validation.ok) {
          throw new DiagramArtifactStoreError(
            "validation_failed",
            validation.errors.join(" ") || "Accepted research note readback is invalid.",
          );
        }
        operation = "no_op";
        beforeSha256 = existing.sha256;
        afterSha256 = existing.sha256;
        transaction = null;
      } else {
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
      }
    } else {
      const current = await this.store.read(request.path);
      beforeSha256 = current.sha256;
      if (current.content.includes(marker)) {
        if (!current.content.includes(rendered.replace(/\s*$/u, ""))) {
          throw new DiagramArtifactStoreError(
            "validation_failed",
            "Accepted research marker collides with different or incomplete content.",
          );
        }
        operation = "no_op";
        afterSha256 = current.sha256;
        transaction = null;
      } else if (!request.baseHash || request.baseHash !== current.sha256) {
        throw new DiagramArtifactStoreError(
          "expected_hash_mismatch",
          "Accepted research note changed before append.",
        );
      } else {
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

  /**
   * Re-read a checkpoint-bound accepted package without repeating its write.
   * The exact note revision and persisted package bytes must still match before
   * Linear reconciliation or any later resume step is allowed to continue.
   */
  async readAcceptedPackage(
    request: AcceptedResearchNoteReadRequestV1,
  ): Promise<AcceptedResearchNoteWriteResultV1> {
    const current = await this.store.read(request.artifact.notePath);
    if (current.sha256 !== request.expectedNoteSha256) {
      throw new DiagramArtifactStoreError(
        "expected_hash_mismatch",
        "Initiating research note changed before publication resume readback.",
      );
    }
    const normalized = normalizePackage(request.package);
    const rendered = renderAcceptedResearchNotePackageV1(normalized);
    const marker = acceptedResearchMarker(request.artifact.artifactId);
    if (!current.content.includes(rendered.replace(/\s*$/u, ""))) {
      throw new DiagramArtifactStoreError(
        "validation_failed",
        "The checkpoint-bound initiating note no longer contains the accepted research package.",
      );
    }
    // Older accepted notes did not carry the marker. Exact package-byte
    // readback keeps those checkpoints resumable; all new writes carry it.
    if (current.content.includes("<!-- agentic-accepted-research:") &&
        !current.content.includes(marker)) {
      throw new DiagramArtifactStoreError(
        "validation_failed",
        "The initiating note is bound to a different accepted research artifact.",
      );
    }
    return {
      path: current.path,
      operation: "no_op",
      beforeSha256: current.sha256,
      afterSha256: current.sha256,
      noteReceiptId: request.artifact.noteReceiptId,
      artifact: request.artifact,
      transaction: null,
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

  /**
   * Final, append-once project reflection. It records verified handoff evidence
   * in the accepted research note instead of treating links alone as closure.
   */
  async appendProjectCompletionReflection(input: {
    artifact: AcceptedResearchArtifactV1;
    expectedNoteSha256: string;
    publicationId: string;
    issueIdentifier: string;
    issueUrl: string;
    pullRequestNumber: number;
    pullRequestUrl: string;
    completionProof: "draft_pr" | "merged_pr";
    proofRevision: string;
    changedPaths: string[];
    targetedValidationReceiptId: string;
    fullValidationReceiptId: string;
    localCommitReceiptId: string;
    mergeCommitUrl?: string;
    mergeSha?: string;
  }): Promise<ResearchNoteProjectReflectionResultV1> {
    const current = await this.store.read(input.artifact.notePath);
    if (current.sha256 !== input.expectedNoteSha256) {
      throw new DiagramArtifactStoreError(
        "expected_hash_mismatch",
        "Research note changed before project completion reflection append.",
      );
    }
    const publicationId = markerId(input.publicationId);
    const marker = `<!-- agentic-project-reflection:${publicationId} -->`;
    const issueUrl = normalizeHttpsUrl(input.issueUrl);
    const issueIdentifier = boundedText(input.issueIdentifier, "issue identifier", 100);
    const pullRequestUrl = normalizeGitHubUrl(
      input.pullRequestUrl,
      "GitHub pull request URL",
    );
    const pullRequestNumber = positiveInteger(
      input.pullRequestNumber,
      "GitHub pull request number",
    );
    if ((input.mergeCommitUrl === undefined) !== (input.mergeSha === undefined)) {
      throw new Error("Project reflection requires both merge URL and merge SHA, or neither.");
    }
    if (input.completionProof === "merged_pr" && !input.mergeSha) {
      throw new Error("Merged project reflection requires verified merge proof.");
    }
    const mergeCommitUrl = input.mergeCommitUrl === undefined
      ? null
      : normalizeGitHubUrl(input.mergeCommitUrl, "GitHub merge commit URL");
    const mergeSha = input.mergeSha === undefined ? null : gitSha(input.mergeSha);
    const proofRevision = gitSha(input.proofRevision);
    const changedPaths = boundedRepositoryPaths(input.changedPaths);
    const targetedReceipt = boundedText(
      input.targetedValidationReceiptId,
      "targeted validation receipt ID",
      240,
    );
    const fullReceipt = boundedText(
      input.fullValidationReceiptId,
      "full validation receipt ID",
      240,
    );
    const commitReceipt = boundedText(
      input.localCommitReceiptId,
      "local commit receipt ID",
      240,
    );
    if (current.content.includes(marker)) {
      const expectedProof = [
        issueUrl,
        pullRequestUrl,
        proofRevision,
        targetedReceipt,
        fullReceipt,
        commitReceipt,
        ...changedPaths,
        ...(mergeCommitUrl ? [mergeCommitUrl] : []),
        ...(mergeSha ? [mergeSha] : []),
      ];
      if (!expectedProof.every((value) => current.content.includes(value))) {
        throw new DiagramArtifactStoreError(
          "validation_failed",
          "Project reflection marker collides with different or incomplete proof.",
        );
      }
      return {
        path: current.path,
        operation: "no_op",
        beforeSha256: current.sha256,
        afterSha256: current.sha256,
        issueUrl,
        publicationId,
        pullRequestUrl,
        mergeCommitUrl,
        transaction: null,
      };
    }
    const deliveryState = input.completionProof === "merged_pr"
      ? "Merged after verified checks and provider readback."
      : "Published as a verified draft pull request for human review.";
    const remaining = input.completionProof === "merged_pr"
      ? "No publication blocker remains in this pipeline run. Follow-up product learning is separate work."
      : "Human review and merge remain outside this completed draft-publication proof.";
    const acceptanceCriteria = input.artifact.acceptanceCriteria.map(
      (criterion) => `- **${escapeMarkdown(criterion.id)}:** ${criterion.text}`,
    );
    const reflection = [
      "## Agent project reflection",
      marker,
      "",
      "### Outcome",
      "",
      `- ${deliveryState}`,
      `- Linear source: [${escapeMarkdown(issueIdentifier)}](${issueUrl})`,
      `- GitHub proof: [pull request #${pullRequestNumber}](${pullRequestUrl})`,
      `- Verified revision: \`${proofRevision}\``,
      ...(mergeSha && mergeCommitUrl
        ? [`- Verified merge: [\`${mergeSha}\`](${mergeCommitUrl})`]
        : []),
      "",
      "### Delivered scope",
      "",
      ...changedPaths.map((path) => `- \`${escapeInline(path)}\``),
      "",
      "### Acceptance criteria carried through the execution contract",
      "",
      ...acceptanceCriteria,
      "",
      "### Verification receipts",
      "",
      `- Targeted validation: \`${escapeInline(targetedReceipt)}\``,
      `- Full validation: \`${escapeInline(fullReceipt)}\``,
      `- Verified local commit: \`${escapeInline(commitReceipt)}\``,
      "",
      "### Reflection",
      "",
      "- What worked: the accepted research artifact, Linear work item, repository changes, validations, and GitHub proof stayed linked by durable identifiers and readbacks.",
      `- Remaining limitation: ${remaining}`,
    ].join("\n");
    const candidate = appendSection(current.content, reflection);
    const update = await this.store.update({
      path: current.path,
      expectedSha256: current.sha256,
      content: candidate,
      validator: ({ content }) => ({
        ok:
          content.includes(marker) &&
          content.includes(issueUrl) &&
          content.includes(pullRequestUrl) &&
          content.includes(proofRevision) &&
          content.includes(targetedReceipt) &&
          content.includes(fullReceipt) &&
          content.includes(commitReceipt),
        errors: ["Project completion reflection was not persisted with its proof."],
      }),
    });
    if (update.status !== "committed" || !update.afterSha256) {
      throw new Error(update.error?.message ?? "Project completion reflection append rolled back.");
    }
    return {
      path: current.path,
      operation: "append",
      beforeSha256: current.sha256,
      afterSha256: update.afterSha256,
      issueUrl,
      publicationId,
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

function markerId(value: unknown): string {
  const normalized = boundedText(value, "publication ID", 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized) || normalized.includes("--")) {
    throw new Error("publication ID is not safe for a reflection marker.");
  }
  return normalized;
}

function acceptedResearchMarker(artifactId: unknown): string {
  return `<!-- agentic-accepted-research:${markerId(artifactId)} -->`;
}

function boundedRepositoryPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LIST_ENTRIES) {
    throw new Error(`changed paths require 1-${MAX_LIST_ENTRIES} entries.`);
  }
  const normalized = value.map((entry, index) => {
    const path = boundedText(entry, `changed path ${index + 1}`, 500);
    if (
      path.includes("\\") ||
      path.startsWith("/") ||
      /^[A-Za-z]:/u.test(path) ||
      path.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("changed paths must be safe repository-relative paths.");
    }
    return path;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("changed paths must be unique.");
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
