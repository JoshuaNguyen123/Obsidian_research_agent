import assert from "node:assert/strict";
import test from "node:test";

import type { ActionReceipt, PreparedAction } from "../src/agent/actions";
import type { ToolExecutionContext } from "../src/tools/types";
import {
  ResearchTicketPublisher,
  parseRenderedWorkItemSpecV1,
  type HostLinearActionExecution,
  type HostLinearActionPreparation,
  type LinearIssueRecord,
  type LinearOperationResult,
  type LinearToolClient,
  type ResearchTicketPublisherOptions,
  type ResearchTicketWorkItemDraftV1,
  type SynthesizedResearchTicketSectionsV1,
} from "../src/integrations/linear";

const NOW = "2026-07-11T12:00:00.000Z";
const HASH = `sha256:${"b".repeat(64)}`;
const QUEUE_TEAM_ID = "team-research";
const QUEUE_PROJECT_ID = "project-agent-queue";
const SUBJECT = { type: "schedule" as const, id: "linear-queue" };

const DRAFT: ResearchTicketWorkItemDraftV1 = {
  schemaVersion: 1,
  ready: true,
  executionClass: "code",
  objective: "Add deterministic research-ticket publication.",
  repositoryKey: "research-agent",
  acceptanceCriteria: [
    { id: "AC-1", text: "An accepted result creates at most one Linear issue." },
  ],
  validationRequirements: ["npm test"],
  evidenceRefs: ["https://example.test/evidence/accepted-synthesis"],
  riskClass: "medium",
  originRunId: "research-run-42",
  generation: 0,
  fingerprint: `sha256:${"0".repeat(64)}`,
};

const SECTIONS: SynthesizedResearchTicketSectionsV1 = {
  contentKind: "synthesized",
  title: "Publish accepted research as one Linear issue",
  problemImpact: "Duplicate tickets make autonomous execution unsafe and wasteful.",
  confidenceLimitations: "The result is based on accepted evidence; webhook delivery is out of scope.",
  proposedWork: ["Create a prepared, grant-bound issue in the pinned queue."],
  nonGoals: ["Publishing a GitHub pull request."],
  scope: ["Research-to-ticket handoff."],
  dependencies: ["A configured private Linear workspace."],
};

