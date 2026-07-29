import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  verifyPreparedActionFingerprint,
  type ActionReceipt,
} from "../src/agent/actions";
import type { AuthorityGrantV1 } from "../src/agent/authority";
import {
  sha256DiagramContent,
  type DiagramArtifactUpdateReceipt,
} from "../src/design/diagramArtifactStore";
import {
  appendVerifiedExternalActionReceipt,
  createAcceptedResearchArtifactV1,
  createExternalActionReceiptLedgerState,
  createWorkItemSpecV2,
  renderQueueExecutableHumanWorkItemSpecV2,
  type AcceptedResearchNoteReadRequestV1,
  type AcceptedResearchNoteWriteRequestV1,
  type LinearIssueRecord,
  type ResearchPublicationCheckpointV1,
  type ResearchPublicationPublisherPortV1,
  type ResearchTicketPreviewRequest,
  type ResearchTicketPublishRequest,
  type ResearchTicketWorkItemDraftV2,
} from "../src/integrations/linear";
import {
  createResearchPublicationTool,
  hasExplicitResearchPublicationIntent,
  resolveResearchPublicationNotePathV1,
  trustedValidationKeysForProfileV1,
} from "../src/tools/researchPublicationTool";
import { DefaultToolRegistry } from "../src/tools/ToolRegistry";
import type { ToolExecutionContext } from "../src/tools/types";
import { isCompletedAcceptedResearchPublicationReceipt } from "../src/agent/setLooseCompoundAutonomy";

const NOW = "2026-07-12T20:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;
const INITIAL_LINEAR_RECEIPT_HASH = `sha256:${"c".repeat(64)}`;
const DESTINATION = { workspaceId: "workspace-1", teamId: "team-1", projectId: "project-1" };

test("research publication intent is clause-local across later GitHub prohibitions", () => {
  const phaseA = [
    "Deeply research a small dependency-free Python CRDT library for marker BYOK_AUTONOMOUS_unit.",
    "Use and fetch at least four independent sources exposed through the configured research backend. Reconcile their guidance on state-based G-Counter joins and observed-remove sets, including convergence, idempotence, concurrent add versus remove, and practical validation.",
    "Write accepted research into the initiating note as a concise but substantive implementation brief, then publish that accepted research to one Linear implementation issue in the configured destination.",
    "The accepted package is executable code work for trusted repository key byok-autonomous-python and validation requirement key byok-autonomous-python-validation.",
    "The issue must carry the source citations and behavioral acceptance contract: a GCounter supports replica-local non-negative increments, value, and convergent pointwise-max merge; an ORSet supports add, observed remove, value, union-style merge, concurrent add survival, and convergence after all tags are observed and removed.",
    "Require the public implementation and README to carry proof marker BYOK_AUTONOMOUS_unit, but leave filenames, internal design, workspace identity, and implementation choices to the coding agent.",
    "Do not implement code or publish to GitHub in this phase. Finish only after accepted-research lineage, Linear provider readback, and the note backlink are durable.",
  ].join(" ");
  assert.equal(hasExplicitResearchPublicationIntent(phaseA), true);
  assert.equal(
    hasExplicitResearchPublicationIntent(
      "Do not publish the accepted research report to Linear.",
    ),
    false,
  );
});

test("host uses the one explicit mission note path instead of a model transcription", () => {
  assert.equal(
    resolveResearchPublicationNotePathV1({
      requestedPath: "Research.md",
      originalPrompt:
        "Write the accepted research into E2E Agent Tests/DU06-checkers.md with citations.",
      runId: "run-42",
    }),
    "E2E Agent Tests/DU06-checkers.md",
  );
});

test("host requires an exact selection when the mission names multiple note paths", () => {
  const originalPrompt =
    "Read Projects/Checkers/Input.md, then write the accepted research to Projects/Checkers/Research.md.";
  assert.throws(
    () => resolveResearchPublicationNotePathV1({
      requestedPath: "Projects/Checkers/Draft.md",
      originalPrompt,
      runId: "run-42",
    }),
    /does not exactly match any safe Markdown path/iu,
  );
  assert.equal(
    resolveResearchPublicationNotePathV1({
      requestedPath: "projects/checkers/research.md",
      originalPrompt,
      runId: "run-42",
    }),
    "Projects/Checkers/Research.md",
  );
});

test("host keeps the deterministic path fallback for a pathless create mission", () => {
  assert.equal(
    resolveResearchPublicationNotePathV1({
      originalPrompt: "Publish the accepted research report to Linear.",
      runId: "run:42",
    }),
    "Accepted research run-42.md",
  );
});

test("host binds a pathless publication to the trusted initiating note", () => {
  assert.equal(
    resolveResearchPublicationNotePathV1({
      initiatingNotePath: "Projects/Checkers.md",
      originalPrompt: "Publish the accepted research report from this note to Linear.",
      runId: "run:42",
    }),
    "Projects/Checkers.md",
  );
  assert.throws(
    () => resolveResearchPublicationNotePathV1({
      initiatingNotePath: "Projects/Checkers.md",
      requestedPath: "Accepted research elsewhere.md",
      originalPrompt: "Publish the accepted research report to Linear.",
      runId: "run:42",
    }),
    /differs from the trusted initiating Obsidian note/iu,
  );
});

test("composite publication captures the active note and host hash as an append binding", async () => {
  const fixture = createFixture("created");
  const context = contextFixture(
    "Publish the accepted research report from this note to Linear.",
    "run-active-note",
    "call-active-note",
  );
  const initiatingContent = "# Checkers idea\n\nBuild a complete playable game.\n";
  const initiatingFile = { path: "Projects/Checkers.md", extension: "md" };
  context.getCurrentMarkdownFile = () => initiatingFile as never;
  context.app = {
    vault: {
      read: async () => initiatingContent,
    },
  } as never;
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-active-note",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: argsFixture({ notePath: undefined }) },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(fixture.noteWrites[0]?.path, "Projects/Checkers.md");
  assert.equal(fixture.noteWrites[0]?.mode, "append");
  assert.equal(
    fixture.noteWrites[0]?.baseHash,
    await sha256DiagramContent(initiatingContent),
  );
  assert.equal(
    fixture.checkpoints.at(-1)?.artifact.notePath,
    "Projects/Checkers.md",
  );
});

test("active-note publication ignores a model path redirect and writes only the host-bound note", async () => {
  const fixture = createFixture("created");
  const context = contextFixture(
    "Publish the accepted research report from this initiating note to Linear.",
    "run-active-note-redirect",
    "call-active-note-redirect",
  );
  const initiatingContent = "# Trusted initiating note\n";
  const initiatingFile = {
    path: "Projects/Trusted initiating note.md",
    extension: "md",
  };
  context.getCurrentMarkdownFile = () => initiatingFile as never;
  context.app = {
    vault: { read: async () => initiatingContent },
  } as never;
  context.requestNestedApproval = approveNested;

  const result = await fixture.tool.execute(argsFixture(), context) as {
    ok: boolean;
  };

  assert.equal(result.ok, true);
  assert.equal(fixture.noteWrites.length, 1);
  assert.equal(fixture.noteWrites[0]?.path, initiatingFile.path);
  assert.equal(fixture.noteWrites[0]?.mode, "append");
  assert.equal(
    fixture.noteWrites[0]?.baseHash,
    await sha256DiagramContent(initiatingContent),
  );
  assert.equal(
    fixture.noteWrites.some((request) => request.path === "Published.md"),
    false,
  );
});

