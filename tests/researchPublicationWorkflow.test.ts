import assert from "node:assert/strict";
import test from "node:test";

import type { ActionReceipt, PreparedAction } from "../src/agent/actions";
import { sha256DiagramContent } from "../src/design/diagramArtifactStore";
import {
  AcceptedResearchNoteWriter,
  ResearchPublicationWorkflow,
  createWorkItemSpecV2,
  type AcceptedResearchNotePackageV1,
  type ResearchPublicationApprovalPortV1,
  type ResearchPublicationCheckpointV1,
  type ResearchPublicationPublisherPortV1,
  type ResearchPublicationRequestV1,
  type ResearchPublicationTraceStageV1,
  type ResearchTicketPreviewRequest,
  type ResearchTicketPublishRequest,
  type ResearchTicketWorkItemDraftV2,
  type LinearIssueRecord,
} from "../src/integrations/linear";
import type { ToolExecutionContext } from "../src/tools/types";
import { verifiedCodeReflectionFixture } from "./fixtures/verifiedCodeReflection";

const NOW = "2026-07-12T20:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;
const DESTINATION = {
  workspaceId: "workspace-acme",
  teamId: "team-eng",
  projectId: "project-agent-queue",
};

test("explicit research publication writes note, previews, exactly approves, publishes, persists lineage, then backlinks", async () => {
  const fixture = workflowFixture("created");
  const result = await fixture.workflow.execute(requestFixture());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.publication, "created");
  assert.equal(result.lineage.events.at(-1)?.state, "linear_verified");
  assert.equal(
    result.lineage.externalWorkItemBindingFingerprint,
    result.binding.bindingFingerprint,
  );
  assert.equal(result.binding.issueIdentifier, "ENG-42");
  assert.match(
    fixture.vault.files.get("Research/Agent platform.md") ?? "",
    /\[ENG-42\]\(https:\/\/linear\.app\/acme\/issue\/ENG-42\)/u,
  );
  assert.deepEqual(fixture.checkpoints.map((entry) => entry.status), [
    "note_written",
    "note_verified",
    "linear_verified",
    "complete",
  ]);
  assert.equal(fixture.publisher.publishCount, 1);
  assert.equal(fixture.publisher.mutationCount, 1);
  assert.deepEqual(
    fixture.publisher.lastPreviewSections?.scope,
    ["Obsidian to Linear handoff."],
  );
  assertOrdered(fixture.trace, [
    "note_verified",
    "linear_preview_verified",
    "note_lineage_persisted",
    "approval_requested",
    "approval_verified",
    "linear_publish_started",
    "linear_publish_verified",
    "linear_lineage_persisted",
    "backlink_started",
    "backlink_verified",
    "complete",
  ]);
});

test("denied exact approval leaves the accepted note byte-identical and performs no Linear mutation", async () => {
  const fixture = workflowFixture("created", { approved: false });
  const result = await fixture.workflow.execute(requestFixture());

  assert.equal(result.ok, false);
  assert.equal(result.status, "denied");
  const written = fixture.checkpoints[0];
  assert.ok(written);
  const bytesAtDenial = fixture.vault.files.get("Research/Agent platform.md") ?? "";
  assert.equal(await sha256DiagramContent(bytesAtDenial), written.artifact.noteSha256);
  assert.doesNotMatch(bytesAtDenial, /## Linear/u);
  assert.equal(fixture.publisher.publishCount, 0);
  assert.equal(fixture.publisher.mutationCount, 0);
  assert.deepEqual(fixture.checkpoints.map((entry) => entry.status), [
    "note_written",
    "note_verified",
    "approval_denied",
  ]);
});

test("deduplicated publication still persists binding and lineage and appends the existing issue backlink", async () => {
  const fixture = workflowFixture("deduplicated");
  const result = await fixture.workflow.execute(requestFixture());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.publication, "deduplicated");
  assert.equal(fixture.publisher.publishCount, 1);
  assert.equal(fixture.publisher.mutationCount, 0);
  assert.equal(result.binding.issueId, "issue-42");
  assert.equal(result.lineage.events.at(-1)?.receiptId, "linear-readback-issue-42");
  assert.equal(fixture.approvalRequests[0]?.proposedAction, "reuse_duplicate");
  assert.equal(fixture.checkpoints.at(-1)?.status, "complete");
  assert.match(
    fixture.vault.files.get("Research/Agent platform.md") ?? "",
    /https:\/\/linear\.app\/acme\/issue\/ENG-42/u,
  );
});