test("publisher rebuilds, fingerprints, renders, and bounds synthesized ticket input", () => {
  const publisher = publisherFixture(emptyReadClient(), unusedExecutor());
  const built = publisher.build(SECTIONS, DRAFT);

  assert.match(built.spec.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(built.spec.fingerprint, DRAFT.fingerprint);
  assert.equal(
    parseRenderedWorkItemSpecV1(built.description).spec.fingerprint,
    built.spec.fingerprint,
  );
  assert.match(
    built.deterministicIssueId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.equal(
    publisher.build(SECTIONS, { ...DRAFT, fingerprint: "caller-controlled" })
      .deterministicIssueId,
    built.deterministicIssueId,
  );

  assert.throws(
    () =>
      publisher.build(
        { ...SECTIONS, rawNotePayload: "entire private note" } as typeof SECTIONS,
        DRAFT,
      ),
    /unsupported fields: rawNotePayload/i,
  );
  assert.throws(
    () =>
      publisher.build(SECTIONS, {
        ...DRAFT,
        rawNotePayload: "entire private note",
      } as ResearchTicketWorkItemDraftV1),
    /unsupported fields: rawNotePayload/i,
  );
});

test("publisher preview builds and deduplicates without preparing or dispatching a mutation", async () => {
  let prepareCount = 0;
  let executeCount = 0;
  const publisher = publisherFixture(
    emptyReadClient(),
    fakeExecutor({
      onPrepare: () => {
        prepareCount += 1;
      },
      onExecute: () => {
        executeCount += 1;
      },
    }),
  );

  const preview = await publisher.preview({
    context: requestFixture().context,
    sections: SECTIONS,
    draft: DRAFT,
  });

  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.status, "create");
  assert.equal(preview.duplicate, null);
  assert.match(
    preview.ticket.description,
    /agentic-researcher:work-item:v1:start/u,
  );
  assert.equal(prepareCount, 0);
  assert.equal(executeCount, 0);
});

test("publisher deduplicates only an exact signed contract in the pinned queue project", async () => {
  let executeCalls = 0;
  const searches: Array<Record<string, unknown>> = [];
  let duplicateDescription = "";
  const readClient: LinearToolClient = {
    execute: async (operationKey, variables = {}) => {
      if (operationKey === "issues.search") {
        searches.push(variables);
        if (searches.length === 1) {
          return page([
            issue("outside", duplicateDescription, "different-project"),
            issue("duplicate", duplicateDescription, QUEUE_PROJECT_ID),
          ]);
        }
        return page([]);
      }
      if (operationKey === "issues.get") {
        assert.deepEqual(variables, { id: "duplicate" });
        return issue("duplicate", duplicateDescription, QUEUE_PROJECT_ID);
      }
      throw new Error(`Unexpected operation ${operationKey}`);
    },
  };
  const executor = fakeExecutor({
    onExecute: () => {
      executeCalls += 1;
      throw new Error("Duplicate publication must not execute.");
    },
  });
  const publisher = publisherFixture(readClient, executor);
  duplicateDescription = publisher.build(SECTIONS, DRAFT).description;

  const result = await publisher.publish(requestFixture({
    status: "deduplicated",
    duplicateId: "duplicate",
    duplicateSnapshotHash: HASH,
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "deduplicated");
  assert.equal(result.issue.id, "duplicate");
  assert.equal(result.candidatesExamined, 1);
  assert.equal(executeCalls, 0);
  assert.equal(searches.length, 2);
  for (const variables of searches) {
    assert.deepEqual(variables.filter, {
      project: { id: { eq: QUEUE_PROJECT_ID } },
    });
    assert.equal(variables.includeArchived, false);
    assert.ok(Number(variables.first) <= 10);
  }
});

test("publisher rejects create-to-deduplicate drift after exact approval", async () => {
  let executeCalls = 0;
  let duplicateDescription = "";
  const readClient: LinearToolClient = {
    execute: async (operationKey, variables = {}) => {
      if (operationKey === "issues.search") {
        return page([issue("late-duplicate", duplicateDescription, QUEUE_PROJECT_ID)]);
      }
      if (operationKey === "issues.get") {
        assert.deepEqual(variables, { id: "late-duplicate" });
        return issue("late-duplicate", duplicateDescription, QUEUE_PROJECT_ID);
      }
      throw new Error(`Unexpected operation ${operationKey}`);
    },
  };
  const publisher = publisherFixture(readClient, fakeExecutor({
    onExecute: () => { executeCalls += 1; },
  }));
  duplicateDescription = publisher.build(SECTIONS, DRAFT).description;

  const result = await publisher.publish(requestFixture());

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "research_ticket_approved_preview_changed");
  assert.equal(executeCalls, 0);
});

test("publisher prepares one deterministic pinned create and verifies independent readback", async () => {
  const searches: Array<Record<string, unknown>> = [];
  let preparedArguments: Record<string, unknown> | undefined;
  let preparedCount = 0;
  let executeCount = 0;
  const readClient: LinearToolClient = {
    execute: async (operationKey, variables = {}) => {
      if (operationKey === "issues.search") {
        searches.push(variables);
        return page([]);
      }
      if (operationKey === "issues.get" && preparedArguments) {
        return issue(
          String(preparedArguments.id),
          String(preparedArguments.description),
          QUEUE_PROJECT_ID,
        );
      }
      throw new Error(`Unexpected operation ${operationKey}`);
    },
  };
  const executor = fakeExecutor({
    onPrepare: (arguments_) => {
      preparedCount += 1;
      preparedArguments = arguments_;
    },
    onExecute: () => {
      executeCount += 1;
    },
  });
  const publisher = publisherFixture(readClient, executor);

  const result = await publisher.publish(requestFixture());

  assert.equal(result.ok, true);
  if (!result.ok || result.status !== "created") return;
  assert.equal(preparedCount, 1);
  assert.equal(executeCount, 1);
  assert.equal(preparedArguments?.teamId, QUEUE_TEAM_ID);
  assert.equal(preparedArguments?.projectId, QUEUE_PROJECT_ID);
  assert.equal(preparedArguments?.id, result.ticket.deterministicIssueId);
  assert.equal(result.issue.id, result.ticket.deterministicIssueId);
  assert.equal(result.issue.project?.id, QUEUE_PROJECT_ID);
  assert.equal(
    parseRenderedWorkItemSpecV1(result.issue.description ?? "").spec.fingerprint,
    result.ticket.spec.fingerprint,
  );
  assert.equal(result.receipt.grantId, "grant-queue");
  assert.equal(searches.length, 2);
});

test("publisher fails closed when created issue readback changes project or contract", async (t) => {
  for (const mismatch of ["project", "contract"] as const) {
    await t.test(mismatch, async () => {
      let preparedArguments: Record<string, unknown> | undefined;
      const readClient: LinearToolClient = {
        execute: async (operationKey) => {
          if (operationKey === "issues.search") return page([]);
          if (operationKey === "issues.get" && preparedArguments) {
            const different = publisherFixture(emptyReadClient(), unusedExecutor())
              .build(
                { ...SECTIONS, title: "Different accepted ticket" },
                { ...DRAFT, objective: "A different contract." },
              )
              .description;
            return issue(
              String(preparedArguments.id),
              mismatch === "contract"
                ? different
                : String(preparedArguments.description),
              mismatch === "project" ? "wrong-project" : QUEUE_PROJECT_ID,
            );
          }
          throw new Error(`Unexpected operation ${operationKey}`);
        },
      };
      const publisher = publisherFixture(
        readClient,
        fakeExecutor({
          onPrepare: (arguments_) => {
            preparedArguments = arguments_;
          },
        }),
      );

      const result = await publisher.publish(requestFixture());

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.status, "reconcile_required");
      assert.equal(result.error.code, "research_ticket_readback_mismatch");
      assert.match(result.error.message, mismatch === "project" ? /project/i : /fingerprint/i);
    });
  }
});

test("ambiguous create surfaces reconcile_required without retry or automatic reconcile", async () => {
  let prepareCount = 0;
  let executeCount = 0;
  let readbackCount = 0;
  const readClient: LinearToolClient = {
    execute: async (operationKey) => {
      if (operationKey === "issues.search") return page([]);
      if (operationKey === "issues.get") {
        readbackCount += 1;
        throw new Error("Publisher must not read after an ambiguous executor result.");
      }
      throw new Error(`Unexpected operation ${operationKey}`);
    },
  };
  const executor = fakeExecutor({
    onPrepare: () => {
      prepareCount += 1;
    },
    onExecute: () => {
      executeCount += 1;
    },
    executionResult: (action) => ({
      ok: false,
      status: "reconcile_required",
      error: {
        code: "linear_mutation_uncertain",
        message: "Linear create may have applied.",
      },
      action,
      grantId: "grant-queue",
    }),
  });
  const publisher = publisherFixture(readClient, executor);

  const result = await publisher.publish(requestFixture());

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, "reconcile_required");
  assert.equal(result.error.code, "linear_mutation_uncertain");
  assert.equal(prepareCount, 1);
  assert.equal(executeCount, 1);
  assert.equal(readbackCount, 0);
});

