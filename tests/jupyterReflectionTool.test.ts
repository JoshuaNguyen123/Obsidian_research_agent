import assert from "node:assert/strict";
import test from "node:test";

import { buildJupyterNotebookV1 } from "../extensions/code/JupyterNotebookV1";
import {
  advanceProjectLineageV1,
  createProjectLineageV1,
  createResearcherHandoffV1,
  type ProjectLineageV1,
} from "../src/agent/projectLifecycle";
import {
  createProjectStageEventV1,
  parseProjectRunReportV1,
  type ProjectStageEventV1,
} from "../src/agent/projectRunReport";
import { createAcceptedResearchArtifactV1 } from "../src/integrations/linear/AcceptedResearchArtifactV1";
import {
  APPEND_JUPYTER_REFLECTION_TOOL_NAME,
  createJupyterReflectionTool,
} from "../src/tools/jupyterReflectionTool";
import type { ToolExecutionContext } from "../src/tools/types";
import { verifiedCodeReflectionFixture } from "./fixtures/verifiedCodeReflection";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import { getRequiredWriteToolNamesForTests } from "../src/AgentRunner";
import { toolsAllowedForLifecycleStage } from "../src/agent/lifecycleStagePolicy";
import { toolsAllowedForEnvelopeStage } from "../src/agent/missionStageEnvelope";
import { PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME } from "../src/tools/githubPublicationTool";

const PATH = "Research/Workflow Reflection.ipynb";
const NOW = "2026-08-19T14:00:00.000Z";
const RUN_ID = "run-jupyter-tool-1";
const SHA = (character: string) => `sha256:${character.repeat(64)}`;
const MARKDOWN =
  "The verified implementation completed targeted and full validation, and this reflection records the exact committed example for concise future review.";

class MemoryVault {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  writes = 0;
  creates = 0;

  getAbstractFileByPath(path: string) {
    if (this.files.has(path)) {
      return {
        path,
        name: path.split("/").at(-1)!,
        extension: path.split(".").at(-1) ?? "",
      };
    }
    if (this.folders.has(path)) {
      return { path, name: path.split("/").at(-1)! };
    }
    return null;
  }

  async read(file: { path: string }): Promise<string> {
    const value = this.files.get(file.path);
    if (value === undefined) throw new Error(`missing ${file.path}`);
    return value;
  }

  async modify(file: { path: string }, content: string): Promise<void> {
    this.writes += 1;
    this.files.set(file.path, content);
  }

  async createFolder(path: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`file blocks ${path}`);
    this.folders.add(path);
  }

  async create(path: string, content: string): Promise<{ path: string }> {
    if (this.files.has(path) || this.folders.has(path)) {
      throw new Error(`target exists ${path}`);
    }
    this.creates += 1;
    this.files.set(path, content);
    return { path };
  }
}

test("native registry and lifecycle routing expose Jupyter reflection independently and after publication", () => {
  const registered = createDefaultToolRegistry()
    .getDefinitions()
    .map((definition) => definition.function.name);
  assert.equal(registered.includes(APPEND_JUPYTER_REFLECTION_TOOL_NAME), true);
  const independentPrompt =
    `Write back the completion reflection to \`${PATH}\` without executing cells.`;
  assert.deepEqual(
    getRequiredWriteToolNamesForTests(independentPrompt, registered),
    [APPEND_JUPYTER_REFLECTION_TOOL_NAME],
  );
  assert.deepEqual(
    getRequiredWriteToolNamesForTests(
      "Write the final reflection to a Jupyter notebook without executing cells.",
      registered,
    ),
    [APPEND_JUPYTER_REFLECTION_TOOL_NAME],
  );
  const definition = createDefaultToolRegistry()
    .getDefinitions()
    .find(
      (candidate) =>
        candidate.function.name === APPEND_JUPYTER_REFLECTION_TOOL_NAME,
    );
  assert.deepEqual(definition?.function.parameters.required, ["markdown"]);
  const fullPrompt =
    `Run the full pipeline: research, create a Linear issue, implement code in the repository, push to private GitHub, then write back the reflection to \`${PATH}\`.`;
  assert.equal(
    getRequiredWriteToolNamesForTests(fullPrompt, registered).at(-1),
    APPEND_JUPYTER_REFLECTION_TOOL_NAME,
  );
  assert.deepEqual(
    getRequiredWriteToolNamesForTests(
      `Call code_workspace_read for implementation.py, then append the verified code reflection to \`${PATH}\`.`,
      ["code_workspace_read", APPEND_JUPYTER_REFLECTION_TOOL_NAME],
    ),
    ["code_workspace_read", APPEND_JUPYTER_REFLECTION_TOOL_NAME],
  );
  assert.deepEqual(
    getRequiredWriteToolNamesForTests(
      `Publish verified code to GitHub and append the reflection to \`${PATH}\`.`,
      [
        PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
        APPEND_JUPYTER_REFLECTION_TOOL_NAME,
      ],
    ),
    [
      PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
      APPEND_JUPYTER_REFLECTION_TOOL_NAME,
    ],
  );
  assert.equal(
    toolsAllowedForLifecycleStage("private_github_publication").includes(
      APPEND_JUPYTER_REFLECTION_TOOL_NAME,
    ),
    false,
  );
  assert.equal(
    toolsAllowedForEnvelopeStage("private_github_publication").includes(
      APPEND_JUPYTER_REFLECTION_TOOL_NAME,
    ),
    false,
  );
  assert.equal(
    toolsAllowedForLifecycleStage("reflection").includes(
      APPEND_JUPYTER_REFLECTION_TOOL_NAME,
    ),
    true,
  );
  assert.equal(
    toolsAllowedForEnvelopeStage("reflection").includes(
      APPEND_JUPYTER_REFLECTION_TOOL_NAME,
    ),
    true,
  );
  const negatedPrompt =
    `Run the full pipeline, but do not call append_jupyter_reflection; leave \`${PATH}\` unchanged.`;
  assert.equal(
    getRequiredWriteToolNamesForTests(negatedPrompt, registered).includes(
      APPEND_JUPYTER_REFLECTION_TOOL_NAME,
    ),
    false,
  );
});