test("checkpoint resume ignores newly active note and keeps the original note binding", async () => {
  const fixture = createFixture("reconcile_required", { resumeCheckpoints: true });
  const firstContext = contextFixture(
    "Publish the accepted research report from this note to Linear.",
    "run-checkpoint-resume",
    "call-checkpoint-first",
  );
  const noteA = { path: "Projects/Checkers A.md", extension: "md" };
  firstContext.getCurrentMarkdownFile = () => noteA as never;
  firstContext.app = {
    vault: { read: async () => "# Checkers A\n\nOriginal mission note.\n" },
  } as never;
  firstContext.requestNestedApproval = approveNested;

  await assert.rejects(
    fixture.tool.execute(argsFixture({ notePath: undefined }), firstContext),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "linear_mutation_uncertain",
  );
  assert.equal(fixture.noteWrites[0]?.path, noteA.path);
  assert.equal(fixture.checkpoints.at(-1)?.status, "reconcile_required");

  fixture.publisher.mode = "deduplicated";
  let noteBReads = 0;
  const secondContext = contextFixture(
    "Publish the accepted research report to Linear; resume the prior attempt.",
    "run-checkpoint-resume",
    "call-checkpoint-second",
  );
  const noteB = { path: "Projects/Unrelated B.md", extension: "md" };
  secondContext.getCurrentMarkdownFile = () => noteB as never;
  secondContext.app = {
    vault: {
      read: async () => {
        noteBReads += 1;
        throw new Error("The active editor must not be consulted during resume.");
      },
    },
  } as never;
  secondContext.requestNestedApproval = approveNested;

  const providerDriftedRetry = {
    unexpectedProviderRetryField:
      "A checkpointed retry must not depend on provider argument shape.",
  };
  const resumed = await fixture.tool.execute(
    providerDriftedRetry,
    secondContext,
  ) as { ok: boolean; artifact: { notePath: string } };

  assert.equal(resumed.ok, true);
  assert.equal(resumed.artifact.notePath, noteA.path);
  assert.equal(noteBReads, 0);
  assert.equal(fixture.noteWrites.length, 1);
  assert.equal(fixture.resumeReads.length, 1);
  assert.equal(fixture.resumeReads[0]?.artifact.notePath, noteA.path);
  assert.equal(fixture.resumeReads[0]?.package.title, "Accepted research");
  assert.equal(
    fixture.resumeReads[0]?.expectedNoteSha256,
    fixture.checkpoints[0]?.artifact.noteSha256,
  );
  assert.equal(
    fixture.noteWrites.some((request) => request.path === noteB.path),
    false,
  );
});

test("continuation segments replay one root-bound completed publication without another Linear mutation", async () => {
  const fixture = createFixture("created", { resumeCheckpoints: true });
  const registry = new DefaultToolRegistry([fixture.tool]);
  const rootRunId = "run-publication-root";
  const firstContext = contextFixture(
    "Publish this accepted research to one Linear issue in Published.md.",
    "run-publication-segment-1",
    "call-publication-segment-1",
  );
  firstContext.rootMissionId = rootRunId;
  firstContext.requestNestedApproval = approveNested;

  const first = await registry.execute(
    { name: "publish_research_to_linear", arguments: argsFixture() },
    firstContext,
  );
  assert.equal(first.ok, true);
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...(first.receipt ?? {}),
      output: first.output,
    }),
    true,
    "the created provider receipt and the later full issue readback must restore composite proof",
  );
  const checkpointCount = fixture.checkpoints.length;
  const completed = fixture.checkpoints.at(-1);
  assert.equal(completed?.status, "complete");
  assert.equal(completed?.artifact.originRunId, rootRunId);
  assert.equal(new Set(fixture.checkpoints.map((item) => item.publicationId)).size, 1);

  const noteContent = "# Published research\n\nVerified Linear backlink.\n";
  const currentNoteSha256 = await sha256DiagramContent(noteContent);
  assert.ok(completed?.backlink);
  completed.backlink.afterSha256 = currentNoteSha256;

  const secondContext = contextFixture(
    "Continue the same mission and publish the accepted research to exactly one Linear issue.",
    "run-publication-segment-2",
    "call-publication-segment-2",
  );
  secondContext.rootMissionId = rootRunId;
  secondContext.app = {
    vault: {
      getFileByPath: () => ({ path: "Published.md", extension: "md" }),
      read: async () => noteContent,
    },
  } as never;
  secondContext.requestNestedApproval = async () => {
    throw new Error("A completed root-bound publication must not request approval again.");
  };

  const replayed = await registry.execute(
    { name: "publish_research_to_linear", arguments: argsFixture() },
    secondContext,
  );

  assert.equal(replayed.ok, true, JSON.stringify(replayed));
  assert.equal((replayed.output as any).publication, "deduplicated");
  assert.equal((replayed.output as any).artifact.originRunId, rootRunId);
  assert.equal((replayed.output as any).note.operation, "no_op");
  assert.equal(replayed.receipt?.operation, "read");
  assert.equal(replayed.receipt?.runId, secondContext.runId);
  assert.equal(
    replayed.receipt?.actionId,
    `linear-readback-${secondContext.operationId}`,
  );
  assert.equal(replayed.receipt?.startedAt, NOW);
  assert.equal(replayed.receipt?.readback.checkedAt, NOW);
  assert.equal(replayed.receipt?.committedAt, NOW);
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...(replayed.receipt ?? {}),
      output: replayed.output,
    }),
    true,
  );
  assert.equal(fixture.providerReadCount, 1);
  assert.equal(fixture.noteWrites.length, 1);
  assert.equal(fixture.checkpoints.length, checkpointCount);
  assert.equal(fixture.grants.length, 1);
  assert.equal(fixture.persistedReceipts.length, 2);

  fixture.publisher.readbackDescriptionOverride = "# Contract removed";
  const thirdContext = contextFixture(
    "Continue the same mission and publish the accepted research to exactly one Linear issue.",
    "run-publication-segment-3",
    "call-publication-segment-3",
  );
  thirdContext.rootMissionId = rootRunId;
  thirdContext.app = secondContext.app;
  thirdContext.requestNestedApproval = secondContext.requestNestedApproval;
  const rejectedReplay = await registry.execute(
    { name: "publish_research_to_linear", arguments: argsFixture() },
    thirdContext,
  );
  assert.equal(rejectedReplay.ok, false);
  assert.equal(
    rejectedReplay.error?.code,
    "research_publication_checkpoint_readback_mismatch",
  );
  assert.equal(fixture.providerReadCount, 2);
  assert.equal(fixture.noteWrites.length, 1);
  assert.equal(fixture.checkpoints.length, checkpointCount);
  assert.equal(fixture.grants.length, 1);
  assert.equal(fixture.persistedReceipts.length, 2);
});

