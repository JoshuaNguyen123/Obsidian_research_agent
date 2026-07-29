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
  type AcceptedResearchEvidenceKindV1,
} from "./AcceptedResearchArtifactV1";
import {
  assertExactKeys,
  DurableLinearContractError,
  expectEnum,
  expectLogicalKey,
  expectOpaqueId,
  expectPlainRecord,
  expectSha256,
  expectString,
  parseHttpUrl,
  parseVaultMarkdownPath,
} from "./LinearContractSupport";
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

/**
 * Strict durable-boundary parser for the complete package that produced an
 * accepted research note. Publication retries must not ask the provider to
 * recreate these bytes: the canonical package is checkpoint state.
 */
export function parseAcceptedResearchNotePackageV1(
  value: unknown,
): AcceptedResearchNotePackageV1 {
  const record = expectPlainRecord(value, "accepted research note package");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "title",
      "problemImpact",
      "evidence",
      "confidenceLimitations",
      "proposedWork",
      "nonGoals",
      "scope",
      "dependencies",
      "acceptanceCriteria",
      "validationRequirementKeys",
      "riskClass",
      "executionClass",
      "objective",
      "vaultBindingKey",
      "originRunId",
    ],
    ["repositoryKey"],
    "accepted research note package",
  );
  if (record.schemaVersion !== 1) {
    throw new DurableLinearContractError(
      "Unsupported accepted research note package version.",
    );
  }
  const executionClass = expectEnum(
    record.executionClass,
    "accepted research execution class",
    ["research", "vault", "code", "human"] as const,
  );
  const repositoryKey = record.repositoryKey === undefined
    ? undefined
    : expectLogicalKey(record.repositoryKey, "accepted research repository key", 128);
  if ((executionClass === "code") !== (repositoryKey !== undefined)) {
    throw new DurableLinearContractError(
      "Accepted code research requires one repository key, and other execution classes must omit it.",
    );
  }
  const normalized = normalizePackage({
    schemaVersion: 1,
    title: expectPackageText(record.title, "accepted research title", 240),
    problemImpact: expectPackageText(
      record.problemImpact,
      "accepted research problem and impact",
      MAX_SECTION_CHARS,
    ),
    evidence: parseAcceptedResearchEvidenceNoteEntries(record.evidence),
    confidenceLimitations: expectPackageText(
      record.confidenceLimitations,
      "accepted research confidence and limitations",
      MAX_SECTION_CHARS,
    ),
    proposedWork: parseAcceptedResearchStringList(
      record.proposedWork,
      "accepted research proposed work",
      1,
    ),
    nonGoals: parseAcceptedResearchStringList(
      record.nonGoals,
      "accepted research non-goals",
      0,
    ),
    scope: parseAcceptedResearchStringList(
      record.scope,
      "accepted research scope",
      1,
    ),
    dependencies: parseAcceptedResearchStringList(
      record.dependencies,
      "accepted research dependencies",
      0,
    ),
    acceptanceCriteria: parseAcceptedResearchCriteria(record.acceptanceCriteria),
    validationRequirementKeys: parseAcceptedResearchValidationKeys(
      record.validationRequirementKeys,
    ),
    riskClass: expectEnum(
      record.riskClass,
      "accepted research risk class",
      ["low", "medium", "high"] as const,
    ),
    executionClass,
    objective: expectPackageText(
      record.objective,
      "accepted research objective",
      4_000,
    ),
    ...(repositoryKey ? { repositoryKey } : {}),
    vaultBindingKey: expectLogicalKey(
      record.vaultBindingKey,
      "accepted research vault binding key",
      128,
    ),
    originRunId: expectOpaqueId(
      record.originRunId,
      "accepted research origin run id",
      160,
    ),
  });

  // Reuse the signed artifact contract to validate evidence references,
  // criterion authority boundaries, and the risk class before persistence.
  createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "accepted-research-package-validation",
    originRunId: normalized.originRunId,
    vaultBindingKey: normalized.vaultBindingKey,
    notePath: "Accepted research package validation.md",
    noteSha256: `sha256:${"0".repeat(64)}`,
    noteReceiptId: "accepted-research-package-validation",
    evidence: normalized.evidence.map(
      ({ id, kind, reference, contentSha256 }) => ({
        id,
        kind,
        reference,
        contentSha256,
      }),
    ),
    acceptanceCriteria: normalized.acceptanceCriteria,
    riskClass: normalized.riskClass,
    acceptedAt: "2000-01-01T00:00:00.000Z",
    acceptedBy: "host",
  });
  return normalized;
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
    const proofMetadata = [
      "<!-- agentic-project-proof:v1",
      `issue-url: ${encodeURIComponent(issueUrl)}`,
      `pull-request-url: ${encodeURIComponent(pullRequestUrl)}`,
      `proof-revision: ${encodeURIComponent(proofRevision)}`,
      `targeted-validation-receipt: ${encodeURIComponent(targetedReceipt)}`,
      `full-validation-receipt: ${encodeURIComponent(fullReceipt)}`,
      `local-commit-receipt: ${encodeURIComponent(commitReceipt)}`,
      ...changedPaths.map((path) => `changed-path: ${encodeURIComponent(path)}`),
      ...(mergeCommitUrl
        ? [`merge-commit-url: ${encodeURIComponent(mergeCommitUrl)}`]
        : []),
      ...(mergeSha ? [`merge-sha: ${encodeURIComponent(mergeSha)}`] : []),
      "-->",
    ].join("\n");
    const exactProofBlock = `${marker}\n${proofMetadata}`;
    if (current.content.includes(marker)) {
      if (!current.content.includes(exactProofBlock)) {
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
    const criterionCount = input.artifact.acceptanceCriteria.length;
    const primaryCriterion = input.artifact.acceptanceCriteria[0]?.text
      ? reflectionCriterionExcerpt(input.artifact.acceptanceCriteria[0].text)
      : null;
    const remainingCriteria = Math.max(0, criterionCount - 1);
    const outcomeSentence = primaryCriterion
      ? `The leading accepted outcome was: ${escapeMarkdown(
        primaryCriterion.replace(/[.!?]+$/u, ""),
      )}${
        remainingCriteria > 0
          ? `; ${remainingCriteria} additional requirement${
            remainingCriteria === 1 ? " was" : "s were"
          } also checked`
          : ""
      }.`
      : "The change was checked against its accepted scope.";
    const publicationSentence = input.completionProof === "merged_pr"
      ? `The result was merged through [pull request #${pullRequestNumber}](${pullRequestUrl})${
        mergeCommitUrl ? ` at the [verified commit](${mergeCommitUrl})` : ""
      }.`
      : `The result is ready for human review in [draft pull request #${pullRequestNumber}](${pullRequestUrl}).`;
    const closureSentence = input.completionProof === "merged_pr"
      ? "The merge is complete; deployment and future product learning remain separate work."
      : "The published evidence stops at this draft; review, merge, and any later deployment remain open.";
    const reflection = [
      "## Agent project reflection",
      exactProofBlock,
      "",
      `Research in [Linear issue ${escapeMarkdown(issueIdentifier)}](${issueUrl}) became a tested code change at revision \`${proofRevision.slice(0, 12)}\`.`,
      "Targeted and full validation passed.",
      outcomeSentence,
      publicationSentence,
      closureSentence,
    ].join("\n");
    const candidate = appendSection(current.content, reflection);
    const update = await this.store.update({
      path: current.path,
      expectedSha256: current.sha256,
      content: candidate,
      validator: ({ content }) => ({
        ok:
          content.includes(exactProofBlock) &&
          content.includes(issueUrl) &&
          content.includes(pullRequestUrl),
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

function parseAcceptedResearchEvidenceNoteEntries(
  value: unknown,
): AcceptedResearchEvidenceNoteEntryV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LIST_ENTRIES) {
    throw new DurableLinearContractError(
      `Accepted research evidence requires 1-${MAX_LIST_ENTRIES} entries.`,
    );
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const label = `accepted research evidence ${index + 1}`;
    const record = expectPlainRecord(entry, label);
    assertExactKeys(
      record,
      ["id", "kind", "reference", "contentSha256", "label", "summary"],
      [],
      label,
    );
    const id = expectLogicalKey(record.id, `${label} id`, 80);
    if (ids.has(id)) {
      throw new DurableLinearContractError(`Accepted research evidence id ${id} is duplicated.`);
    }
    ids.add(id);
    const kind = expectEnum<AcceptedResearchEvidenceKindV1>(
      record.kind,
      `${label} kind`,
      ["web", "vault", "user"],
    );
    const reference = kind === "web"
      ? parseHttpUrl(record.reference, `${label} reference`)
      : kind === "vault"
        ? parseVaultMarkdownPath(record.reference, `${label} reference`)
        : expectOpaqueId(record.reference, `${label} reference`, 160);
    return {
      id,
      kind,
      reference,
      contentSha256: expectSha256(record.contentSha256, `${label} content hash`),
      label: expectPackageText(record.label, `${label} label`, 240),
      summary: expectPackageText(record.summary, `${label} summary`, 1_000),
    };
  });
}

function parseAcceptedResearchCriteria(
  value: unknown,
): WorkItemAcceptanceCriterionV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new DurableLinearContractError(
      "Accepted research acceptance criteria require 1-20 entries.",
    );
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const label = `accepted research criterion ${index + 1}`;
    const record = expectPlainRecord(entry, label);
    assertExactKeys(record, ["id", "text"], [], label);
    if (typeof record.id !== "string" || !/^AC-[1-9][0-9]?$/u.test(record.id)) {
      throw new DurableLinearContractError(
        `${label} id must match AC-1 through AC-99.`,
      );
    }
    if (ids.has(record.id)) {
      throw new DurableLinearContractError(
        `Accepted research criterion id ${record.id} is duplicated.`,
      );
    }
    ids.add(record.id);
    return {
      id: record.id,
      text: expectPackageText(record.text, `${label} text`, 500),
    };
  });
}