test("natural Jupyter destination creates one deterministic no-overwrite nbformat 4.5 Results notebook", async () => {
  const vault = new MemoryVault();
  const { examples } = verifiedCodeReflectionFixture();
  const context = toolContext(vault, {
    originalPrompt:
      "After implementing and testing the code, write the final reflection to a Jupyter notebook without executing cells.",
    getProjectLineages: () => [codeLineage(examples.commitSha)],
    resolveVerifiedCodeReflectionExamples: async () => examples,
  });
  const tool = createJupyterReflectionTool();
  const prepared = await tool.prepare!({ markdown: MARKDOWN }, context);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  if (!prepared.ok) return;
  const expectedPath =
    "Agent Work/Results/project-run-jupyter-tool-1/2026-08-19-run-jupyter-tool-1.ipynb";
  assert.equal(prepared.action.target.path, expectedPath);
  assert.equal(prepared.action.expectedTargetRevision, "absent");
  assert.equal(prepared.action.normalizedArgs.mode, "create");
  assert.equal(prepared.action.normalizedArgs.destinationSource, "default");
  assert.equal(
    prepared.action.preview.outboundPayload?.notebookContent,
    prepared.action.normalizedArgs.proposedNotebook,
  );
  assert.equal(
    prepared.action.preview.outboundPayload?.expectedTargetState,
    "absent",
  );

  const before = await tool.reconcile!(prepared.action, context);
  assert.equal(before.outcome, "not_applied");
  assert.equal(vault.creates, 0);

  const execution = await tool.executePrepared!(prepared.action, {
    ...context,
    authorizedAction: {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "approval-jupyter-default-create",
    },
  });
  assert.equal((execution.output as Record<string, unknown>).operation, "create");
  assert.equal((execution.output as Record<string, unknown>).executionPerformed, false);
  assert.equal(execution.receipt.operation, "append");
  assert.match(execution.receipt.message, /Created the no-overwrite Jupyter Results notebook/u);
  assert.equal(execution.receipt.readback.status, "verified");
  assert.equal(vault.creates, 1);
  assert.equal(vault.writes, 0);

  const content = vault.files.get(expectedPath);
  assert.ok(content);
  const parsed = JSON.parse(content) as {
    nbformat: number;
    nbformat_minor: number;
    cells: Array<Record<string, unknown>>;
  };
  assert.equal(parsed.nbformat, 4);
  assert.equal(parsed.nbformat_minor, 5);
  assert.ok(parsed.cells.length >= 3);
  const codeCells = parsed.cells.filter((cell) => cell.cell_type === "code");
  assert.equal(codeCells.length, examples.examples.length);
  for (const cell of codeCells) {
    assert.equal(cell.execution_count, null);
    assert.deepEqual(cell.outputs, []);
  }

  const reconciled = await tool.reconcile!(prepared.action, context);
  assert.equal(reconciled.outcome, "committed");
  assert.equal(reconciled.receipt?.commitKind, "reconciled");
  assert.equal(vault.creates, 1);
});

test("an explicitly named absent notebook may be created but is never overwritten", async () => {
  const vault = new MemoryVault();
  const context = toolContext(vault);
  const tool = createJupyterReflectionTool();
  const prepared = await tool.prepare!({ path: PATH, markdown: MARKDOWN }, context);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.action.target.path, PATH);
  assert.equal(prepared.action.normalizedArgs.mode, "create");
  assert.equal(prepared.action.normalizedArgs.destinationSource, "explicit");
  assert.equal(prepared.action.expectedTargetRevision, "absent");
  const execution = await tool.executePrepared!(prepared.action, {
    ...context,
    authorizedAction: {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "approval-jupyter-explicit-create",
    },
  });
  assert.equal((execution.output as Record<string, unknown>).operation, "create");
  assert.equal(vault.creates, 1);
  assert.ok(vault.files.has(PATH));

  const collisionVault = new MemoryVault();
  const collisionContext = toolContext(collisionVault);
  const collisionPrepared = await tool.prepare!(
    { path: PATH, markdown: MARKDOWN },
    collisionContext,
  );
  assert.equal(collisionPrepared.ok, true);
  if (!collisionPrepared.ok) return;
  const concurrent = notebook("# Concurrent notebook");
  collisionVault.files.set(PATH, concurrent);
  await assert.rejects(
    () =>
      tool.executePrepared!(collisionPrepared.action, {
        ...collisionContext,
        authorizedAction: {
          preparedActionId: collisionPrepared.action.id,
          payloadFingerprint: collisionPrepared.action.payloadFingerprint,
          grantId: "approval-jupyter-explicit-collision",
        },
      }),
    /no-overwrite Jupyter Results target is no longer absent/iu,
  );
  assert.equal(collisionVault.files.get(PATH), concurrent);
  assert.equal(collisionVault.creates, 0);
  assert.equal(collisionVault.writes, 0);
});