test("advancing-time same-call dedup replay emits distinct ledger-safe receipt ids", async () => {
  const fixture = createFixture("deduplicated", { resumeCheckpoints: true });
  const registry = new DefaultToolRegistry([fixture.tool]);
  let observedAt = NOW;
  const context = contextFixture(
    "Publish this accepted research to one Linear issue in Published.md.",
    "run-dedup-receipt-replay",
    "call-dedup-receipt-replay",
  );
  context.now = () => new Date(observedAt);
  context.requestNestedApproval = approveNested;

  const initial = await registry.execute(
    { name: "publish_research_to_linear", arguments: argsFixture() },
    context,
  );
  assert.equal(initial.ok, true, JSON.stringify(initial));
  const completed = fixture.checkpoints.at(-1);
  assert.equal(completed?.status, "complete");

  const noteContent = "# Published research\n\nVerified Linear backlink.\n";
  const currentNoteSha256 = await sha256DiagramContent(noteContent);
  assert.ok(completed?.backlink);
  completed.backlink.afterSha256 = currentNoteSha256;
  context.app = {
    vault: {
      getFileByPath: () => ({ path: "Published.md", extension: "md" }),
      read: async () => noteContent,
    },
  } as never;
  context.requestNestedApproval = async () => {
    throw new Error("A completed publication must not request approval again.");
  };

  observedAt = "2026-07-12T20:05:00.000Z";
  const replayed = await registry.execute(
    { name: "publish_research_to_linear", arguments: argsFixture() },
    context,
  );
  assert.equal(replayed.ok, true, JSON.stringify(replayed));
  assert.equal(fixture.persistedReceipts.length, 2);

  const [initialReceipt, replayReceipt] = fixture.persistedReceipts;
  assert.ok(initialReceipt);
  assert.ok(replayReceipt);
  assert.match(
    initialReceipt.id,
    /^linear-research-readback-[a-f0-9]{64}$/u,
  );
  assert.match(
    replayReceipt.id,
    /^linear-research-readback-[a-f0-9]{64}$/u,
  );
  assert.notEqual(initialReceipt.id, replayReceipt.id);
  assert.equal(initialReceipt.committedAt, NOW);
  assert.equal(replayReceipt.committedAt, observedAt);

  let ledger = createExternalActionReceiptLedgerState(
    new Date("2026-07-12T19:59:00.000Z"),
  );
  ledger = appendVerifiedExternalActionReceipt(ledger, {
    expectedRevision: 0,
    receipt: initialReceipt,
    recordedAt: "2026-07-12T20:00:01.000Z",
  });
  ledger = appendVerifiedExternalActionReceipt(ledger, {
    expectedRevision: 1,
    receipt: replayReceipt,
    recordedAt: "2026-07-12T20:05:01.000Z",
  });
  assert.equal(ledger.entries.length, 2);
  assert.deepEqual(
    ledger.entries.map((entry) => entry.receipt.id),
    [initialReceipt.id, replayReceipt.id],
  );
});

test("checkpoint identity mismatch fails before consulting a newly active note", async () => {
  const fixture = createFixture("reconcile_required", { resumeCheckpoints: true });
  const firstContext = contextFixture(
    "Publish the accepted research report from this note to Linear.",
    "run-checkpoint-identity",
    "call-checkpoint-identity-first",
  );
  const noteA = { path: "Projects/Identity A.md", extension: "md" };
  firstContext.getCurrentMarkdownFile = () => noteA as never;
  firstContext.app = {
    vault: { read: async () => "# Identity A\n" },
  } as never;
  firstContext.requestNestedApproval = approveNested;
  await assert.rejects(
    fixture.tool.execute(argsFixture({ notePath: undefined }), firstContext),
  );
  const checkpoint = fixture.checkpoints.at(-1);
  assert.ok(checkpoint);
  checkpoint.artifact.originRunId = "different-run";

  let noteBReads = 0;
  const secondContext = contextFixture(
    "Publish the accepted research report to Linear; resume the prior attempt.",
    "run-checkpoint-identity",
    "call-checkpoint-identity-second",
  );
  secondContext.getCurrentMarkdownFile = () => ({
    path: "Projects/Identity B.md",
    extension: "md",
  }) as never;
  secondContext.app = {
    vault: {
      read: async () => {
        noteBReads += 1;
        return "# Identity B\n";
      },
    },
  } as never;

  await assert.rejects(
    fixture.tool.execute(argsFixture({ notePath: undefined }), secondContext),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "research_publication_checkpoint_identity_invalid",
  );
  assert.equal(noteBReads, 0);
  assert.equal(fixture.noteWrites.length, 1);
});

test("composite publication uses host lineage/bindings, exact UI approval, one grant, and canonical receipt", async () => {
  const fixture = createFixture("created");
  const context = contextFixture("Publish this research to Linear in Published.md", "run:42", "tool:call:1");
  const approvals: PreparedApproval[] = [];
  context.requestNestedApproval = async (request) => {
    approvals.push({ fingerprint: request.preparedAction?.payloadFingerprint ?? "", request });
    return {
      approved: true,
      approvalId: "approval-1",
      approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
    };
  };

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: argsFixture() },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(fixture.noteWrites.length, 1);
  assert.equal(fixture.noteWrites[0].package.originRunId, "run:42");
  assert.equal(fixture.noteWrites[0].package.vaultBindingKey, "current-vault");
  assert.doesNotMatch(fixture.noteWrites[0].artifactId, /:/u);
  assert.equal(fixture.noteWrites[0].path, "Published.md");
  assert.equal(approvals.length, 1);
  assert.doesNotThrow(() => canonicalJson(approvals[0].request.preparedAction));
  assert.equal(
    await verifyPreparedActionFingerprint(approvals[0].request.preparedAction!),
    true,
  );
  assert.equal(approvals[0].request.preparedAction?.preview.outboundPayload?.title, "Accepted research");
  assert.equal(approvals[0].fingerprint, approvals[0].request.preparedAction?.payloadFingerprint);
  assert.equal(fixture.grants.length, 1);
  assert.equal(fixture.persistedReceipts.length, 1);
  assert.equal(result.receipt?.id, "receipt-created");
  assert.equal(result.receipt, fixture.persistedReceipts[0]);
  assert.equal(fixture.publisher.lastActiveGrantCount, 1);
});

test("exact duplicate publishes with no mutation grant and emits verified readback proof", async () => {
  const fixture = createFixture("deduplicated");
  const context = contextFixture("Send this research report to Linear", "run-42", "call-1");
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-dedup",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: argsFixture({ notePath: undefined }) },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(fixture.grants.length, 0);
  assert.equal(fixture.publisher.lastActiveGrantCount, 0);
  assert.equal(result.receipt?.operation, "read");
  assert.equal(result.receipt?.toolName, "linear_read_issue");
  assert.equal(result.receipt?.grantId, "linear-deduplicated-readback");
  assert.equal(fixture.persistedReceipts.length, 1);
});

test("a deduplicated receipt joins its observed approval through the shared idempotency key", async () => {
  const fixture = createFixture("deduplicated");
  const context = contextFixture(
    "Send this research report to Linear",
    "run-43",
    "call-dedup-fingerprint",
  );
  let approvalIdempotencyKey = "";
  context.requestNestedApproval = async (request) => {
    approvalIdempotencyKey = request.preparedAction?.idempotencyKey ?? "";
    return {
      approved: true,
      approvalId: "approval-dedup-fingerprint",
      approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
    };
  };

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: argsFixture({ notePath: undefined }) },
    context,
  );

  assert.equal(result.ok, true);
  assert.match(
    approvalIdempotencyKey,
    /^research-publication:sha256:[a-f0-9]{64}$/u,
    "the approval preview must carry the content-bound publication identity",
  );
  assert.equal(
    result.receipt?.idempotencyKey,
    approvalIdempotencyKey,
    "the synthesized dedup receipt must join the observed approval by identity",
  );
  assert.equal(
    result.receipt?.payloadFingerprint,
    (result.output as { approvalFingerprint?: string }).approvalFingerprint,
    "the durable composite-proof contract pins the workflow fingerprint",
  );
});

test("equivalent V1 schema labels are canonicalized before accepted publication", async (t) => {
  for (const schemaVersion of ["1", "v1", "Version 1", "1.0"]) {
    await t.test(schemaVersion, async () => {
      const fixture = createFixture("created");
      const context = contextFixture(
        "Publish this research to Linear in Published.md",
        "run:42",
        "tool:call:string-schema",
      );
      context.requestNestedApproval = async (request) => ({
        approved: true,
        approvalId: "approval-string-schema",
        approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
      });
      const args = argsFixture();
      (args.package as Record<string, unknown>).schemaVersion = schemaVersion;

      const result = await new DefaultToolRegistry([fixture.tool]).execute(
        { name: "publish_research_to_linear", arguments: args },
        context,
      );

      assert.equal(result.ok, true);
      assert.equal(fixture.noteWrites[0]?.package.schemaVersion, 1);
    });
  }
});