test("ambiguous Linear publication persists reconcile_required and never backlinks or retries", async () => {
  const fixture = workflowFixture("reconcile_required");
  const result = await fixture.workflow.execute(requestFixture());

  assert.equal(result.ok, false);
  assert.equal(result.status, "reconcile_required");
  if (result.status !== "reconcile_required") return;
  assert.equal(result.pendingAction.actionId, "prepared-issue-42");
  assert.equal(result.pendingAction.issueId, "issue-42");
  assert.equal(fixture.publisher.publishCount, 1);
  assert.equal(fixture.publisher.mutationCount, 1);
  assert.equal(fixture.checkpoints.at(-1)?.status, "reconcile_required");
  assert.equal(
    fixture.checkpoints.at(-1)?.pendingAction?.workItemFingerprint,
    fixture.checkpoints.find((entry) => entry.status === "note_verified")
      ?.workItemFingerprint,
  );
  assert.doesNotMatch(
    fixture.vault.files.get("Research/Agent platform.md") ?? "",
    /## Linear/u,
  );
  assert.equal(fixture.trace.includes("backlink_started"), false);
});

test("a checkpoint persist failure after issue creation resolves reconcile_required instead of orphaning the issue", async () => {
  // The Linear issue is created and readback-verified, then the linear_verified
  // checkpoint write throws (limit / CAS conflict / invalid transition / stale).
  // Previously execute() rejected, leaving a real issue with no binding, no
  // backlink, and no resumable checkpoint. It must now downgrade gracefully.
  const fixture = workflowFixture("created", { approved: true }, {
    failPersistOnStatus: "linear_verified",
  });
  const result = await fixture.workflow.execute(requestFixture());

  assert.equal(result.ok, false);
  assert.equal(result.status, "reconcile_required");
  if (result.status !== "reconcile_required") return;
  // The confirmed issue is surfaced for reconciliation rather than orphaned.
  assert.equal(result.issue?.identifier, "ENG-42");
  assert.equal(result.pendingAction.issueId, "issue-42");
  assert.equal(result.error.code, "research_publication_checkpoint_unpersisted");
  // The publish happened exactly once; the failure did not trigger a retry.
  assert.equal(fixture.publisher.mutationCount, 1);
  assert.ok(fixture.trace.includes("checkpoint_persist_failed"));
});

test("a checkpoint persist failure on the publish-failure path surfaces the publish cause, not the store error", async () => {
  // The publish itself is ambiguous (reconcile_required), then the checkpoint
  // persist for that failure also throws. The real cause must survive.
  const fixture = workflowFixture("reconcile_required", { approved: true }, {
    failPersistOnStatus: "reconcile_required",
  });
  const result = await fixture.workflow.execute(requestFixture());

  assert.equal(result.ok, false);
  assert.equal(result.status, "reconcile_required");
  if (result.status !== "reconcile_required") return;
  assert.equal(result.error.code, "linear_mutation_uncertain");
  assert.equal(result.pendingAction.issueId, "issue-42");
  assert.ok(fixture.trace.includes("checkpoint_persist_failed"));
});