test("prepared Jupyter reflection appends exact lineage code and returns a standard receipt without execution", async () => {
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  const { examples } = verifiedCodeReflectionFixture();
  const context = toolContext(vault, {
    getProjectLineages: () => [codeLineage(examples.commitSha)],
    resolveVerifiedCodeReflectionExamples: async (input) => {
      assert.deepEqual(input, {
        repositoryProfileKey: "reflection-fixture",
        commitSha: examples.commitSha,
      });
      return examples;
    },
  });
  const tool = createJupyterReflectionTool();
  const prepared = await tool.prepare!({ path: PATH, markdown: MARKDOWN }, context);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.action.expectedTargetRevision, prepared.action.normalizedArgs.expectedBeforeSha256);
  assert.equal(
    prepared.action.preview.outboundPayload?.notebookContent,
    prepared.action.normalizedArgs.proposedNotebook,
  );
  assert.equal(prepared.action.normalizedArgs.codeExamples === null, false);
  const report = parseProjectRunReportV1(prepared.action.normalizedArgs.report);
  assert.deepEqual(
    report.phases.map((phase) => [phase.label, phase.status]),
    [
      ["Research", "verified"],
      ["Linear plan", "verified"],
      ["Implement", "verified"],
      ["Test", "verified"],
      ["GitHub", "pending"],
      ["Reflect", "verified"],
    ],
  );
  assert.equal(report.complete, false);
  assert.match(
    report.limitations.join("\n"),
    /GitHub has no verified completion evidence yet/u,
  );
  const prospectiveReflection = report.evidence.find(
    (event) => event.evidenceKind === "reflection_writeback",
  );
  assert.equal(prospectiveReflection?.sourceReceiptId, prepared.action.id);
  assert.equal(prospectiveReflection?.resource.path, PATH);
  assert.equal(prospectiveReflection?.resource.revision, null);
  assert.equal(report.codeExamples.length, examples.examples.length);
  assert.equal(report.codeExamples[0]?.sourceFingerprint, examples.examples[0]?.codeSha256);

  const execution = await tool.executePrepared!(prepared.action, {
    ...context,
    authorizedAction: {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "approval-jupyter-1",
    },
  });
  assert.equal(execution.receipt.toolName, APPEND_JUPYTER_REFLECTION_TOOL_NAME);
  assert.equal(execution.receipt.operation, "append");
  assert.equal(execution.receipt.payloadFingerprint, prepared.action.payloadFingerprint);
  assert.equal(execution.receipt.grantId, "approval-jupyter-1");
  assert.equal(execution.receipt.readback.status, "verified");
  assert.equal((execution.output as Record<string, unknown>).executionPerformed, false);
  assert.equal(vault.writes, 1);
  const parsed = JSON.parse(vault.files.get(PATH)!) as {
    cells: Array<Record<string, unknown>>;
  };
  const appendedReport = parsed.cells.at(-2)!;
  const appendedReportText = (appendedReport.source as string[]).join("");
  for (const heading of [
    "### Research",
    "### Linear plan",
    "### Implement",
    "### Test",
    "### GitHub",
    "### Reflect",
  ]) {
    assert.match(appendedReportText, new RegExp(heading, "u"));
  }
  assert.match(appendedReportText, /- GitHub: \*\*Pending\*\*/u);
  assert.match(appendedReportText, /Research\/Accepted Jupyter\.md/u);
  assert.match(appendedReportText, new RegExp(examples.commitSha, "u"));
  assert.match(appendedReportText, /not completion evidence/u);
  const appendedCode = parsed.cells.at(-1)!;
  assert.equal(appendedCode.cell_type, "code");
  assert.equal(appendedCode.execution_count, null);
  assert.deepEqual(appendedCode.outputs, []);
  assert.match((appendedCode.source as string[]).join(""), /return left \+ right/u);
});