test("research publication mode schema documents exact non-overwriting labels", () => {
  const parameters = createFixture("created").tool.parameters;
  const mode = parameters.properties?.mode;
  const baseHash = parameters.properties?.baseHash;
  const packageSchema = parameters.properties?.package;
  assert.deepEqual(mode?.enum, ["create", "append"]);
  assert.match(String(mode?.description ?? ""), /create never overwrites/u);
  assert.match(String(mode?.description ?? ""), /Never use write, overwrite, upsert/u);
  assert.match(String(baseHash?.description ?? ""), /Omit entirely for create/u);
  assert.match(String(baseHash?.description ?? ""), /never send an empty placeholder/u);
  assert.equal(packageSchema?.properties?.proposedWork?.minItems, 1);
  assert.equal(packageSchema?.properties?.scope?.minItems, 1);
  assert.equal(packageSchema?.properties?.acceptanceCriteria?.minItems, 1);
  assert.equal(packageSchema?.properties?.validationRequirementKeys?.minItems, 1);
  assert.equal(packageSchema?.properties?.nonGoals?.minItems, undefined);
  assert.equal(packageSchema?.properties?.dependencies?.minItems, undefined);
});

test("create canonicalizes an empty optional base hash while append rejects it", async () => {
  const createFixture_ = createFixture("created");
  const createArgs = argsFixture();
  createArgs.baseHash = "";
  const createContext = contextFixture(
    "Publish this research to Linear in Published.md",
  );
  createContext.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-empty-create-base-hash",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });
  const createResult = await new DefaultToolRegistry([createFixture_.tool]).execute(
    { name: "publish_research_to_linear", arguments: createArgs },
    createContext,
  );
  assert.equal(createResult.ok, true);
  assert.equal(createFixture_.noteWrites[0]?.baseHash, undefined);

  const appendFixture = createFixture("created");
  const appendArgs = argsFixture();
  appendArgs.mode = "append";
  appendArgs.baseHash = "";
  const appendResult = await new DefaultToolRegistry([appendFixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: appendArgs },
    contextFixture(
      "Publish this research to Linear by appending it in Published.md",
    ),
  );
  assert.equal(appendResult.ok, false);
  assert.equal(appendResult.error?.code, "research_publication_base_hash_required");
});

test("host derives missing package identifiers from canonical evidence and order", async () => {
  const fixture = createFixture("created");
  const args = argsFixture();
  const package_ = args.package as Record<string, unknown>;
  const evidence = package_.evidence as Array<Record<string, unknown>>;
  evidence[0].id = "invalid evidence id with spaces";
  const criteria = package_.acceptanceCriteria as Array<Record<string, unknown>>;
  criteria[0].id = "criterion one";
  const context = contextFixture(
    "Publish this research to Linear in Published.md",
  );
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-host-derived-identifiers",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(
    fixture.noteWrites[0]?.package.evidence[0]?.id,
    `evidence-${"a".repeat(64)}`,
  );
  assert.equal(fixture.noteWrites[0]?.package.acceptanceCriteria[0]?.id, "AC-1");
});

test("host derives a missing package objective from the title", async () => {
  const fixture = createFixture("created");
  const args = argsFixture();
  const package_ = args.package as Record<string, unknown>;
  delete package_.objective;
  const context = contextFixture(
    "Publish this research to Linear in Published.md",
  );
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-host-derived-objective",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(
    fixture.noteWrites[0]?.package.objective,
    "Deliver the accepted research for: Accepted research",
  );
});

test("an empty proposed-work array fails at the pre-mutation tool boundary", async () => {
  const fixture = createFixture("created");
  const args = argsFixture();
  const package_ = args.package as Record<string, unknown>;
  package_.proposedWork = [];
  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    contextFixture("Publish this research to Linear in Published.md"),
  );

  assert.equal(result.ok, false);
  assert.equal(
    result.error?.code,
    "research_publication_invalid_arguments",
  );
  assert.match(result.error?.message ?? "", /proposed work requires 1-50/iu);
  assert.equal(result.mutationState, "not_applied");
  assert.equal(fixture.noteWrites.length, 0);
});

test("host losslessly canonicalizes a scalar proposed-work entry", async () => {
  const fixture = createFixture("created");
  const args = argsFixture();
  const package_ = args.package as Record<string, unknown>;
  package_.proposedWork = "Implement the accepted behavior.";
  const context = contextFixture(
    "Publish this research to Linear in Published.md",
  );
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-host-canonical-proposed-work",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(fixture.noteWrites[0]?.package.proposedWork, [
    "Implement the accepted behavior.",
  ]);
});

test("invalid proposed-work shapes fail at the tool boundary with repairable schema code", async () => {
  const fixture = createFixture("created");
  const args = argsFixture();
  const package_ = args.package as Record<string, unknown>;
  package_.proposedWork = { text: "not an array" };
  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    contextFixture("Publish this research to Linear in Published.md"),
  );

  assert.equal(result.ok, false);
  assert.equal(
    result.error?.code,
    "research_publication_invalid_arguments",
  );
  assert.match(result.error?.message ?? "", /proposed work requires 1-50/iu);
  assert.equal(result.mutationState, "not_applied");
  assert.equal(fixture.noteWrites.length, 0);
});

test("same-run publication retry reuses the first validated package and stable artifact identity", async () => {
  const fixture = createFixture("created");
  const context = contextFixture(
    "Publish this research to Linear in Published.md",
  );
  context.runtimeCache = { toolResults: new Map() };
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-stable-publication-retry",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });
  const firstArgs = argsFixture();
  const secondArgs = argsFixture();
  (secondArgs.package as Record<string, unknown>).title =
    "A later model response tried to rewrite accepted research";

  await fixture.tool.execute(firstArgs, context);
  context.operationId = "call-2";
  await fixture.tool.execute(secondArgs, context);

  assert.equal(fixture.noteWrites.length, 2);
  assert.equal(fixture.noteWrites[1]?.package.title, "Accepted research");
  assert.equal(
    fixture.noteWrites[1]?.artifactId,
    fixture.noteWrites[0]?.artifactId,
  );
  assert.notEqual(
    fixture.noteWrites[1]?.artifactId,
    `accepted-${context.runId}-${context.operationId}`,
  );
});

test("host canonicalizes bounded string acceptance criteria from compatible models", async () => {
  const fixture = createFixture("created");
  const args = argsFixture();
  const package_ = args.package as Record<string, unknown>;
  package_.acceptanceCriteria = [
    "A legal multi-jump continues until no further capture is available.",
    "The focused Python tests pass.",
  ];
  const context = contextFixture(
    "Publish this research to Linear in Published.md",
  );
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-string-criteria",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(fixture.noteWrites[0]?.package.acceptanceCriteria, [
    {
      id: "AC-1",
      text: "A legal multi-jump continues until no further capture is available.",
    },
    { id: "AC-2", text: "The focused Python tests pass." },
  ]);
});