function parseAcceptedResearchStringList(
  value: unknown,
  label: string,
  minimum: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAX_LIST_ENTRIES) {
    throw new DurableLinearContractError(
      `${label} requires ${minimum}-${MAX_LIST_ENTRIES} entries.`,
    );
  }
  return value.map((entry, index) =>
    expectPackageText(entry, `${label} ${index + 1}`, 1_000));
}

function parseAcceptedResearchValidationKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LIST_ENTRIES) {
    throw new DurableLinearContractError(
      `Accepted research validation keys require 1-${MAX_LIST_ENTRIES} entries.`,
    );
  }
  const parsed = value.map((entry, index) =>
    expectLogicalKey(entry, `accepted research validation key ${index + 1}`, 160));
  return parsed;
}

function expectPackageText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  return expectString(value, label, 1, maximum, {
    allowNewlines: true,
    secretFree: true,
  });
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

function reflectionCriterionExcerpt(value: string): string {
  const plain = value
    .replace(/\s+/gu, " ")
    .replace(/[#*_`~<>\[\]]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const words = plain.split(" ").filter(Boolean);
  const wordBounded = words.slice(0, 24).join(" ");
  const characterBounded = wordBounded.length > 240
    ? `${wordBounded.slice(0, 239).trimEnd()}…`
    : wordBounded;
  const truncated = words.length > 24 || wordBounded.length > 240;
  return truncated && !characterBounded.endsWith("…")
    ? `${characterBounded.replace(/[.!?]+$/u, "")}…`
    : characterBounded;
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