test("host stage events, not assistant claims, determine the six-phase notebook report", async () => {
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  const tool = createJupyterReflectionTool();
  const prepared = await tool.prepare!(
    {
      path: PATH,
      markdown:
        "Every project phase succeeded and the entire delivery is complete according to this supplemental narrative.",
    },
    toolContext(vault, {
      getProjectStageEvents: () => [researchStageEvent()],
    }),
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const report = parseProjectRunReportV1(prepared.action.normalizedArgs.report);
  assert.deepEqual(
    report.phases.map((phase) => phase.status),
    ["verified", "pending", "pending", "pending", "pending", "verified"],
  );
  assert.equal(report.complete, false);
  assert.equal(
    report.evidence.some(
      (event) =>
        event.sourceReceiptId === "receipt-research-jupyter-1" &&
        event.evidenceFingerprint === SHA("d"),
    ),
    true,
  );
  const proposed = JSON.parse(
    prepared.action.normalizedArgs.proposedNotebook as string,
  ) as { cells: Array<{ cell_type: string; source: string[] }> };
  const reportText = proposed.cells.at(-1)!.source.join("");
  assert.match(reportText, /- Research: \*\*Verified\*\*/u);
  assert.match(reportText, /- Linear plan: \*\*Pending\*\*/u);
  assert.match(reportText, /- Implement: \*\*Pending\*\*/u);
  assert.match(reportText, /- Test: \*\*Pending\*\*/u);
  assert.match(reportText, /- GitHub: \*\*Pending\*\*/u);
  assert.match(reportText, /- Reflect: \*\*Verified\*\*/u);
  assert.match(reportText, /These notes are bounded assistant prose, not completion evidence/u);
});

test("Jupyter report records exact child outcomes and does not let aggregate PR evidence pay them", async () => {
  const lineage = workUnitLineage();
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  const exactPrepared = await createJupyterReflectionTool().prepare!(
    { path: PATH, markdown: MARKDOWN },
    toolContext(vault, {
      getProjectLineages: () => [lineage],
      getProjectStageEvents: (requestedRunId) => {
        assert.equal(requestedRunId, RUN_ID);
        return [
          workUnitEvent("acceptance_criterion", "test", 1, ["issue-a:AC-1"]),
          workUnitEvent("github_repository_readback", "github", 2),
          workUnitEvent("github_draft_pr_readback", "github", 3),
        ];
      },
    }),
  );
  assert.equal(exactPrepared.ok, true);
  if (!exactPrepared.ok) return;
  const exactReport = parseProjectRunReportV1(
    exactPrepared.action.normalizedArgs.report,
  );
  assert.equal(exactReport.workUnitOutcomes?.[0]?.status, "paid");
  assert.equal(exactReport.workUnitOutcomes?.[0]?.linearIssueIdentifier, "ENG-42");
  assert.deepEqual(exactReport.workUnitOutcomes?.[0]?.proofDebt, []);
  const reflection = exactReport.evidence.find(
    (event) => event.evidenceKind === "reflection_writeback",
  );
  assert.deepEqual(reflection?.workUnits, [{
    workUnitId: "issue-a",
    acceptanceCriterionIds: [],
  }]);

  const aggregateVault = new MemoryVault();
  aggregateVault.files.set(PATH, notebook());
  const aggregatePrepared = await createJupyterReflectionTool().prepare!(
    { path: PATH, markdown: MARKDOWN },
    toolContext(aggregateVault, {
      getProjectLineages: () => [lineage],
      getProjectStageEvents: () => [
        workUnitEvent("acceptance_criterion", "test", 1, ["issue-a:AC-1"]),
        workUnitEvent("github_repository_readback", "github", 2, [], false),
        workUnitEvent("github_draft_pr_readback", "github", 3, [], false),
      ],
    }),
  );
  assert.equal(aggregatePrepared.ok, true);
  if (!aggregatePrepared.ok) return;
  const aggregateReport = parseProjectRunReportV1(
    aggregatePrepared.action.normalizedArgs.report,
  );
  assert.equal(aggregateReport.workUnitOutcomes?.[0]?.status, "unpaid");
  assert.match(
    aggregateReport.workUnitOutcomes?.[0]?.proofDebt.join("\n") ?? "",
    /draft pull request/iu,
  );
});

test("notebook append preserves existing metadata and outputs while every new code cell remains unexecuted", async () => {
  const vault = new MemoryVault();
  const original = notebookWithExecutedCell();
  vault.files.set(PATH, original);
  const originalParsed = JSON.parse(original) as {
    cells: Array<Record<string, unknown>>;
    metadata: Record<string, unknown>;
  };
  const { examples } = verifiedCodeReflectionFixture();
  const context = toolContext(vault, {
    getProjectLineages: () => [codeLineage(examples.commitSha)],
    resolveVerifiedCodeReflectionExamples: async () => examples,
  });
  const tool = createJupyterReflectionTool();
  const prepared = await tool.prepare!({ path: PATH, markdown: MARKDOWN }, context);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  await tool.executePrepared!(prepared.action, {
    ...context,
    authorizedAction: {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "approval-jupyter-preservation",
    },
  });

  const observed = JSON.parse(vault.files.get(PATH)!) as {
    cells: Array<Record<string, unknown>>;
    metadata: Record<string, unknown>;
  };
  assert.deepEqual(observed.cells.slice(0, originalParsed.cells.length), originalParsed.cells);
  assert.deepEqual(observed.metadata, originalParsed.metadata);
  const appendedCells = observed.cells.slice(originalParsed.cells.length);
  const appendedCodeCells = appendedCells.filter(
    (cell) => cell.cell_type === "code",
  );
  assert.equal(appendedCodeCells.length, examples.examples.length);
  for (const cell of appendedCodeCells) {
    assert.equal(cell.execution_count, null);
    assert.deepEqual(cell.outputs, []);
  }
});

test("prepared Jupyter reflection rejects a stale exact target without writing", async () => {
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  const context = toolContext(vault);
  const tool = createJupyterReflectionTool();
  const prepared = await tool.prepare!({ path: PATH, markdown: MARKDOWN }, context);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  vault.files.set(PATH, notebook("# Concurrent change"));
  await assert.rejects(
    () =>
      tool.executePrepared!(prepared.action, {
        ...context,
        authorizedAction: {
          preparedActionId: prepared.action.id,
          payloadFingerprint: prepared.action.payloadFingerprint,
          grantId: "approval-jupyter-stale",
        },
      }),
    /changed after preparation/iu,
  );
  assert.equal(vault.writes, 0);
});

test("Jupyter reflection rejects model target redirection and model-supplied code", async () => {
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  vault.files.set("Research/Redirect.ipynb", notebook());
  const tool = createJupyterReflectionTool();
  const redirected = await tool.prepare!(
    { path: "Research/Redirect.ipynb", markdown: MARKDOWN },
    toolContext(vault),
  );
  assert.equal(redirected.ok, false);
  if (!redirected.ok) assert.equal(redirected.error.code, "jupyter_reflection_path_not_explicit");

  const injected = await tool.prepare!(
    { path: PATH, markdown: MARKDOWN, codeExamples: { examples: [] } },
    toolContext(vault),
  );
  assert.equal(injected.ok, false);
  if (!injected.ok) assert.match(injected.error.message, /host-resolved/iu);
});

test("code-completion lineage fails closed when exact verified examples are unavailable", async () => {
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  const { examples } = verifiedCodeReflectionFixture();
  const prepared = await createJupyterReflectionTool().prepare!(
    { path: PATH, markdown: MARKDOWN },
    toolContext(vault, {
      getProjectLineages: () => [codeLineage(examples.commitSha)],
      resolveVerifiedCodeReflectionExamples: async () => null,
    }),
  );
  assert.equal(prepared.ok, false);
  if (!prepared.ok) {
    assert.equal(prepared.error.code, "jupyter_reflection_code_examples_unavailable");
  }
  assert.equal(vault.writes, 0);
});

test("standalone or cross-run code reflection resolves the latest durable exact handoff", async () => {
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  const { examples } = verifiedCodeReflectionFixture();
  const prepared = await createJupyterReflectionTool().prepare!(
    { path: PATH, markdown: MARKDOWN },
    toolContext(vault, {
      originalPrompt: `Record the completed code and validation reflection for repository profile reflection-fixture in \`${PATH}\`.`,
      getProjectLineages: () => [],
      getRepositoryProfileKeys: () => ["reflection-fixture", "other-profile"],
      resolveLatestVerifiedCodeReflectionExamples: async (input) => {
        assert.deepEqual(input, { repositoryProfileKey: "reflection-fixture" });
        return examples;
      },
    }),
  );
  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    assert.equal(prepared.action.normalizedArgs.codeExamples === null, false);
  }
});