test("same-run web readback hydrates and binds an omitted evidence hash", async () => {
  const fixture = createFixture("created");
  const args = argsFixture();
  const package_ = args.package as Record<string, unknown>;
  const evidence = package_.evidence as Array<Record<string, unknown>>;
  evidence[0].id = "";
  evidence[0].kind = "public_web";
  evidence[0].contentSha256 = "";
  const context = contextFixture(
    "Publish this research to Linear in Published.md",
  );
  context.runtimeCache = {
    toolResults: new Map(),
    trustedWebFetchResults: new Map([
      [
        `https://example.test/evidence:${HASH}`,
        {
          ok: true,
          toolName: "web_fetch",
          output: {
            url: "https://example.test/evidence",
            normalizedUrl: "https://example.test/evidence",
            contentHash: HASH,
            content: "Verified source content.",
          },
        },
      ],
    ]),
  };
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-hydrated-web-evidence",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(fixture.noteWrites[0]?.package.evidence[0]?.kind, "web");
  assert.equal(fixture.noteWrites[0]?.package.evidence[0]?.contentSha256, HASH);
  assert.equal(
    fixture.noteWrites[0]?.package.evidence[0]?.id,
    `evidence-${"a".repeat(64)}`,
  );
});

test("trusted web readback replaces an empty model evidence list", async () => {
  const fixture = createFixture("created");
  const args = argsFixture();
  (args.package as Record<string, unknown>).evidence = [];
  const context = contextFixture(
    "Publish this research to Linear in Published.md",
  );
  context.runtimeCache = {
    toolResults: new Map(),
    trustedWebFetchResults: new Map([
      [
        `https://example.test/evidence:${HASH}`,
        {
          ok: true,
          toolName: "web_fetch",
          output: {
            url: "https://example.test/evidence",
            normalizedUrl: "https://example.test/evidence",
            contentHash: HASH,
            content: "Verified source content.",
          },
        },
      ],
    ]),
  };
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-empty-model-evidence",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(fixture.noteWrites[0]?.package.evidence.length, 1);
  assert.equal(
    fixture.noteWrites[0]?.package.evidence[0]?.contentSha256,
    HASH,
  );
});

test("durable root-run evidence replaces an empty continuation evidence list", async () => {
  let loads = 0;
  const fixture = createFixture("created", {
    loadDurableWebEvidence: async (runId) => {
      loads += 1;
      assert.equal(runId, "root-run-42");
      return [{
        url: "https://example.test/evidence",
        contentHash: HASH,
        usableSource: true,
        title: "Durably verified source",
        summary: "Verified source content restored from the mission ledger.",
        parserStatus: "parsed",
      }];
    },
  });
  const args = argsFixture();
  (args.package as Record<string, unknown>).evidence = [];
  const context = contextFixture(
    "Publish this research to Linear in Published.md",
  );
  context.rootMissionId = "root-run-42";
  context.runtimeCache = undefined;
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-durable-web-evidence",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(loads, 1);
  assert.deepEqual(fixture.noteWrites[0]?.package.evidence, [{
    id: `evidence-${"a".repeat(64)}`,
    kind: "web",
    reference: "https://example.test/evidence",
    contentSha256: HASH,
    label: "Durably verified source",
    summary: "Verified source content restored from the mission ledger.",
  }]);
});

test("durable run evidence merges with a partial live proof cache before publication", async () => {
  const secondHash = `sha256:${"b".repeat(64)}`;
  const fixture = createFixture("created", {
    loadDurableWebEvidence: async () => [{
      url: "https://second.example.test/evidence",
      contentHash: secondHash,
      usableSource: true,
      title: "Second durable source",
      summary: "Second verified source content restored from the mission ledger.",
      parserStatus: "parsed",
    }],
  });
  const args = argsFixture();
  (args.package as Record<string, unknown>).evidence = [];
  const context = contextFixture(
    "Publish this research to Linear in Published.md",
  );
  context.runtimeCache = {
    toolResults: new Map(),
    trustedWebFetchResults: new Map([["first", {
      ok: true,
      toolName: "web_fetch",
      output: {
        url: "https://first.example.test/evidence",
        normalizedUrl: "https://first.example.test/evidence",
        contentHash: HASH,
        title: "First live source",
        content: "First verified source content.",
      },
    }]]),
  };
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-merged-web-evidence",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    fixture.noteWrites[0]?.package.evidence.map((item) => ({
      reference: item.reference,
      contentSha256: item.contentSha256,
    })),
    [
      { reference: "https://first.example.test/evidence", contentSha256: HASH },
      { reference: "https://second.example.test/evidence", contentSha256: secondHash },
    ],
  );
});

test("explicit source minimum blocks publication before note or Linear mutation", async () => {
  const hashes = ["a", "b", "c"].map(
    (character) => `sha256:${character.repeat(64)}`,
  );
  const fixture = createFixture("created", {
    loadDurableWebEvidence: async () =>
      hashes.map((contentHash, index) => ({
        url: `https://source-${index + 1}.example.test/evidence`,
        contentHash,
        usableSource: true,
        title: `Verified source ${index + 1}`,
        summary: `Verified source content ${index + 1}.`,
        parserStatus: "parsed",
      })),
  });
  const args = argsFixture();
  (args.package as Record<string, unknown>).evidence = [];
  const context = contextFixture(
    "Use and fetch at least four independent sources, then publish this research to Linear in Published.md",
  );
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-incomplete-evidence",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "research_publication_evidence_incomplete");
  assert.match(result.error?.message ?? "", /requires 4[\s\S]*only 3/iu);
  assert.equal(result.mutationState, "not_applied");
  assert.equal(fixture.noteWrites.length, 0);
  assert.equal(fixture.checkpoints.length, 0);
  assert.equal(fixture.providerReadCount, 0);
});

test("explicit source minimum publishes after all distinct trusted sources are bound", async () => {
  const fixture = createFixture("created", {
    loadDurableWebEvidence: async () =>
      ["a", "b", "c", "d"].map((character, index) => ({
        url: `https://source-${index + 1}.example.test/evidence`,
        contentHash: `sha256:${character.repeat(64)}`,
        usableSource: true,
        title: `Verified source ${index + 1}`,
        summary: `Verified source content ${index + 1}.`,
        parserStatus: "parsed",
      })),
  });
  const args = argsFixture();
  (args.package as Record<string, unknown>).evidence = [];
  const context = contextFixture(
    "Use and fetch at least four independent sources, then publish this research to Linear in Published.md",
  );
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-complete-evidence",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    fixture.noteWrites[0]?.package.evidence.map((item) => item.reference),
    [
      "https://source-1.example.test/evidence",
      "https://source-2.example.test/evidence",
      "https://source-3.example.test/evidence",
      "https://source-4.example.test/evidence",
    ],
  );
});

test("same-run web readback replaces a conflicting model-supplied evidence hash", async () => {
  const fixture = createFixture("created");
  const args = argsFixture();
  const package_ = args.package as Record<string, unknown>;
  const evidence = package_.evidence as Array<Record<string, unknown>>;
  evidence[0].contentSha256 = `sha256:${"b".repeat(64)}`;
  const context = contextFixture(
    "Publish this research to Linear in Published.md",
  );
  context.runtimeCache = {
    toolResults: new Map([
      [
        'web_fetch:{"url":"https://example.test/evidence"}',
        {
          ok: true,
          toolName: "web_fetch",
          output: {
            url: "https://example.test/evidence",
            normalizedUrl: "https://example.test/evidence",
            contentHash: HASH,
          },
        },
      ],
    ]),
  };
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-host-evidence-hash",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(fixture.noteWrites.length, 1);
  assert.equal(
    fixture.noteWrites[0]?.package.evidence[0]?.contentSha256,
    HASH,
  );
});

