import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  verifyPreparedActionFingerprint,
  type ActionReceipt,
} from "../src/agent/actions";
import type { AuthorityGrantV1 } from "../src/agent/authority";
import {
  createAcceptedResearchArtifactV1,
  createWorkItemSpecV2,
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
} from "../src/tools/researchPublicationTool";
import { DefaultToolRegistry } from "../src/tools/ToolRegistry";
import type { ToolExecutionContext } from "../src/tools/types";

const NOW = "2026-07-12T20:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;
const DESTINATION = { workspaceId: "workspace-1", teamId: "team-1", projectId: "project-1" };

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

test("durable run evidence replaces an empty model evidence list after runtime cache loss", async () => {
  let loads = 0;
  const fixture = createFixture("created", {
    loadDurableWebEvidence: async (runId) => {
      loads += 1;
      assert.equal(runId, "run-42");
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
  context.runtimeCache = { toolResults: new Map() };
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

test("same-run web readback rejects a conflicting model-supplied evidence hash", async () => {
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

  const result = await new DefaultToolRegistry([fixture.tool]).execute(
    { name: "publish_research_to_linear", arguments: args },
    context,
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "research_publication_evidence_changed");
  assert.equal(fixture.noteWrites.length, 0);
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
  mode: "created" | "deduplicated",
  options: {
    trustRepository?: boolean;
    loadDurableWebEvidence?: Parameters<
      typeof createResearchPublicationTool
    >[0]["loadDurableWebEvidence"];
  } = {},
) {
  const noteWrites: AcceptedResearchNoteWriteRequestV1[] = [];
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
    appendLinearBacklink: async () => ({
      path: noteWrites[0].path,
      operation: "append",
      beforeSha256: HASH,
      afterSha256: `sha256:${"b".repeat(64)}`,
      issueUrl: "https://linear.app/acme/issue/ENG-42",
      transaction: null,
    } as never),
  };
  const tool = createResearchPublicationTool({
    noteWriter: noteWriter as never,
    publisher,
    lineage: {
      persist: async (checkpoint) => {
        checkpoints.push(structuredClone(checkpoint));
      },
    },
    destination: DESTINATION,
    vaultBindingKey: "current-vault",
    resolveNotePath: ({ requestedPath, originalPrompt, runId }) => {
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
    ...(options.loadDurableWebEvidence
      ? { loadDurableWebEvidence: options.loadDurableWebEvidence }
      : {}),
    now: () => new Date(NOW),
  });
  return { tool, noteWrites, checkpoints, grants, persistedReceipts, publisher };
}

class FakePublisher implements ResearchPublicationPublisherPortV1 {
  lastActiveGrantCount = 0;
  private ticket: ReturnType<typeof ticket> | null = null;
  constructor(private readonly mode: "created" | "deduplicated") {}
  async preview(request: ResearchTicketPreviewRequest) {
    this.ticket = ticket(request);
    return {
      ok: true as const,
      status: this.mode === "created" ? "create" as const : "deduplicated" as const,
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

function ticket(request: ResearchTicketPreviewRequest | ResearchTicketPublishRequest) {
  const spec = createWorkItemSpecV2(request.draft as ResearchTicketWorkItemDraftV2);
  return { spec, title: request.sections.title, description: JSON.stringify(spec), deterministicIssueId: "issue-42" };
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
    payloadFingerprint, preparedAt: NOW, expiresAt: "2026-07-12T20:05:00.000Z",
  };
}

function createdReceipt(action: ReturnType<typeof preparedAction>): ActionReceipt {
  return {
    version: 1, id: "receipt-created", runId: action.runId, actionId: action.id,
    toolName: action.toolName, operation: "create", resource: action.target,
    message: "Created and verified Linear issue.", payloadFingerprint: action.payloadFingerprint,
    grantId: "grant-1", startedAt: NOW, committedAt: NOW, commitKind: "committed",
    readback: { status: "verified", checkedAt: NOW },
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