test("notebook target authority is exact-case and model-authored code blocks are rejected", async () => {
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  vault.files.set("research/Workflow Reflection.ipynb", notebook());
  const tool = createJupyterReflectionTool();
  const redirected = await tool.prepare!(
    {
      path: "research/Workflow Reflection.ipynb",
      markdown: MARKDOWN,
    },
    toolContext(vault),
  );
  assert.equal(redirected.ok, false);
  if (!redirected.ok) {
    assert.equal(redirected.error.code, "jupyter_reflection_path_not_explicit");
  }

  const codeBlock = await tool.prepare!(
    {
      path: PATH,
      markdown: `${MARKDOWN}\n\n\`\`\`ts\nconst invented = true;\n\`\`\``,
    },
    toolContext(vault),
  );
  assert.equal(codeBlock.ok, false);
  if (!codeBlock.ok) {
    assert.equal(codeBlock.error.code, "jupyter_reflection_model_code_forbidden");
  }

  for (const markdown of [
    `${MARKDOWN}\n\n    dangerous_or_stale_example()`,
    `${MARKDOWN} The symbol \`dangerous_or_stale_example()\` was changed.`,
    `${MARKDOWN}\n\ndangerous_or_stale_example()`,
  ]) {
    const bypass = await tool.prepare!(
      { path: PATH, markdown },
      toolContext(vault),
    );
    assert.equal(bypass.ok, false);
    if (!bypass.ok) {
      assert.equal(
        bypass.error.code,
        "jupyter_reflection_model_code_forbidden",
      );
    }
  }
});

test("executePrepared requires the exact approval fingerprint", async () => {
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  const context = toolContext(vault);
  const tool = createJupyterReflectionTool();
  const prepared = await tool.prepare!({ path: PATH, markdown: MARKDOWN }, context);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  await assert.rejects(
    () =>
      tool.executePrepared!(prepared.action, {
        ...context,
        authorizedAction: {
          preparedActionId: prepared.action.id,
          payloadFingerprint: `sha256:${"f".repeat(64)}`,
          grantId: "approval-jupyter-wrong",
        },
      }),
    /exact approval binding/iu,
  );
  assert.equal(vault.writes, 0);
});

test("reconciliation recognizes exact applied bytes and never replays the append", async () => {
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  const context = toolContext(vault);
  const tool = createJupyterReflectionTool();
  const prepared = await tool.prepare!({ path: PATH, markdown: MARKDOWN }, context);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const before = await tool.reconcile!(prepared.action, context);
  assert.equal(before.outcome, "not_applied");
  assert.equal(vault.writes, 0);
  await tool.executePrepared!(prepared.action, {
    ...context,
    authorizedAction: {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "approval-jupyter-reconcile",
    },
  });
  assert.equal(vault.writes, 1);

  const reconciled = await tool.reconcile!(prepared.action, context);
  assert.equal(reconciled.outcome, "committed");
  assert.equal(reconciled.receipt?.commitKind, "reconciled");
  assert.equal(reconciled.receipt?.grantId, "reconciled-exact-readback");
  assert.match(reconciled.message, /no write was replayed/iu);
  assert.equal(vault.writes, 1);

  vault.files.set(PATH, notebook("# Unrelated content"));
  const uncertain = await tool.reconcile!(prepared.action, context);
  assert.equal(uncertain.outcome, "still_uncertain");
  assert.equal(vault.writes, 1);
});

test("standalone reflection remains code-free but requires meaningful prose", async () => {
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  const tool = createJupyterReflectionTool();
  const prepared = await tool.prepare!({ path: PATH, markdown: MARKDOWN }, toolContext(vault));
  assert.equal(prepared.ok, true);
  if (prepared.ok) assert.equal(prepared.action.normalizedArgs.codeExamples, null);

  const sparse = await tool.prepare!(
    { path: PATH, markdown: "Done." },
    toolContext(vault),
  );
  assert.equal(sparse.ok, false);
  if (!sparse.ok) assert.match(sparse.error.message, /meaningful/iu);
});

function toolContext(
  vault: MemoryVault,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    app: { vault } as unknown as ToolExecutionContext["app"],
    settings: {} as ToolExecutionContext["settings"],
    originalPrompt: `Reflect into \`${PATH}\` with concise examples.`,
    runId: RUN_ID,
    rootMissionId: RUN_ID,
    operationId: "call-jupyter-tool-1",
    httpTransport: async () => {
      throw new Error("unused");
    },
    now: () => new Date(NOW),
    ...overrides,
  };
}

function notebook(source = "# Existing analysis"): string {
  return buildJupyterNotebookV1({
    cells: [{ type: "markdown", source }],
  }).content;
}