test("unsafe model acceptance commands become logical host validation criteria", async () => {
  const fixture = createFixture("created");
  const args = argsFixture();
  const package_ = args.package as Record<string, unknown>;
  package_.proposedWork = [
    "Implement the number guess behavior.",
    "Run npm test && inspect src/guess.ts.",
  ];
  package_.scope = ["src/guess.ts and tests/guess.test.ts"];
  package_.acceptanceCriteria = [
    {
      text: "Run npm test && inspect src/guess.ts before committing.",
    },
  ];
  const context = contextFixture(
    "Publish this code research to Linear in Published.md",
  );
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-safe-work-item-contract",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(fixture.noteWrites[0]?.package.acceptanceCriteria, [
    {
      id: "AC-1",
      text: "The trusted validation requirement trusted.validation passes for the verified repository change.",
    },
  ]);
  assert.deepEqual(fixture.noteWrites[0]?.package.proposedWork, [
    "Implement the number guess behavior.",
    "Implement accepted work item 2 through the trusted repository profile.",
  ]);
  assert.deepEqual(fixture.noteWrites[0]?.package.scope, [
    "Accepted scope item 1 remains inside the trusted repository profile.",
  ]);
});

test("host canonicalizes the compatible $text acceptance alias", async () => {
  const fixture = createFixture("created");
  const args = argsFixture();
  (args.package as Record<string, unknown>).acceptanceCriteria = [
    { $text: "The verified behavior matches the accepted requirement." },
  ];
  const context = contextFixture(
    "Publish this code research to Linear in Published.md",
  );
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-compatible-text-alias",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(fixture.noteWrites[0]?.package.acceptanceCriteria, [
    {
      id: "AC-1",
      text: "The verified behavior matches the accepted requirement.",
    },
  ]);
});

test("same-run web readbacks replace unfetched model web claims with canonical sources", async () => {
  const fixture = createFixture("created");
  const args = argsFixture();
  const package_ = args.package as Record<string, unknown>;
  const evidence = package_.evidence as Array<Record<string, unknown>>;
  evidence[0] = {
    id: "untrusted-model-source",
    kind: "web",
    reference: "https://unfetched.example.test/claim",
    contentSha256: `sha256:${"b".repeat(64)}`,
    label: "Unfetched claim",
    summary: "This claim did not receive a host fetch readback.",
  };
  evidence.push({
    id: "model evidence with invalid spacing",
    kind: "user",
    reference: "model-only-user-claim",
    contentSha256: "",
    label: "Unverified user claim",
    summary: "This model-authored entry has no host readback or strong hash.",
  });
  const context = contextFixture(
    "Publish this research to Linear in Published.md",
  );
  context.runtimeCache = {
    toolResults: new Map([
      [
        'web_fetch:{"url":"https://example.test/evidence"}',
        {
          ok: true,
          toolName: "web_fetch",
          output: {
            title: "Verified rules source",
            url: "https://example.test/evidence",
            normalizedUrl: "https://example.test/evidence",
            urlHash: "1234567890abcdef",
            contentHash: HASH,
            content: "Verified source content for accepted research.",
          },
        },
      ],
    ]),
  };
  context.requestNestedApproval = async (request) => ({
    approved: true,
    approvalId: "approval-canonical-web-projection",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  });

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(fixture.noteWrites[0]?.package.evidence.length, 1);
  assert.equal(
    fixture.noteWrites[0]?.package.evidence[0]?.reference,
    "https://example.test/evidence",
  );
  assert.equal(fixture.noteWrites[0]?.package.evidence[0]?.contentSha256, HASH);
  assert.equal(
    fixture.noteWrites[0]?.package.evidence[0]?.id,
    `evidence-${"a".repeat(48)}-1234567890abcdef`,
  );
  assert.equal(fixture.noteWrites[0]?.package.evidence[0]?.label, "Verified rules source");
  assert.doesNotMatch(
    fixture.noteWrites[0]?.package.evidence[0]?.reference ?? "",
    /unfetched/u,
  );
});

test("external bindings, origin ids, and unscoped paths fail before note mutation", async (t) => {
  await t.test("model origin id", async () => {
    const fixture = createFixture("created");
    const args = argsFixture();
    (args.package as Record<string, unknown>).originRunId = "attacker-run";
    await assert.rejects(
      fixture.tool.execute(args, contextFixture("Publish this research to Linear in Published.md")),
      /unknown: originRunId/i,
    );
    assert.equal(fixture.noteWrites.length, 0);
  });
  await t.test("untrusted repository", async () => {
    const fixture = createFixture("created", { trustRepository: false });
    await assert.rejects(
      fixture.tool.execute(argsFixture(), contextFixture("Publish this research to Linear in Published.md")),
      /untrusted repository/i,
    );
    assert.equal(fixture.noteWrites.length, 0);
  });
  await t.test("combined hierarchy envelope reports redacted argument shape", async () => {
    const fixture = createFixture("created");
    const args = argsFixture();
    args.package = {
      acceptanceCriteria: [],
      research: { summary: "not serialized in diagnostics" },
      initiativeKey: "initiative-e2e",
    };
    await assert.rejects(
      fixture.tool.execute(
        args,
        contextFixture("Publish this code research to Linear in Published.md"),
      ),
      /unknown_shapes: initiativeKey:string, research:object\(summary\)/i,
    );
    assert.equal(fixture.noteWrites.length, 0);
  });
  await t.test("repository-bound non-code package", async () => {
    const fixture = createFixture("created");
    const args = argsFixture();
    (args.package as Record<string, unknown>).executionClass = "research";
    await assert.rejects(
      fixture.tool.execute(
        args,
        contextFixture("Publish this code research to Linear in Published.md"),
      ),
      /repositoryKey must use executionClass code/i,
    );
    assert.equal(fixture.noteWrites.length, 0);
  });
  await t.test("bounded human-readable enum labels are canonicalized", async () => {
    const fixture = createFixture("created");
    const args = argsFixture();
    (args.package as Record<string, unknown>).riskClass = "medium-risk";
    (args.package as Record<string, unknown>).executionClass = "code execution";
    const context = contextFixture(
      "Publish this code research to Linear in Published.md",
    );
    context.requestNestedApproval = async (request) => ({
      approved: true,
      approvalId: "approval-canonical-enums",
      approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
    });
    await fixture.tool.execute(
      args,
      context,
    );
    assert.equal(fixture.noteWrites.length, 1);
    assert.equal(fixture.noteWrites[0]?.package.riskClass, "medium");
    assert.equal(fixture.noteWrites[0]?.package.executionClass, "code");
  });
  await t.test("path absent from mission", async () => {
    const fixture = createFixture("created");
    await assert.rejects(
      fixture.tool.execute(argsFixture(), contextFixture("Publish this research report to Linear")),
      /not explicit in mission/i,
    );
    assert.equal(fixture.noteWrites.length, 0);
  });
});

