import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import { portableSha256Text } from "../packages/core-api/src/portableSha256";
import { getRequiredWriteToolNamesForTests } from "../src/AgentRunner";
import type { ActionReceipt } from "../src/agent/actions";
import {
  ResearchProjectHierarchyWorkflowV1,
  type ResearchProjectHierarchyCheckpointV1,
  type ResearchProjectHierarchyResultV1,
} from "../src/integrations/linear/ResearchProjectHierarchyWorkflowV1";
import {
  createResearchProjectHierarchyTool,
  type CreateResearchProjectHierarchyToolOptionsV1,
} from "../src/tools/researchProjectHierarchyTool";
import type { ToolExecutionContext } from "../src/tools/types";

const NOW = "2026-08-19T16:00:00.000Z";
const HASH = (character: string) => `sha256:${character.repeat(64)}`;

test("the hierarchy tool hands the original execution context to durable lineage persistence", async () => {
  const acceptedNote = [
    "# Conflict-free counter research",
    "A deterministic replica merge algorithm preserves counter convergence.",
    "Independent validation must prove conflict-free updates and exact readback.",
  ].join("\n");
  const context: ToolExecutionContext = {
    app: {} as ToolExecutionContext["app"],
    settings: {} as ToolExecutionContext["settings"],
    originalPrompt:
      "Turn this accepted research into a Linear initiative, project, and dependency-aware issues.",
    runId: "run-progress-context-1",
    operationId: "hierarchy-call-progress-1",
    httpTransport: async () => {
      throw new Error("HTTP is not used by this contract test.");
    },
    now: () => new Date(NOW),
    requestNestedApproval: async (request) => ({
      approved: true,
      approvalId: "approval-progress-context-1",
      approvalFingerprint: request.preparedAction?.payloadFingerprint ?? HASH("d"),
    }),
  };
  let completeCheckpoint: ResearchProjectHierarchyCheckpointV1 | null = null;
  let persistedInput: Parameters<
    NonNullable<CreateResearchProjectHierarchyToolOptionsV1["persistProjectLineage"]>
  >[0] | null = null;
  const prototype = ResearchProjectHierarchyWorkflowV1.prototype as unknown as {
    execute: (
      input: Parameters<ResearchProjectHierarchyWorkflowV1["execute"]>[0],
    ) => Promise<ResearchProjectHierarchyResultV1>;
  };
  const originalExecute = prototype.execute;
  prototype.execute = async (request) => {
    completeCheckpoint = {
      version: 1,
      planFingerprint: request.plan.fingerprint,
      status: "complete",
      approvalFingerprint: HASH("b"),
      approvalId: "approval-progress-context-1",
      grantId: "grant-progress-context-1",
      items: [],
      updatedAt: NOW,
    };
    return {
      ok: true,
      status: "complete",
      plan: request.plan,
      checkpoint: completeCheckpoint,
      receipt: hierarchyReceipt(request.runId, request.plan.fingerprint),
      initiativeId: "initiative-progress-1",
      projectId: "project-progress-1",
      issueIds: ["issue-progress-1"],
    };
  };

  try {
    const tool = createResearchProjectHierarchyTool({
      readClient: {
        async execute() {
          throw new Error("Provider reads are owned by the stubbed workflow.");
        },
      },
      actionExecutor: {
        async prepare() {
          throw new Error("Preparation is owned by the stubbed workflow.");
        },
        async executePrepared() {
          throw new Error("Execution is owned by the stubbed workflow.");
        },
        async reconcile() {
          throw new Error("Reconciliation is owned by the stubbed workflow.");
        },
      } as CreateResearchProjectHierarchyToolOptionsV1["actionExecutor"],
      checkpoints: {
        async get() {
          return completeCheckpoint;
        },
        async persist() {
          throw new Error("The stubbed workflow owns its checkpoint.");
        },
      },
      destination: { workspaceId: "workspace-progress-1", teamId: "team-progress-1" },
      async resolveAcceptedResearchBinding(input) {
        assert.equal(input.runId, context.runId);
        assert.equal(input.notePath, null);
        return {
          artifactFingerprint: HASH("a"),
          notePath: "Research/Conflict-free counter.md",
          noteSha256: `sha256:${portableSha256Text(acceptedNote)}`,
          noteContent: acceptedNote,
        };
      },
      async mintHierarchyGrant() {
        throw new Error("The stubbed workflow owns approval.");
      },
      async resolvePersistedGrant() {
        return null;
      },
      async persistExternalReceipt() {
        throw new Error("The stubbed workflow owns receipt persistence.");
      },
      async persistProjectLineage(input) {
        persistedInput = input;
      },
      now: () => new Date(NOW),
    });

    await tool.execute(
      {
        plan: {
          initiative: {
            key: "counter-initiative",
            title: "Conflict-free counter architecture",
            description: "Research deterministic replica merge convergence.",
          },
          project: {
            key: "counter-project",
            title: "Counter convergence implementation",
            description: "Implement and validate the deterministic merge algorithm.",
          },
          issues: [
            {
              key: "counter-foundation",
              title: "Implement replica counter merge",
              description:
                "Implement the deterministic counter merge algorithm and validate convergence.",
              dependencyKeys: [],
              acceptanceCriteria: ["Replica convergence is independently validated."],
            },
          ],
        },
      },
      context,
    );
  } finally {
    prototype.execute = originalExecute;
  }

  const observedInput = persistedInput as Parameters<
    NonNullable<CreateResearchProjectHierarchyToolOptionsV1["persistProjectLineage"]>
  >[0] | null;
  assert.ok(observedInput);
  assert.strictEqual(
    observedInput.context,
    context,
    "the host must receive the same approval, run, and operation authority object",
  );
  assert.equal(observedInput.checkpoint.status, "complete");
  assert.deepEqual(observedInput.issueIds, ["issue-progress-1"]);
});