function publisherFixture(
  readClient: LinearToolClient,
  actionExecutor: ResearchTicketPublisherOptions["actionExecutor"],
): ResearchTicketPublisher {
  return new ResearchTicketPublisher({
    readClient,
    actionExecutor,
    queueTeamId: QUEUE_TEAM_ID,
    queueProjectId: QUEUE_PROJECT_ID,
  });
}

function requestFixture(overrides: Partial<{
  status: "create" | "deduplicated";
  duplicateId: string | null;
  duplicateSnapshotHash: string | null;
}> = {}) {
  const ticket = publisherFixture(emptyReadClient(), unusedExecutor()).build(SECTIONS, DRAFT);
  return {
    runId: "research-run-42",
    toolCallId: "publish-ticket-1",
    subject: SUBJECT,
    context: contextFixture(),
    sections: SECTIONS,
    draft: DRAFT,
    approvedPreview: {
      status: overrides.status ?? "create",
      workItemFingerprint: ticket.spec.fingerprint,
      duplicateId: overrides.duplicateId ?? null,
      duplicateSnapshotHash: overrides.duplicateSnapshotHash ?? null,
    },
    preferredGrantId: "grant-queue",
  };
}

function fakeExecutor(options: {
  onPrepare?: (arguments_: Record<string, unknown>) => void;
  onExecute?: (action: PreparedAction) => void;
  executionResult?: (action: PreparedAction) => HostLinearActionExecution;
}): ResearchTicketPublisherOptions["actionExecutor"] {
  let action: PreparedAction | undefined;
  return {
    prepare: async (request): Promise<HostLinearActionPreparation> => {
      options.onPrepare?.(request.arguments);
      action = preparedAction(
        request.runId,
        request.toolCallId,
        String(request.arguments.id),
      );
      return {
        ok: true,
        status: "prepared",
        action,
        preview: action.preview,
        descriptor: createDescriptor(),
      };
    },
    executePrepared: async (request): Promise<HostLinearActionExecution> => {
      assert.equal(request.action, action);
      assert.deepEqual(request.subject, SUBJECT);
      assert.equal(request.preferredGrantId, "grant-queue");
      options.onExecute?.(request.action);
      return options.executionResult?.(request.action) ?? {
        ok: true,
        status: "committed",
        action: request.action,
        preview: request.action.preview,
        descriptor: createDescriptor(),
        grantId: "grant-queue",
        output: undefined,
        receipt: receipt(request.action),
      };
    },
  };
}