function createFixture(
  mode: "created" | "deduplicated" | "reconcile_required",
  options: {
    trustRepository?: boolean;
    resumeCheckpoints?: boolean;
    loadDurableWebEvidence?: Parameters<
      typeof createResearchPublicationTool
    >[0]["loadDurableWebEvidence"];
    describeTrustedRepositoryCatalog?: Parameters<
      typeof createResearchPublicationTool
    >[0]["describeTrustedRepositoryCatalog"];
  } = {},
) {
  const noteWrites: AcceptedResearchNoteWriteRequestV1[] = [];
  const resumeReads: AcceptedResearchNoteReadRequestV1[] = [];
  const checkpoints: ResearchPublicationCheckpointV1[] = [];
  const grants: AuthorityGrantV1[] = [];
  const persistedReceipts: ActionReceipt[] = [];
  const publisher = new FakePublisher(mode);
  const noteWriter = {
    writeAcceptedPackage: async (request: AcceptedResearchNoteWriteRequestV1) => {
      noteWrites.push(structuredClone(request));
      const artifact = createAcceptedResearchArtifactV1({
        schemaVersion: 1,
        artifactId: request.artifactId,
        originRunId: request.package.originRunId,
        vaultBindingKey: request.package.vaultBindingKey,
        notePath: request.path,
        noteSha256: HASH,
        noteReceiptId: "note-receipt-1",
        evidence: request.package.evidence.map(({ id, kind, reference, contentSha256 }) => ({
          id, kind, reference, contentSha256,
        })),
        acceptanceCriteria: request.package.acceptanceCriteria,
        riskClass: request.package.riskClass,
        acceptedAt: request.acceptedAt,
        acceptedBy: "host",
      });
      return {
        path: request.path,
        operation: request.mode,
        beforeSha256: null,
        afterSha256: HASH,
        noteReceiptId: "note-receipt-1",
        artifact,
        transaction: { status: "committed" },
      } as never;
    },
    readAcceptedPackage: async (request: AcceptedResearchNoteReadRequestV1) => {
      resumeReads.push(structuredClone(request));
      return {
        path: request.artifact.notePath,
        operation: "no_op",
        beforeSha256: request.expectedNoteSha256,
        afterSha256: request.expectedNoteSha256,
        noteReceiptId: request.artifact.noteReceiptId,
        artifact: request.artifact,
        transaction: null,
      } as never;
    },
    appendLinearBacklink: async () => {
      const path = noteWrites[0]!.path;
      const afterSha256 = `sha256:${"b".repeat(64)}`;
      const transaction = {
        version: 1,
        operation: "update",
        status: "committed",
        path,
        beforeSha256: HASH,
        expectedAfterSha256: afterSha256,
        afterSha256,
        finalSha256: afterSha256,
        backupPath:
          ".agent-backups/Published.2026-07-12T20-00-00-000Z.aaaaaaaaaaaa.backup.md",
        backupSha256: HASH,
        bytesWritten: 1,
        validationStatus: "passed",
        rollbackStatus: "not_required",
        rollbackSha256: null,
        error: null,
      } satisfies DiagramArtifactUpdateReceipt;
      return {
        path,
        operation: "append",
        beforeSha256: HASH,
        afterSha256,
        issueUrl: "https://linear.app/acme/issue/ENG-42",
        transaction,
      } as never;
    },
  };
  const tool = createResearchPublicationTool({
    noteWriter: noteWriter as never,
    publisher,
    lineage: {
      // get is required by the port; without resumeCheckpoints the fixture
      // returns null (no prior checkpoint) instead of omitting the method.
      get: async (publicationId: string) =>
        options.resumeCheckpoints
          ? structuredClone(
              [...checkpoints]
                .reverse()
                .find((checkpoint) => checkpoint.publicationId === publicationId) ?? null,
            )
          : null,
      persist: async (checkpoint) => {
        checkpoints.push(structuredClone(checkpoint));
      },
    },
    destination: DESTINATION,
    vaultBindingKey: "current-vault",
    resolveNotePath: ({ requestedPath, initiatingNotePath, originalPrompt, runId }) => {
      if (initiatingNotePath) {
        if (requestedPath && requestedPath !== initiatingNotePath) {
          throw new Error("Requested path differs from initiating note.");
        }
        return initiatingNotePath;
      }
      if (!requestedPath) return `Accepted research ${runId}.md`;
      if (!originalPrompt.includes(requestedPath)) throw new Error("Path is not explicit in mission.");
      return requestedPath;
    },
    validateTrustedBindings: (package_) => {
      if (options.trustRepository === false || package_.repositoryKey !== "trusted-repo") {
        throw new Error("Untrusted repository binding.");
      }
      if (!package_.validationRequirementKeys.every((key) => key === "trusted.validation")) {
        throw new Error("Untrusted validation catalog key.");
      }
    },
    mintOneActionGrant: async ({ runId, approvalId }) => {
      const grant = fakeGrant(runId, approvalId);
      grants.push(grant);
      return grant;
    },
    persistExternalReceipt: async (receipt) => {
      persistedReceipts.push(receipt);
    },
    ...(options.describeTrustedRepositoryCatalog
      ? { describeTrustedRepositoryCatalog: options.describeTrustedRepositoryCatalog }
      : {}),
    ...(options.loadDurableWebEvidence
      ? { loadDurableWebEvidence: options.loadDurableWebEvidence }
      : {}),
    now: () => new Date(NOW),
  });
  return {
    tool,
    noteWrites,
    resumeReads,
    checkpoints,
    grants,
    persistedReceipts,
    publisher,
    get providerReadCount() {
      return publisher.readCount;
    },
  };
}

class FakePublisher implements ResearchPublicationPublisherPortV1 {
  lastActiveGrantCount = 0;
  readCount = 0;
  readbackDescriptionOverride: string | null = null;
  private ticket: ReturnType<typeof ticket> | null = null;
  constructor(public mode: "created" | "deduplicated" | "reconcile_required") {}
  async preview(request: ResearchTicketPreviewRequest) {
    this.ticket = ticket(request);
    return {
      ok: true as const,
      status: this.mode === "deduplicated" ? "deduplicated" as const : "create" as const,
      ticket: this.ticket,
      duplicate: this.mode === "deduplicated" ? issue(this.ticket.description) : null,
      candidatesExamined: this.mode === "deduplicated" ? 1 : 0,
    };
  }
  async publish(request: ResearchTicketPublishRequest) {
    const built = ticket(request);
    this.lastActiveGrantCount = request.activeGrants?.length ?? 0;
    const issue_ = issue(built.description);
    if (this.mode === "deduplicated") {
      return { ok: true as const, status: "deduplicated" as const, ticket: built, issue: issue_, candidatesExamined: 1 };
    }
    const action = preparedAction(built.spec.fingerprint);
    if (this.mode === "reconcile_required") {
      return {
        ok: false as const,
        status: "reconcile_required" as const,
        error: {
          code: "linear_mutation_uncertain",
          message: "The Linear response was ambiguous.",
        },
        ticket: built,
        action,
        grantId: request.preferredGrantId!,
        candidatesExamined: 0,
      };
    }
    return {
      ok: true as const,
      status: "created" as const,
      ticket: built,
      issue: issue_,
      action,
      receipt: createdReceipt(action),
      grantId: request.preferredGrantId!,
      candidatesExamined: 0,
    };
  }
  async readIssue() {
    this.readCount += 1;
    return issue(
      this.readbackDescriptionOverride ?? this.ticket?.description ?? "",
    );
  }
}

function argsFixture(overrides: { notePath?: string } = {}) {
  return {
    ...(overrides.notePath === undefined && "notePath" in overrides ? {} : { notePath: overrides.notePath ?? "Published.md" }),
    mode: "create",
    package: {
      schemaVersion: 1,
      title: "Accepted research",
      problemImpact: "The durable handoff is required.",
      evidence: [{ id: "evidence-1", kind: "web", reference: "https://example.test/evidence", contentSha256: HASH, label: "Evidence", summary: "Supports the work." }],
      confidenceLimitations: "Provider smoke testing remains separate.",
      proposedWork: ["Implement the accepted work."],
      nonGoals: ["Automatic merge."],
      scope: ["Trusted repository only."],
      dependencies: [],
      acceptanceCriteria: [{ id: "AC-1", text: "The handoff is verified." }],
      validationRequirementKeys: ["trusted.validation"],
      riskClass: "medium",
      executionClass: "code",
      objective: "Implement the accepted work item.",
      repositoryKey: "trusted-repo",
    },
  } as Record<string, unknown>;
}

function contextFixture(
  prompt: string,
  runId = "run-42",
  operationId = "call-1",
): ToolExecutionContext {
  return {
    runId,
    operationId,
    originalPrompt: prompt,
    now: () => new Date(NOW),
    httpTransport: async () => ({ status: 500, headers: {} }),
  } as unknown as ToolExecutionContext;
}