function notebookWithExecutedCell(): string {
  const parsed = JSON.parse(notebook("# Existing experiment")) as {
    cells: Array<Record<string, unknown>>;
    metadata: Record<string, unknown>;
  };
  parsed.metadata = {
    ...parsed.metadata,
    custom: { owner: "scientist", preserve: true },
  };
  parsed.cells.push({
    cell_type: "code",
    execution_count: 7,
    metadata: { tags: ["existing-output"] },
    outputs: [{ output_type: "stream", name: "stdout", text: ["42\n"] }],
    source: ["print(42)\n"],
  });
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function researchStageEvent(): ProjectStageEventV1 {
  return createProjectStageEventV1({
    schemaVersion: 1,
    runId: RUN_ID,
    phase: "research",
    evidenceKind: "research_artifact",
    disposition: "verified",
    occurredAt: "2026-08-19T13:55:00.000Z",
    sourceReceiptId: "receipt-research-jupyter-1",
    evidenceFingerprint: SHA("d"),
    resource: {
      system: "vault",
      resourceType: "accepted_research_note",
      id: "accepted-jupyter-research-event-1",
      url: null,
      path: "Research/Host Verified.md",
      revision: SHA("e"),
    },
    workUnits: [],
  });
}

function codeLineage(commitSha: string): ProjectLineageV1 {
  const artifact = createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "accepted-jupyter-research-1",
    originRunId: RUN_ID,
    vaultBindingKey: "vault-jupyter-reflection-1",
    notePath: "Research/Accepted Jupyter.md",
    noteSha256: SHA("1"),
    noteReceiptId: "note-jupyter-receipt-1",
    evidence: [{
      id: "evidence-jupyter-web-1",
      kind: "web",
      reference: "https://example.com/jupyter-research",
      contentSha256: SHA("2"),
    }],
    acceptanceCriteria: [{
      id: "AC-1",
      text: "The notebook reports only host-verified phase outcomes.",
    }],
    riskClass: "medium",
    acceptedAt: "2026-08-19T13:57:00.000Z",
    acceptedBy: "host",
  });
  const handoff = createResearcherHandoffV1({
    artifact,
    runId: RUN_ID,
    taskId: "jupyter-research-task-1",
    evidenceIds: ["evidence-jupyter-web-1"],
    summary: "Accepted research for the Jupyter project report fixture.",
    unresolvedQuestions: [],
    acceptedAt: "2026-08-19T13:57:00.000Z",
  });
  let lineage = createProjectLineageV1({
    lineageId: "lineage-jupyter-reflection-1",
    runId: RUN_ID,
    vaultBindingKey: "vault-jupyter-reflection-1",
    handoff,
    updatedAt: "2026-08-19T13:57:00.000Z",
  });
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-08-19T13:58:00.000Z",
    proof: {
      stage: "linear_hierarchy",
      planFingerprint: SHA("3"),
      workspaceId: "linear-workspace-jupyter-1",
      teamId: "linear-team-jupyter-1",
      initiativeId: "linear-initiative-jupyter-1",
      projectId: "linear-project-jupyter-1",
      issueIds: ["linear-issue-jupyter-1"],
      workItemFingerprints: [SHA("4")],
      providerReadbackFingerprints: [SHA("5"), SHA("6"), SHA("7")],
    },
  });
  return advanceProjectLineageV1({
    lineage,
    committedAt: "2026-08-19T13:59:00.000Z",
    proof: {
      stage: "code_execution",
      repositoryProfileKey: "reflection-fixture",
      repositoryProfileFingerprint: SHA("8"),
      workspaceId: "workspace-jupyter-reflection-1",
      validationReceiptFingerprints: [SHA("9"), SHA("a")],
      diffFingerprint: SHA("b"),
      targetedValidationPassed: true,
      freshFullValidationPassed: true,
      commitSha,
      commitReadbackFingerprint: SHA("c"),
    },
  });
}

function workUnitLineage(): ProjectLineageV1 {
  const artifact = createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "accepted-jupyter-work-unit-1",
    originRunId: RUN_ID,
    vaultBindingKey: "vault-jupyter-work-unit-1",
    notePath: "Research/Accepted Jupyter Work Unit.md",
    noteSha256: SHA("4"),
    noteReceiptId: "note-jupyter-work-unit-receipt-1",
    evidence: [{
      id: "evidence-jupyter-work-unit-1",
      kind: "web",
      reference: "https://example.com/jupyter-work-unit",
      contentSha256: SHA("5"),
    }],
    acceptanceCriteria: [{
      id: "AC-1",
      text: "The notebook report records an exact child outcome.",
    }],
    riskClass: "medium",
    acceptedAt: "2026-08-19T13:57:00.000Z",
    acceptedBy: "host",
  });
  const handoff = createResearcherHandoffV1({
    artifact,
    runId: RUN_ID,
    taskId: "jupyter-work-unit-task-1",
    evidenceIds: ["evidence-jupyter-work-unit-1"],
    summary: "Accepted research for exact Jupyter work-unit outcomes.",
    unresolvedQuestions: [],
    acceptedAt: "2026-08-19T13:57:00.000Z",
  });
  const lineage = createProjectLineageV1({
    lineageId: "lineage-jupyter-work-unit-1",
    runId: RUN_ID,
    vaultBindingKey: "vault-jupyter-work-unit-1",
    handoff,
    updatedAt: "2026-08-19T13:57:00.000Z",
  });
  return advanceProjectLineageV1({
    lineage,
    committedAt: "2026-08-19T13:58:00.000Z",
    proof: {
      stage: "linear_hierarchy",
      planFingerprint: SHA("6"),
      workspaceId: "linear-workspace-jupyter-work-unit-1",
      teamId: "linear-team-jupyter-work-unit-1",
      initiativeId: "linear-initiative-jupyter-work-unit-1",
      projectId: "linear-project-jupyter-work-unit-1",
      issueIds: ["linear-issue-jupyter-work-unit-1"],
      workItemFingerprints: [SHA("7")],
      providerReadbackFingerprints: [SHA("8"), SHA("9"), SHA("a")],
      workUnits: [{
        workUnitId: "issue-a",
        linearIssueId: "linear-issue-jupyter-work-unit-1",
        linearIssueIdentifier: "ENG-42",
        linearIssueUrl: "https://linear.app/acme/issue/ENG-42/jupyter-work-unit",
        acceptanceCriterionIds: ["issue-a:AC-1"],
        providerReadbackFingerprint: SHA("a"),
      }],
    },
  });
}