test("a retry adopts the exact pending issue through fresh duplicate readback without rewriting the accepted note", async () => {
  const fixture = workflowFixture("reconcile_required");
  const first = await fixture.workflow.execute(requestFixture());
  assert.equal(first.status, "reconcile_required");
  assert.equal(
    fixture.checkpoints.at(-1)?.acceptedPackage?.title,
    "Agent platform gap closure",
  );
  fixture.publisher.mode = "deduplicated";

  const driftedRetry = requestFixture();
  driftedRetry.note.package.title =
    "A provider retry tried to replace the accepted research package";
  driftedRetry.note.package.objective =
    "A provider retry tried to change the accepted work item.";
  const second = await fixture.workflow.execute(driftedRetry);

  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.publication, "deduplicated");
  assert.equal(fixture.publisher.mutationCount, 1);
  assert.equal(
    fixture.checkpoints.filter((entry) => entry.status === "note_verified").length,
    1,
  );
  assert.deepEqual(fixture.checkpoints.map((entry) => entry.status), [
    "note_written",
    "note_verified",
    "reconcile_required",
    "linear_verified",
    "complete",
  ]);
  assert.equal(fixture.approvalRequests.at(-1)?.proposedAction, "reuse_duplicate");
  assert.equal(
    fixture.publisher.lastPreviewSections?.title,
    "Agent platform gap closure",
  );
  assert.match(
    fixture.vault.files.get("Research/Agent platform.md") ?? "",
    /https:\/\/linear\.app\/acme\/issue\/ENG-42/u,
  );
});