async function approveNested(
  request: Parameters<NonNullable<ToolExecutionContext["requestNestedApproval"]>>[0],
) {
  return {
    approved: true as const,
    approvalId: "approval-checkpoint-resume",
    approvalFingerprint: request.preparedAction?.payloadFingerprint ?? "",
  };
}

function ticket(request: ResearchTicketPreviewRequest | ResearchTicketPublishRequest) {
  const spec = createWorkItemSpecV2(request.draft as ResearchTicketWorkItemDraftV2);
  return {
    spec,
    title: request.sections.title,
    description: renderQueueExecutableHumanWorkItemSpecV2(spec),
    deterministicIssueId: "issue-42",
  };
}

function issue(description: string): LinearIssueRecord {
  return {
    resourceType: "issue", id: "issue-42", identifier: "ENG-42",
    url: "https://linear.app/acme/issue/ENG-42", title: "Accepted research",
    description, priority: 0, trashed: false, team: { id: "team-1" },
    project: { id: "project-1" }, state: { id: "state-1" }, labels: [],
    createdAt: NOW, updatedAt: NOW, snapshotHash: HASH,
  };
}

function preparedAction(payloadFingerprint: string) {
  return {
    version: 1 as const, id: "action-created", runId: "run:42", toolCallId: "tool:call:1",
    toolName: "linear_create_issue", target: { system: "linear" as const, resourceType: "issue", id: "issue-42", teamId: "team-1", projectId: "project-1" },
    relatedResources: [], normalizedArgs: {}, preview: { summary: "Create", destination: "project-1", warnings: [], outboundBytes: 100 },
    payloadFingerprint,
    idempotencyKey: "linear:issue:create:run-42:tool-call-1:0",
    preparedAt: NOW,
    expiresAt: "2026-07-12T20:05:00.000Z",
  };
}

function createdReceipt(action: ReturnType<typeof preparedAction>): ActionReceipt {
  return {
    version: 1, id: "receipt-created", runId: action.runId, actionId: action.id,
    toolName: action.toolName, operation: "create", resource: {
      ...action.target,
      identifier: "ENG-42",
      url: "https://linear.app/acme/issue/ENG-42",
    },
    message: "Created and verified Linear issue.", payloadFingerprint: action.payloadFingerprint,
    grantId: "grant-1", idempotencyKey: action.idempotencyKey,
    startedAt: NOW, committedAt: NOW, commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: NOW,
      observedRevision: INITIAL_LINEAR_RECEIPT_HASH,
      observedFingerprint: INITIAL_LINEAR_RECEIPT_HASH,
    },
  };
}

function fakeGrant(runId: string, approvalId: string): AuthorityGrantV1 {
  return {
    version: 1, id: `grant-${approvalId}`, kind: "run_bounded", issuer: "user_approval",
    subject: { type: "run", id: runId }, rules: [],
    limits: { maxActions: 1, maxExternalMutations: 1, maxCreates: 1, maxDeletes: 0, maxOutboundBytes: 20_000 },
    usage: { actions: 0, externalMutations: 0, creates: 0, deletes: 0, outboundBytes: 0 },
    state: "active", issuedAt: NOW, expiresAt: "2026-07-12T20:05:00.000Z", authorityFingerprint: HASH,
  };
}

interface PreparedApproval {
  fingerprint: string;
  request: Parameters<NonNullable<ToolExecutionContext["requestNestedApproval"]>>[0];
}

function initiatingNoteContext(runId: string, operationId: string): ToolExecutionContext {
  const context = contextFixture(
    "Publish the accepted research report from this note to Linear.",
    runId,
    operationId,
  );
  context.getCurrentMarkdownFile = () =>
    ({ path: "Projects/Catalog.md", extension: "md" }) as never;
  context.app = {
    vault: { read: async () => "# Catalog mission\n\nAccepted research.\n" },
  } as never;
  context.requestNestedApproval = approveNested;
  return context;
}

function argsWithoutRepositoryKey() {
  const args = argsFixture({ notePath: undefined });
  delete (args.package as Record<string, unknown>).repositoryKey;
  return args;
}

test("code package defaults the repository key when exactly one profile is trusted", async () => {
  const fixture = createFixture("created", {
    describeTrustedRepositoryCatalog: () => ({
      repositoryKeys: ["trusted-repo"],
      validationKeysByRepository: { "trusted-repo": ["trusted.validation"] },
    }),
  });
  const result = await fixture.tool.execute(
    argsWithoutRepositoryKey(),
    initiatingNoteContext("run-catalog-default", "call-catalog-default"),
  ) as { ok: boolean };

  assert.equal(result.ok, true);
  // The defaulted key must flow into the durable package, not just pass the
  // parse: validateTrustedBindings above rejects anything but trusted-repo.
  assert.equal(fixture.noteWrites[0]?.package.repositoryKey, "trusted-repo");
});

test("host binds an explicitly named trusted validation key over a mistranscribed model echo", async () => {
  const fixture = createFixture("created", {
    describeTrustedRepositoryCatalog: () => ({
      repositoryKeys: ["trusted-repo"],
      validationKeysByRepository: {
        "trusted-repo": ["trusted.validation", "trusted-repo.validation.1"],
      },
    }),
  });
  const args = argsFixture({ notePath: undefined });
  (args.package as Record<string, unknown>).validationRequirementKeys = [
    "trusted-repo",
  ];
  const context = initiatingNoteContext(
    "run-catalog-validation-binding",
    "call-catalog-validation-binding",
  );
  context.originalPrompt = [
    "Publish the accepted research from this note to Linear.",
    "Use trusted repository key trusted-repo and validation requirement key trusted.validation.",
  ].join(" ");

  const result = await fixture.tool.execute(args, context) as { ok: boolean };

  assert.equal(result.ok, true);
  assert.deepEqual(
    fixture.noteWrites[0]?.package.validationRequirementKeys,
    ["trusted.validation"],
  );
});

test("code package with several trusted profiles still fails closed but names them", async () => {
  const fixture = createFixture("created", {
    describeTrustedRepositoryCatalog: () => ({
      repositoryKeys: ["trusted-repo", "other-repo"],
      validationKeysByRepository: {
        "trusted-repo": ["trusted.validation"],
        "other-repo": ["other.validation"],
      },
    }),
  });
  await assert.rejects(
    fixture.tool.execute(
      argsWithoutRepositoryKey(),
      initiatingNoteContext("run-catalog-multi", "call-catalog-multi"),
    ),
    /must include the trusted repositoryKey[\s\S]*Trusted repository keys: trusted-repo, other-repo\./u,
  );
  assert.equal(fixture.noteWrites.length, 0);
});

test("code package without a catalog keeps the legacy fail-closed message", async () => {
  const fixture = createFixture("created");
  await assert.rejects(
    fixture.tool.execute(
      argsWithoutRepositoryKey(),
      initiatingNoteContext("run-catalog-none", "call-catalog-none"),
    ),
    (error: unknown) =>
      error instanceof Error &&
      /must include the trusted repositoryKey named by the mission\.$/u.test(error.message),
  );
  assert.equal(fixture.noteWrites.length, 0);
});

test("trusted validation key catalog derives the profile id and numbered command keys", () => {
  assert.deepEqual(
    trustedValidationKeysForProfileV1({
      key: "retained-journey-crdt",
      validationProfile: {
        id: "retained-journey-crdt.validation",
        validationCommands: [{}, {}],
      },
    }),
    [
      "retained-journey-crdt.validation",
      "retained-journey-crdt.validation.1",
      "retained-journey-crdt.validation.2",
    ],
  );
});