test("plugin data round-trips the durable Linear progress namespace", () => {
  const { sourceFile } = parseSource("../main.ts");
  const saveMethod = findMethod(sourceFile, "savePluginData");
  const loadMethod = findMethod(sourceFile, "loadSettings");

  const savedProperty = descendants(saveMethod).find(
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) && propertyName(node.name) === "projectLinearProgress",
  );
  assert.ok(savedProperty, "savePluginData must persist projectLinearProgress");
  assert.equal(
    savedProperty.initializer.getText(sourceFile),
    "this.projectLinearProgressNamespace",
  );

  const loadedBinding = descendants(loadMethod).find(
    (node): node is ts.BindingElement =>
      ts.isBindingElement(node) &&
      node.propertyName !== undefined &&
      propertyName(node.propertyName) === "projectLinearProgress" &&
      node.name.getText(sourceFile) === "rawProjectLinearProgress",
  );
  assert.ok(loadedBinding, "loadSettings must load the same persisted key");

  const loadAssignments = findCalls(loadMethod, sourceFile, "parseProjectLinearProgressNamespaceV1")
    .filter((call) => call.arguments[0]?.getText(sourceFile) === "rawProjectLinearProgress");
  assert.equal(loadAssignments.length, 1, "the persisted namespace must cross the strict parser once");
  assert.ok(
    loadAssignments[0].parent.getText(sourceFile).includes(
      "this.projectLinearProgressNamespace",
    ),
    "the parsed value must become the runtime namespace",
  );
});