function unusedExecutor(): ResearchTicketPublisherOptions["actionExecutor"] {
  return {
    prepare: async () => {
      throw new Error("Executor must not be used.");
    },
    executePrepared: async () => {
      throw new Error("Executor must not be used.");
    },
  };
}

function emptyReadClient(): LinearToolClient {
  return {
    execute: async (operationKey): Promise<LinearOperationResult> => {
      if (operationKey === "issues.search") return page([]);
      throw new Error(`Unexpected operation ${operationKey}`);
    },
  };
}

function preparedAction(
  runId: string,
  toolCallId: string,
  id: string,
): PreparedAction {
  return {
    version: 1,
    id: `prepared-${id}`,
    runId,
    toolCallId,
    toolName: "linear_create_issue",
    target: {
      system: "linear",
      resourceType: "issue",
      id,
      teamId: QUEUE_TEAM_ID,
      projectId: QUEUE_PROJECT_ID,
    },
    relatedResources: [],
    normalizedArgs: {},
    preview: {
      summary: "Create Linear issue",
      destination: QUEUE_PROJECT_ID,
      warnings: [],
      outboundBytes: 100,
    },
    payloadFingerprint: HASH,
    idempotencyKey: `issue:${id}`,
    preparedAt: NOW,
    expiresAt: "2026-07-11T12:05:00.000Z",
  };
}

function receipt(action: PreparedAction): ActionReceipt {
  return {
    version: 1,
    id: `receipt-${action.target.id}`,
    runId: action.runId,
    actionId: action.id,
    toolName: action.toolName,
    operation: "create",
    resource: action.target,
    message: "Created and verified Linear issue.",
    payloadFingerprint: action.payloadFingerprint,
    grantId: "grant-queue",
    idempotencyKey: action.idempotencyKey,
    startedAt: NOW,
    committedAt: NOW,
    commitKind: "committed",
    readback: { status: "verified", checkedAt: NOW },
  };
}

function createDescriptor() {
  return {
    version: 1 as const,
    name: "linear_create_issue",
    capability: {
      system: "linear" as const,
      resourceType: "issue",
      action: "create" as const,
    },
    effect: "reversible_mutation" as const,
    risk: "medium" as const,
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "exact" as const,
    },
    execution: {
      preparation: "required" as const,
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "required" as const,
      reconciliation: "required" as const,
    },
    allowedPrincipals: ["host" as const],
  };
}

function issue(
  id: string,
  description: string,
  projectId: string,
): LinearIssueRecord {
  return {
    resourceType: "issue",
    id,
    identifier: `RES-${id}`,
    url: `https://linear.app/acme/issue/RES-${id}`,
    title: SECTIONS.title,
    description,
    priority: 0,
    trashed: false,
    team: { id: QUEUE_TEAM_ID, name: "Research" },
    state: { id: "state-ready", name: "Ready", type: "unstarted" },
    project: { id: projectId, name: "Agent queue" },
    labels: [],
    snapshotHash: HASH,
  };
}

function page(items: LinearIssueRecord[]): LinearOperationResult {
  return {
    items,
    pageInfo: { hasNextPage: false },
    fetchedAt: NOW,
  };
}

function contextFixture(): ToolExecutionContext {
  return {
    runId: "research-run-42",
    operationId: "publish-ticket-1",
    now: () => new Date(NOW),
    httpTransport: async () => ({ status: 500, headers: {} }),
  } as unknown as ToolExecutionContext;
}