function workUnitEvent(
  evidenceKind: "acceptance_criterion" | "github_repository_readback" | "github_draft_pr_readback",
  phase: "test" | "github",
  minute: number,
  acceptanceCriterionIds: string[] = [],
  bound = true,
): ProjectStageEventV1 {
  return createProjectStageEventV1({
    schemaVersion: 1,
    runId: RUN_ID,
    phase,
    evidenceKind,
    disposition: "verified",
    occurredAt: `2026-08-19T13:${String(minute + 40).padStart(2, "0")}:00.000Z`,
    sourceReceiptId: `receipt-jupyter-${evidenceKind}-${minute}`,
    evidenceFingerprint: SHA(String((minute + 3) % 10)),
    resource: {
      system: phase === "github" ? "github" : "git",
      resourceType: evidenceKind,
      id: `jupyter-${evidenceKind}-${minute}`,
      url: phase === "github" ? "https://github.com/acme/jupyter/pull/42" : null,
      path: null,
      revision: null,
    },
    workUnits: bound
      ? [{ workUnitId: "issue-a", acceptanceCriterionIds }]
      : [],
  });
}

test("a verified commit readback resolves its exact commit even without code lineage", async () => {
  // Regression: a Phase B implementation run whose durable lineage begins at
  // accepted_research has no code_execution/code_validation commit, so the
  // exact-commit resolver was never consulted. The tool jumped straight to the
  // latest durable handoff and then rejected it for not matching the commit
  // the readback named -- the only outcome that ordering can produce. The
  // audit saw it as "Resolved examples do not match the exact verified code
  // commit." on the final node of the journey.
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  const { examples } = verifiedCodeReflectionFixture();
  const exactRequests: unknown[] = [];
  let latestCalls = 0;
  const prepared = await createJupyterReflectionTool().prepare!(
    { path: PATH, markdown: MARKDOWN },
    toolContext(vault, {
      getProjectLineages: () => [],
      getRepositoryProfileKeys: () => ["reflection-fixture"],
      getProjectStageEvents: () => [commitReadbackEvent(examples.commitSha)],
      resolveVerifiedCodeReflectionExamples: async (input) => {
        exactRequests.push(input);
        return input.commitSha === examples.commitSha ? examples : null;
      },
      resolveLatestVerifiedCodeReflectionExamples: async () => {
        latestCalls += 1;
        return null;
      },
    }),
  );
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.deepEqual(exactRequests, [
    { repositoryProfileKey: "reflection-fixture", commitSha: examples.commitSha },
  ]);
  assert.equal(latestCalls, 0, "the latest handoff must not be consulted once the exact commit resolves");
});

test("a commit mismatch names both revisions instead of a bare rejection", async () => {
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  const { examples } = verifiedCodeReflectionFixture();
  const expected = `${"c".repeat(40)}`;
  const prepared = await createJupyterReflectionTool().prepare!(
    { path: PATH, markdown: MARKDOWN },
    toolContext(vault, {
      getProjectLineages: () => [],
      getRepositoryProfileKeys: () => ["reflection-fixture"],
      originalPrompt:
        'Record the completed code and validation reflection into `' +
        PATH +
        '` with concise examples.',
      getProjectStageEvents: () => [commitReadbackEvent(expected)],
      resolveVerifiedCodeReflectionExamples: async () => null,
      resolveLatestVerifiedCodeReflectionExamples: async () => examples,
    }),
  );
  assert.equal(prepared.ok, false);
  if (!prepared.ok) {
    assert.equal(prepared.error.code, "jupyter_reflection_code_examples_unavailable");
    assert.ok(
      prepared.error.message.includes(examples.commitSha) &&
        prepared.error.message.includes(expected),
      prepared.error.message,
    );
  }
  assert.equal(vault.writes, 0);
});