test("the production Linear dispatcher binds every phase boundary to stable comment, state, and composite receipts", () => {
  const { sourceFile } = parseSource("../main.ts");
  const stateMethod = findMethod(sourceFile, "linearStateIdForProjectProgress");
  const dispatchMethod = findMethod(sourceFile, "dispatchLinearProgressCommand");

  assert.deepEqual(readStateMapping(stateMethod, sourceFile), {
    ready: "this.settings.linearReadyStateId",
    in_progress: "this.settings.linearStartedStateId",
    ready_for_review: "this.settings.linearStartedStateId",
    in_review: "this.settings.linearStartedStateId",
    blocked: "this.settings.linearBlockedStateId",
    completed: "this.settings.linearCompletedStateId",
  });

  const providerCalls = findCalls(
    dispatchMethod,
    sourceFile,
    "this.executeApprovedLinearFinalizationAction",
  );
  assert.equal(providerCalls.length, 2);
  const providerByTool = new Map(
    providerCalls.map((call) => {
      const input = expectObject(call.arguments[0]);
      return [expectStringProperty(input, "toolName"), input] as const;
    }),
  );
  const comment = providerByTool.get("linear_create_comment");
  const state = providerByTool.get("linear_update_issue");
  assert.ok(comment);
  assert.ok(state);
  assertTemplateProperty(comment, "toolCallId", "project-progress-comment-", "commandSuffix");
  assertObjectProperty(comment, "arguments", {
    issueId: "command.linearIssueId",
    body: "command.comment",
  }, sourceFile);
  assertTemplateProperty(state, "toolCallId", "project-progress-state-", "commandSuffix");
  assertObjectProperty(state, "arguments", {
    id: "command.linearIssueId",
    stateId: "configuredStateId",
  }, sourceFile);

  const issueReads = findCalls(dispatchMethod, sourceFile, "this.readLinearProgressIssue");
  assert.ok(issueReads.length >= 2, "state must be read before and independently after mutation");
  assert.equal(
    issueReads.every((call) => call.arguments[0]?.getText(sourceFile) === "command.linearIssueId"),
    true,
  );

  const compositeHash = findCalls(dispatchMethod, sourceFile, "sha256LinearValue")
    .flatMap((call) =>
      call.arguments[0] && ts.isObjectLiteralExpression(call.arguments[0])
        ? [call.arguments[0]]
        : [],
    )
    .find((object) => optionalStringProperty(object, "kind") === "linear_project_progress_provider_receipt");
  assert.ok(compositeHash, "comment and state readbacks must be sealed into one provider receipt");
  assertObjectProperty(compositeHash, undefined, {
    commandId: "command.commandId",
    commandFingerprint: "command.commandFingerprint",
    commentReceiptId: "commentReceipt.id",
    commentReceiptFingerprint: "commentReceiptFingerprint",
    stateReadbackFingerprint: "stateReadbackFingerprint",
  }, sourceFile);

  const acknowledgeCalls = findCalls(
    dispatchMethod,
    sourceFile,
    "this.projectLinearProgressRuntime.acknowledgeVerified",
  );
  assert.equal(acknowledgeCalls.length, 1);
  const acknowledgement = expectObject(acknowledgeCalls[0].arguments[0]);
  assertObjectProperty(acknowledgement, undefined, {
    runId: "command.runId",
    commandId: "command.commandId",
    commandFingerprint: "command.commandFingerprint",
    providerReceiptFingerprint: "providerReceiptFingerprint",
  }, sourceFile);
  assertTemplateProperty(
    acknowledgement,
    "providerReceiptId",
    "project-linear-progress-",
    "commandSuffix",
  );
});

test("missing Linear state configuration leaves the durable command retryable", () => {
  const { sourceFile } = parseSource("../main.ts");
  const projectMethod = findMethod(sourceFile, "projectAndDispatchLinearProgress");
  assert.equal(
    findCalls(
      projectMethod,
      sourceFile,
      "this.projectLinearProgressRuntime.recordFailure",
    ).length,
    0,
    "a repairable settings gap must not become an irreversible terminal block",
  );
  assert.match(
    projectMethod.getText(sourceFile),
    /Keep it pending so a later receipt pass can\s+\/\/ dispatch the same command/u,
  );
});

test("verified code receipts project implementation progress before the final handoff", () => {
  const { sourceFile } = parseSource("../main.ts");
  const contextMethod = findMethod(sourceFile, "createToolExecutionContext");
  const stageMethod = findMethod(sourceFile, "persistProjectStageReceipt");
  assert.match(
    contextMethod.getText(sourceFile),
    /persistProjectStageReceipt:\s*\(receipt, executionContext\)\s*=>\s*this\.persistProjectStageReceipt/u,
  );
  assert.equal(
    findCalls(stageMethod, sourceFile, "projectStageEventFromActionReceiptV1").length,
    1,
  );
  assert.match(
    stageMethod.getText(sourceFile),
    /bindings\.length !== 1/u,
    "aggregate receipts must not be broadcast across multiple Linear children",
  );
  assert.equal(
    findCalls(
      stageMethod,
      sourceFile,
      "this.projectLinearProgressRuntime.recordEvents",
    ).length,
    1,
  );
  const projectMethod = findMethod(sourceFile, "projectAndDispatchLinearProgress");
  assert.equal(
    findCalls(
      projectMethod,
      sourceFile,
      "bindAggregateProjectEventsToOnlyWorkUnitV1",
    ).length,
    1,
    "only an exact one-child hierarchy may inherit aggregate lifecycle evidence",
  );
  assert.match(
    contextMethod.getText(sourceFile),
    /getProjectStageEvents:[\s\S]{0,260}projectLinearProgressNamespace\.runs\[requested\]\?\.events/u,
    "Results must read the durable receipt-derived progress timeline",
  );
});

