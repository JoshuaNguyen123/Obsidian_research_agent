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
    "note_verified",
    "linear_verified",
    "complete",
  ]);
  assert.equal(fixture.publisher.publishCount, 1);
  assert.equal(fixture.publisher.mutationCount, 1);
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
    fixture.checkpoints[0]?.workItemFingerprint,
  );
  assert.doesNotMatch(
    fixture.vault.files.get("Research/Agent platform.md") ?? "",
    /## Linear/u,
  );
  assert.equal(fixture.trace.includes("backlink_started"), false);
});

test("a retry adopts the exact pending issue through fresh duplicate readback without rewriting the accepted note", async () => {
  const fixture = workflowFixture("reconcile_required");
  const first = await fixture.workflow.execute(requestFixture());
  assert.equal(first.status, "reconcile_required");
  fixture.publisher.mode = "deduplicated";

  const second = await fixture.workflow.execute(requestFixture());

  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.publication, "deduplicated");
  assert.equal(fixture.publisher.mutationCount, 1);
  assert.equal(
    fixture.checkpoints.filter((entry) => entry.status === "note_verified").length,
    1,
  );
  assert.deepEqual(fixture.checkpoints.map((entry) => entry.status), [
    "note_verified",
    "reconcile_required",
    "linear_verified",
    "complete",
  ]);
  assert.equal(fixture.approvalRequests.at(-1)?.proposedAction, "reuse_duplicate");
  assert.match(
    fixture.vault.files.get("Research/Agent platform.md") ?? "",
    /https:\/\/linear\.app\/acme\/issue\/ENG-42/u,
  );
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
  private ticket: ReturnType<typeof ticketFromRequest> | null = null;

  constructor(
    public mode: "created" | "deduplicated" | "reconcile_required",
  ) {}

  async preview(request: ResearchTicketPreviewRequest) {
    this.previewCount += 1;
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