test("note-written checkpoint closes the restart window before Linear preview", async () => {
  const fixture = workflowFixture("created");
  fixture.publisher.failPreview = true;
  await assert.rejects(
    fixture.workflow.execute(requestFixture()),
    /simulated Linear preview interruption/u,
  );
  assert.deepEqual(
    fixture.checkpoints.map((entry) => entry.status),
    ["note_written"],
  );
  const acceptedBytes =
    fixture.vault.files.get("Research/Agent platform.md") ?? "";
  assert.match(acceptedBytes, /# Agent platform gap closure/u);

  fixture.publisher.failPreview = false;
  const providerDriftedRetry = requestFixture();
  providerDriftedRetry.note.package.title =
    "A restarted provider attempted to replace accepted research";
  const resumed = await fixture.workflow.execute(providerDriftedRetry);

  assert.equal(resumed.ok, true);
  assert.equal(fixture.publisher.mutationCount, 1);
  assert.equal(
    fixture.vault.files.get("Research/Agent platform.md")?.match(
      /# Agent platform gap closure/gu,
    )?.length,
    1,
  );
  assert.equal(
    fixture.publisher.lastPreviewSections?.title,
    "Agent platform gap closure",
  );
});

test("resume reuses the checkpoint-bound initiating note even when a different note is requested", async () => {
  const fixture = workflowFixture("reconcile_required");
  const initiatingPath = "Projects/Checkers idea.md";
  const initiatingContent = "# Checkers idea\n\nBuild a playable checkers application.\n";
  fixture.vault.files.set(initiatingPath, initiatingContent);
  const initialRequest: ResearchPublicationRequestV1 = {
    ...requestFixture(),
    note: {
      ...requestFixture().note,
      path: initiatingPath,
      mode: "append",
      baseHash: await sha256DiagramContent(initiatingContent),
    },
  };
  const first = await fixture.workflow.execute(initialRequest);
  assert.equal(first.status, "reconcile_required");
  assert.equal(fixture.checkpoints.at(-1)?.artifact.notePath, initiatingPath);
  const acceptedBytes = fixture.vault.files.get(initiatingPath) ?? "";

  fixture.publisher.mode = "deduplicated";
  const resumed = await fixture.workflow.execute({
    ...initialRequest,
    note: {
      ...initialRequest.note,
      path: "Research/Model redirected.md",
      mode: "create",
      baseHash: undefined,
    },
  });

  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.artifact.notePath, initiatingPath);
  assert.equal(resumed.backlink.path, initiatingPath);
  assert.equal(fixture.vault.files.has("Research/Model redirected.md"), false);
  const completedBytes = fixture.vault.files.get(initiatingPath) ?? "";
  assert.equal(completedBytes.match(/## Problem and impact/gu)?.length, 1);
  assert.equal(completedBytes.match(/agentic-accepted-research:/gu)?.length, 1);
  assert.ok(completedBytes.length > acceptedBytes.length);
  assert.match(completedBytes, /https:\/\/linear\.app\/acme\/issue\/ENG-42/u);

  const reflection = await new AcceptedResearchNoteWriter(
    fixture.vault,
  ).appendProjectCompletionReflection({
    artifact: resumed.artifact,
    expectedNoteSha256: resumed.backlink.afterSha256,
    publicationId: "github-publication-checkers-42",
    issueIdentifier: resumed.issue.identifier,
    issueUrl: resumed.issue.url,
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/acme/checkers/pull/42",
    completionProof: "draft_pr",
    proofRevision: "b".repeat(40),
    changedPaths: ["src/checkers.ts", "tests/checkers.test.ts"],
    targetedValidationReceiptId: "checkers-targeted-validation",
    fullValidationReceiptId: "checkers-full-validation",
    localCommitReceiptId: "checkers-local-commit",
    codeHandoffFingerprint:
      verifiedCodeReflectionFixture("b".repeat(40)).handoff.fingerprint,
    codeExamples:
      verifiedCodeReflectionFixture("b".repeat(40)).examples,
  });
  assert.equal(reflection.path, initiatingPath);
  assert.match(
    fixture.vault.files.get(initiatingPath) ?? "",
    /agentic-project-reflection:github-publication-checkers-42/u,
  );
  assert.equal(fixture.vault.files.has("Research/Model redirected.md"), false);
});

test("resume blocks on initiating-note drift before writing a redirected path", async () => {
  const fixture = workflowFixture("reconcile_required");
  const initiatingPath = "Projects/Checkers source.md";
  const initiatingContent = "# Checkers source\n";
  fixture.vault.files.set(initiatingPath, initiatingContent);
  const initialRequest: ResearchPublicationRequestV1 = {
    ...requestFixture(),
    note: {
      ...requestFixture().note,
      path: initiatingPath,
      mode: "append",
      baseHash: await sha256DiagramContent(initiatingContent),
    },
  };
  const first = await fixture.workflow.execute(initialRequest);
  assert.equal(first.status, "reconcile_required");
  fixture.vault.files.set(
    initiatingPath,
    `${fixture.vault.files.get(initiatingPath) ?? ""}\nUser edit after checkpoint.\n`,
  );
  const driftedBytes = fixture.vault.files.get(initiatingPath);

  fixture.publisher.mode = "deduplicated";
  await assert.rejects(
    fixture.workflow.execute({
      ...initialRequest,
      note: {
        ...initialRequest.note,
        path: "Research/Redirected after drift.md",
        mode: "create",
        baseHash: undefined,
      },
    }),
    /changed before publication resume readback/iu,
  );
  assert.equal(fixture.vault.files.get(initiatingPath), driftedBytes);
  assert.equal(fixture.vault.files.has("Research/Redirected after drift.md"), false);
  assert.equal(fixture.publisher.publishCount, 1);
});

test("backlink failure persists waiting_obsidian after verified Linear lineage without recreating the issue", async () => {
  const fixture = workflowFixture("created");
  fixture.vault.failLinearBacklinkWrites = true;
  const result = await fixture.workflow.execute(requestFixture());

  assert.equal(result.ok, false);
  assert.equal(result.status, "waiting_obsidian");
  if (result.status !== "waiting_obsidian") return;
  assert.equal(result.lineage.events.at(-1)?.state, "linear_verified");
  assert.equal(result.binding.issueId, "issue-42");
  assert.equal(fixture.publisher.publishCount, 1);
  assert.equal(fixture.publisher.mutationCount, 1);
  assert.deepEqual(fixture.checkpoints.map((entry) => entry.status), [
    "note_written",
    "note_verified",
    "linear_verified",
    "waiting_obsidian",
  ]);
  assert.doesNotMatch(
    fixture.vault.files.get("Research/Agent platform.md") ?? "",
    /## Linear/u,
  );
});

test("non-explicit research is rejected before note, preview, approval, or Linear work", async () => {
  const fixture = workflowFixture("created");
  await assert.rejects(
    fixture.workflow.execute({ ...requestFixture(), explicitUserMission: false }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "research_publication_explicit_user_mission_required",
  );
  assert.equal(fixture.vault.files.size, 0);
  assert.equal(fixture.publisher.previewCount, 0);
  assert.equal(fixture.approvalRequests.length, 0);
  assert.equal(fixture.checkpoints.length, 0);
});

function workflowFixture(
  mode: "created" | "deduplicated" | "reconcile_required",
  decision: { approved: boolean } = { approved: true },
  options: { failPersistOnStatus?: ResearchPublicationCheckpointV1["status"] } = {},
) {
  const vault = new ResearchVault();
  const noteWriter = new AcceptedResearchNoteWriter(vault, {
    now: () => new Date(NOW),
  });
  const checkpoints: ResearchPublicationCheckpointV1[] = [];
  const trace: ResearchPublicationTraceStageV1[] = [];
  const approvalRequests: Parameters<ResearchPublicationApprovalPortV1["requestExactApproval"]>[0][] = [];
  const publisher = new FakePublisher(mode);
  const workflow = new ResearchPublicationWorkflow({
    noteWriter,
    publisher,
    approval: {
      requestExactApproval: async (request) => {
        approvalRequests.push(request);
        return decision.approved
          ? {
              approved: true,
              approvalId: "approval-publish-1",
              approvalFingerprint: request.approvalFingerprint,
              preferredGrantId: "grant-publish-1",
            }
          : { approved: false, reason: "User denied Linear publication." };
      },
    },
    lineage: {
      get: async (publicationId) =>
        structuredClone(
          [...checkpoints]
            .reverse()
            .find((checkpoint) => checkpoint.publicationId === publicationId) ?? null,
        ),
      persist: async (checkpoint) => {
        if (
          options.failPersistOnStatus &&
          checkpoint.status === options.failPersistOnStatus
        ) {
          // Model the real store throwing (limit / CAS conflict / invalid
          // transition / stale) on this exact transition.
          throw new Error(
            `research_publication_checkpoint_conflict at ${checkpoint.status}`,
          );
        }
        checkpoints.push(structuredClone(checkpoint));
      },
    },
    now: () => new Date(NOW),
    trace: (event) => trace.push(event.stage),
  });
  return { vault, workflow, publisher, checkpoints, trace, approvalRequests };
}

class FakePublisher implements ResearchPublicationPublisherPortV1 {
  previewCount = 0;
  publishCount = 0;
  mutationCount = 0;
  failPreview = false;
  private ticket: ReturnType<typeof ticketFromRequest> | null = null;
  lastPreviewSections: ResearchTicketPreviewRequest["sections"] | null = null;

  constructor(
    public mode: "created" | "deduplicated" | "reconcile_required",
  ) {}

  async preview(request: ResearchTicketPreviewRequest) {
    this.previewCount += 1;
    if (this.failPreview) {
      throw new Error("simulated Linear preview interruption");
    }
    this.lastPreviewSections = structuredClone(request.sections);
    const ticket = ticketFromRequest(request);
    this.ticket = ticket;
    const duplicate = this.mode === "deduplicated" ? issue(ticket.description) : null;
    return {
      ok: true as const,
      status: duplicate ? "deduplicated" as const : "create" as const,
      ticket,
      duplicate,
      candidatesExamined: duplicate ? 1 : 0,
    };
  }

  async publish(request: ResearchTicketPublishRequest) {
    this.publishCount += 1;
    const ticket = ticketFromRequest(request);
    assert.equal(ticket.spec.fingerprint, this.ticket?.spec.fingerprint);
    const issue_ = issue(ticket.description);
    if (this.mode === "deduplicated") {
      return {
        ok: true as const,
        status: "deduplicated" as const,
        ticket,
        issue: issue_,
        candidatesExamined: 1,
      };
    }
    const action = preparedAction(ticket.spec.fingerprint);
    this.mutationCount += 1;
    if (this.mode === "reconcile_required") {
      return {
        ok: false as const,
        status: "reconcile_required" as const,
        error: {
          code: "linear_mutation_uncertain",
          message: "The Linear response was ambiguous.",
        },
        ticket,
        action,
        grantId: "grant-publish-1",
        candidatesExamined: 0,
      };
    }
    return {
      ok: true as const,
      status: "created" as const,
      ticket,
      issue: issue_,
      action,
      receipt: receipt(action),
      grantId: "grant-publish-1",
      candidatesExamined: 0,
    };
  }

  async readIssue() {
    return issue(this.ticket?.description ?? "");
  }
}

function ticketFromRequest(
  request: ResearchTicketPreviewRequest | ResearchTicketPublishRequest,
) {
  const draft = request.draft as ResearchTicketWorkItemDraftV2;
  const spec = createWorkItemSpecV2(draft);
  return {
    spec,
    title: request.sections.title,
    description: JSON.stringify(spec),
    deterministicIssueId: "issue-42",
  };
}

function requestFixture(): ResearchPublicationRequestV1 {
  return {
    explicitUserMission: true,
    runId: "run-42",
    toolCallId: "publish-1",
    subject: { type: "run", id: "run-42" },
    context: contextFixture(),
    note: {
      path: "Research/Agent platform.md",
      mode: "create",
      artifactId: "accepted-research-run-42",
      acceptedAt: NOW,
      package: packageFixture(),
    },
    destination: DESTINATION,
  };
}

function packageFixture(): AcceptedResearchNotePackageV1 {
  return {
    schemaVersion: 1,
    title: "Agent platform gap closure",
    problemImpact: "The current handoff must remain exact and auditable.",
    evidence: [{
      id: "evidence-web-1",
      kind: "web",
      reference: "https://example.test/evidence",
      contentSha256: HASH,
      label: "Primary evidence",
      summary: "The source supports the accepted implementation scope.",
    }],
    confidenceLimitations: "High confidence; live provider smoke testing remains separate.",
    proposedWork: ["Publish one deduplicated execution contract."],
    nonGoals: ["Automatic merge."],
    scope: ["Obsidian to Linear handoff."],
    dependencies: ["Connected Linear workspace."],
    acceptanceCriteria: [{ id: "AC-1", text: "The note exists before Linear mutation." }],
    validationRequirementKeys: ["tests.unit"],
    riskClass: "medium",
    executionClass: "code",
    objective: "Implement the accepted agent platform work item.",
    repositoryKey: "agentic-researcher",
    vaultBindingKey: "primary-vault",
    originRunId: "run-42",
  };
}

function issue(description: string): LinearIssueRecord {
  return {
    resourceType: "issue",
    id: "issue-42",
    identifier: "ENG-42",
    url: "https://linear.app/acme/issue/ENG-42",
    title: "Agent platform gap closure",
    description,
    priority: 0,
    trashed: false,
    team: { id: DESTINATION.teamId, name: "Engineering" },
    project: { id: DESTINATION.projectId, name: "Agent queue" },
    state: { id: "state-ready", name: "Ready", type: "unstarted" },
    labels: [],
    createdAt: NOW,
    updatedAt: NOW,
    snapshotHash: HASH,
  };
}

function preparedAction(payloadFingerprint: string): PreparedAction {
  return {
    version: 1,
    id: "prepared-issue-42",
    runId: "run-42",
    toolCallId: "publish-1",
    toolName: "linear_create_issue",
    target: {
      system: "linear",
      resourceType: "issue",
      id: "issue-42",
      teamId: DESTINATION.teamId,
      projectId: DESTINATION.projectId,
    },
    relatedResources: [],
    normalizedArgs: {},
    preview: {
      summary: "Create Linear issue",
      destination: DESTINATION.projectId,
      warnings: [],
      outboundBytes: 100,
    },
    payloadFingerprint,
    idempotencyKey: "issue:issue-42",
    preparedAt: NOW,
    expiresAt: "2026-07-12T20:05:00.000Z",
  };
}

function receipt(action: PreparedAction): ActionReceipt {
  return {
    version: 1,
    id: "receipt-issue-42",
    runId: action.runId,
    actionId: action.id,
    toolName: action.toolName,
    operation: "create",
    resource: action.target,
    message: "Created and verified Linear issue.",
    payloadFingerprint: action.payloadFingerprint,
    grantId: "grant-publish-1",
    idempotencyKey: action.idempotencyKey,
    startedAt: NOW,
    committedAt: NOW,
    commitKind: "committed",
    readback: { status: "verified", checkedAt: NOW },
  };
}

function contextFixture(): ToolExecutionContext {
  return {
    runId: "run-42",
    operationId: "publish-1",
    now: () => new Date(NOW),
    httpTransport: async () => ({ status: 500, headers: {} }),
  } as unknown as ToolExecutionContext;
}

function assertOrdered(
  actual: readonly ResearchPublicationTraceStageV1[],
  expected: readonly ResearchPublicationTraceStageV1[],
): void {
  let previous = -1;
  for (const stage of expected) {
    const index = actual.indexOf(stage);
    assert.ok(index > previous, `${stage} must follow ${String(actual[previous])}.`);
    previous = index;
  }
}

class ResearchVault {
  readonly files = new Map<string, string>();
  readonly folders = new Set(["Research", ".agent-backups"]);
  readonly adapterFiles = new Map<string, string>();
  failLinearBacklinkWrites = false;
  readonly adapter = {
    exists: async (path: string) => this.adapterFiles.has(path) || this.folders.has(path),
    mkdir: async (path: string) => {
      this.folders.add(path);
    },
    read: async (path: string) => {
      const content = this.adapterFiles.get(path);
      if (content === undefined) throw new Error(`Missing adapter file: ${path}`);
      return content;
    },
    write: async (path: string, content: string) => {
      this.adapterFiles.set(path, content);
    },
    remove: async (path: string) => {
      this.adapterFiles.delete(path);
    },
  };

  getAbstractFileByPath(path: string) {
    return this.files.has(path) || this.folders.has(path) ? { path } : null;
  }
  getFileByPath(path: string) {
    return this.files.has(path) ? { path } : null;
  }
  getFolderByPath(path: string) {
    return this.folders.has(path) ? { path } : null;
  }
  async create(path: string, content: string) {
    if (this.getAbstractFileByPath(path)) {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    }
    this.files.set(path, content);
    return { path };
  }
  async read(file: { path: string }) {
    const content = this.files.get(file.path);
    if (content === undefined) throw new Error("missing");
    return content;
  }
  async modify(file: { path: string }, content: string) {
    if (!this.files.has(file.path)) throw new Error("missing");
    if (this.failLinearBacklinkWrites && content.includes("## Linear")) {
      throw new Error("Obsidian is disconnected before backlink write.");
    }
    this.files.set(file.path, content);
  }
  async trash(file: { path: string }) {
    this.files.delete(file.path);
  }
  async delete(file: { path: string }) {
    this.files.delete(file.path);
  }
}