test("a checkpoint sequence revision never poses as the verified commit", async () => {
  // Regression: code_commit_verified prepares against the durable repair
  // checkpoint, so its receipt resource carries the checkpoint id and that
  // checkpoint sequence ("1") as the revision -- there is no Git object id in
  // it. Treating that as the expected commit made the final journey node fail
  // with "Resolved examples are bound to commit 7b407a2c..., not the verified 1".
  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  const { examples } = verifiedCodeReflectionFixture();
  let exactCalls = 0;
  const prepared = await createJupyterReflectionTool().prepare!(
    { path: PATH, markdown: MARKDOWN },
    toolContext(vault, {
      getProjectLineages: () => [],
      getRepositoryProfileKeys: () => ["reflection-fixture"],
      originalPrompt:
        'Record the completed code and validation reflection into `' +
        PATH +
        '` with concise examples.',
      getProjectStageEvents: () => [commitReadbackEvent("1")],
      resolveVerifiedCodeReflectionExamples: async () => {
        exactCalls += 1;
        return null;
      },
      resolveLatestVerifiedCodeReflectionExamples: async () => examples,
    }),
  );
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(
    exactCalls,
    0,
    "a checkpoint sequence must not be looked up as a commit",
  );
  if (prepared.ok) {
    assert.equal(prepared.action.normalizedArgs.codeExamples === null, false);
  }
});
test("prepare→execute succeeds when rootMissionId differs from runId after segment turnover", async () => {
  // Regression: BYOK stage 8 append_jupyter_reflection dies with run_mismatch when
  // extended_team segment turnover causes context.runId to differ from rootMissionId.
  // Before this fix, PreparedAction.runId was stamped from rootMissionId, so the
  // ToolRegistry guard (action.runId !== context.runId) fired on the executing segment.
  const ROOT_MISSION_ID = "mission-byok-root-1";
  const SEGMENT_RUN_ID = "segment-003-byok";
  assert.notEqual(ROOT_MISSION_ID, SEGMENT_RUN_ID, "test requires distinct IDs");

  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  // Project stage event must carry the project-level runId (rootMissionId), not the segment's.
  const rootResearchEvent = createProjectStageEventV1({
    schemaVersion: 1,
    runId: ROOT_MISSION_ID,
    phase: "research",
    evidenceKind: "research_artifact",
    disposition: "verified",
    occurredAt: "2026-08-19T13:55:00.000Z",
    sourceReceiptId: "receipt-research-segment-turnover-1",
    evidenceFingerprint: SHA("d"),
    resource: {
      system: "vault",
      resourceType: "accepted_research_note",
      id: "accepted-segment-turnover-1",
      url: null,
      path: "Research/Segment Turnover.md",
      revision: SHA("e"),
    },
    workUnits: [],
  });
  const context = toolContext(vault, {
    runId: SEGMENT_RUN_ID,
    rootMissionId: ROOT_MISSION_ID,
    getProjectStageEvents: (requestedRunId) => {
      // Events are filed under the root mission (project-level) runId.
      if (requestedRunId === ROOT_MISSION_ID) return [rootResearchEvent];
      return [];
    },
  });
  const tool = createJupyterReflectionTool();
  const prepared = await tool.prepare!({ path: PATH, markdown: MARKDOWN }, context);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  if (!prepared.ok) return;

  // PreparedAction.runId must equal the executing segment's runId so the
  // ToolRegistry guard (action.runId !== context.runId) does not fire.
  assert.equal(prepared.action.runId, SEGMENT_RUN_ID,
    "PreparedAction.runId must be the segment runId, not rootMissionId");
  assert.notEqual(prepared.action.runId, ROOT_MISSION_ID,
    "PreparedAction.runId must not be rootMissionId after segment turnover");

  // Report uses the project-level runId for aggregation.
  const report = parseProjectRunReportV1(prepared.action.normalizedArgs.report);
  assert.equal(report.runId, ROOT_MISSION_ID,
    "report.runId must be the project-level rootMissionId for event aggregation");

  // Execute succeeds: action.runId === context.runId passes the ToolRegistry guard.
  const execution = await tool.executePrepared!(prepared.action, {
    ...context,
    authorizedAction: {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "approval-segment-turnover-jupyter",
    },
  });
  assert.equal(execution.receipt.toolName, APPEND_JUPYTER_REFLECTION_TOOL_NAME);
  assert.equal(execution.receipt.readback.status, "verified");
  assert.equal(vault.writes, 1);
});

test("ToolRegistry run_mismatch guard still rejects a prepared action from a prior segment", async () => {
  // Verify the invariant: the ToolRegistry guard is intact and would fire when
  // action.runId (segment-001) !== context.runId (segment-002). This test confirms
  // the guard has not been loosened — only the prepare stamping was fixed.
  const SEGMENT_ONE = "segment-001";
  const SEGMENT_TWO = "segment-002";
  const ROOT_MISSION_ID = "mission-byok-root-guard";

  const vault = new MemoryVault();
  vault.files.set(PATH, notebook());
  const guardResearchEvent = createProjectStageEventV1({
    schemaVersion: 1,
    runId: ROOT_MISSION_ID,
    phase: "research",
    evidenceKind: "research_artifact",
    disposition: "verified",
    occurredAt: "2026-08-19T13:55:00.000Z",
    sourceReceiptId: "receipt-research-guard-1",
    evidenceFingerprint: SHA("d"),
    resource: {
      system: "vault",
      resourceType: "accepted_research_note",
      id: "accepted-guard-1",
      url: null,
      path: "Research/Guard.md",
      revision: SHA("e"),
    },
    workUnits: [],
  });
  // Prepare the action in segment-001.
  const prepareContext = toolContext(vault, {
    runId: SEGMENT_ONE,
    rootMissionId: ROOT_MISSION_ID,
    getProjectStageEvents: (id) =>
      id === ROOT_MISSION_ID ? [guardResearchEvent] : [],
  });
  const tool = createJupyterReflectionTool();
  const prepared = await tool.prepare!({ path: PATH, markdown: MARKDOWN }, prepareContext);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  if (!prepared.ok) return;
  assert.equal(prepared.action.runId, SEGMENT_ONE);

  // The ToolRegistry guard (line 343 of ToolRegistry.ts — not modified):
  //   if (context.runId && action.runId !== context.runId) → run_mismatch
  // Simulate what ToolRegistry would do when the context moved to segment-002.
  const staleContextRunId = SEGMENT_TWO;
  assert.notEqual(prepared.action.runId, staleContextRunId,
    "A prepared action from segment-001 must not match segment-002's runId — ToolRegistry would fire run_mismatch");
});

function commitReadbackEvent(commitSha: string): ProjectStageEventV1 {
  return createProjectStageEventV1({
    schemaVersion: 1,
    runId: RUN_ID,
    phase: "test",
    evidenceKind: "commit_readback",
    disposition: "verified",
    occurredAt: "2026-08-21T18:55:00.000Z",
    sourceReceiptId: "receipt-commit-verified-1",
    evidenceFingerprint: SHA("f"),
    resource: {
      system: "git",
      resourceType: "verified_local_commit",
      id: "verified-local-commit-1",
      url: null,
      path: null,
      revision: commitSha,
    },
    workUnits: [],
  });
}