test("the runner forwards committed non-reflection ActionReceipts to the stage host", () => {
  const source = readFileSync(
    new URL("../src/AgentRunner.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /await runToolContext\.persistProjectStageReceipt\?\.\(\s*result\.receipt,\s*runToolContext,?\s*\)/u,
  );
  assert.match(
    source,
    /toolCall\.name !== WRITE_PROJECT_RESULTS_TOOL_NAME[\s\S]{0,160}toolCall\.name !== APPEND_JUPYTER_REFLECTION_TOOL_NAME/u,
  );
});

test("terminal reflection requires completed cursors and applied Linear completion readbacks", () => {
  const { sourceFile } = parseSource("../main.ts");
  const projectMethod = findMethod(sourceFile, "projectAndDispatchLinearProgress");
  const source = projectMethod.getText(sourceFile);
  assert.match(source, /unit\.target !== "completed"/u);
  assert.match(source, /unit\.unpaidAcceptanceCriterionIds\.length > 0/u);
  assert.match(
    source,
    /item\.status === "applied" && item\.target === "completed"/u,
  );
  assert.match(source, /missingCompletionReadback/u);
});

test("a natural joined developer mission ends in Results unless a notebook is requested", () => {
  const prompt = [
    "Research a conflict-free counter and create measurable Linear work.",
    "Implement and test it on desktop, then push a private draft PR to GitHub.",
  ].join(" ");
  const offered = [
    "publish_research_to_linear",
    "publish_research_project_to_linear",
    "linear_create_issue",
    "report_progress_to_linear",
    "code_sandbox_status",
    "code_workspace_create",
    "code_workspace_create_file",
    "code_validate_fast",
    "code_repair_record_cycle",
    "code_validate_targeted",
    "code_validate_full",
    "code_commit_verified",
    "github_create_repository",
    "publish_verified_code_to_github",
    "append_jupyter_reflection",
    "write_project_results",
  ];
  const defaultRoute = getRequiredWriteToolNamesForTests(prompt, offered);
  assert.deepEqual(defaultRoute, [
    "publish_research_to_linear",
    "publish_research_project_to_linear",
    "code_sandbox_status",
    "code_workspace_create",
    "code_workspace_create_file",
    "code_validate_fast",
    "code_repair_record_cycle",
    "code_validate_targeted",
    "code_validate_full",
    "code_commit_verified",
    "github_create_repository",
    "publish_verified_code_to_github",
    "write_project_results",
  ]);
  assert.equal(defaultRoute.includes("append_jupyter_reflection"), false);
  assert.equal(defaultRoute.includes("linear_create_issue"), false);
  assert.equal(defaultRoute.includes("report_progress_to_linear"), false);

  const naturalNotebookRoute = getRequiredWriteToolNamesForTests(
    `${prompt} Write the final scientific reflection to a Jupyter notebook.`,
    offered,
  );
  assert.deepEqual(
    naturalNotebookRoute.slice(0, -1),
    defaultRoute.slice(0, -1),
  );
  assert.equal(naturalNotebookRoute.at(-1), "append_jupyter_reflection");
  assert.equal(naturalNotebookRoute.includes("write_project_results"), false);

  const notebookRoute = getRequiredWriteToolNamesForTests(
    `${prompt} Write the scientific reflection to \`Experiments/counter.ipynb\`.`,
    offered,
  );
  assert.deepEqual(
    notebookRoute.slice(0, -1),
    defaultRoute.slice(0, -1),
  );
  assert.equal(notebookRoute.at(-1), "append_jupyter_reflection");
  assert.equal(notebookRoute.includes("write_project_results"), false);
});

function hierarchyReceipt(runId: string, payloadFingerprint: string): ActionReceipt {
  return {
    version: 1,
    id: "receipt-linear-hierarchy-progress-1",
    runId,
    actionId: "action-linear-hierarchy-progress-1",
    toolName: "publish_research_project_to_linear",
    operation: "create",
    resource: {
      system: "linear",
      resourceType: "project_hierarchy",
      id: "project-progress-1",
    },
    message: "Verified the Linear hierarchy.",
    payloadFingerprint,
    grantId: "grant-progress-context-1",
    idempotencyKey: "linear-hierarchy-progress-1",
    startedAt: NOW,
    committedAt: NOW,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: NOW,
      observedFingerprint: HASH("c"),
    },
  };
}

function parseSource(relativePath: string): { sourceFile: ts.SourceFile } {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  return {
    sourceFile: ts.createSourceFile(
      relativePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
  };
}

function findMethod(sourceFile: ts.SourceFile, name: string): ts.MethodDeclaration {
  const method = descendants(sourceFile).find(
    (node): node is ts.MethodDeclaration =>
      ts.isMethodDeclaration(node) && propertyName(node.name) === name,
  );
  assert.ok(method, `Expected production method ${name}.`);
  return method;
}

function descendants(root: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    nodes.push(node);
    node.forEachChild(visit);
  };
  root.forEachChild(visit);
  return nodes;
}

function findCalls(
  root: ts.Node,
  sourceFile: ts.SourceFile,
  callee: string,
): ts.CallExpression[] {
  return descendants(root).filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && node.expression.getText(sourceFile) === callee,
  );
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText();
}

function expectObject(node: ts.Node | undefined): ts.ObjectLiteralExpression {
  assert.ok(node && ts.isObjectLiteralExpression(node), "Expected an object literal.");
  return node;
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === name,
  );
}

function expectStringProperty(object: ts.ObjectLiteralExpression, name: string): string {
  const assignment = property(object, name);
  assert.ok(assignment && ts.isStringLiteral(assignment.initializer));
  return assignment.initializer.text;
}

function optionalStringProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): string | null {
  const assignment = property(object, name);
  return assignment && ts.isStringLiteral(assignment.initializer)
    ? assignment.initializer.text
    : null;
}

function assertTemplateProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  prefix: string,
  expression: string,
): void {
  const assignment = property(object, name);
  assert.ok(assignment && ts.isTemplateExpression(assignment.initializer));
  assert.equal(assignment.initializer.head.text, prefix);
  assert.equal(assignment.initializer.templateSpans.length, 1);
  assert.equal(assignment.initializer.templateSpans[0].expression.getText(), expression);
}

function assertObjectProperty(
  parent: ts.ObjectLiteralExpression,
  nestedName: string | undefined,
  expected: Record<string, string>,
  sourceFile: ts.SourceFile,
): void {
  const object = nestedName
    ? expectObject(property(parent, nestedName)?.initializer)
    : parent;
  for (const [name, initializer] of Object.entries(expected)) {
    assert.equal(
      objectPropertyInitializerText(object, name, sourceFile),
      initializer,
      `Expected ${name} to remain bound to ${initializer}.`,
    );
  }
}

function objectPropertyInitializerText(
  object: ts.ObjectLiteralExpression,
  name: string,
  sourceFile: ts.SourceFile,
): string | undefined {
  const candidate = object.properties.find(
    (entry) => "name" in entry && entry.name !== undefined && propertyName(entry.name) === name,
  );
  if (!candidate) return undefined;
  if (ts.isPropertyAssignment(candidate)) {
    return candidate.initializer.getText(sourceFile);
  }
  if (ts.isShorthandPropertyAssignment(candidate)) {
    return candidate.name.getText(sourceFile);
  }
  return undefined;
}

function readStateMapping(
  method: ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
): Record<string, string> {
  const statement = descendants(method).find(ts.isSwitchStatement);
  assert.ok(statement, "Expected an exhaustive target-state switch.");
  const mapping: Record<string, string> = {};
  let pending: string[] = [];
  for (const clause of statement.caseBlock.clauses) {
    if (!ts.isCaseClause(clause) || !ts.isStringLiteral(clause.expression)) continue;
    pending.push(clause.expression.text);
    const returned = descendants(clause).find(ts.isReturnStatement);
    if (!returned?.expression) continue;
    for (const target of pending) mapping[target] = returned.expression.getText(sourceFile);
    pending = [];
  }
  return mapping;
}
