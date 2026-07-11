import test from "node:test";
import assert from "node:assert/strict";
import {
  applyResearchEvidence,
  evaluateResearchAcceptance,
  type ResearchEvidence,
  type ResearchPlan,
} from "../src/agent/researchPlan";
import {
  acknowledgeEvidenceConflict,
  detectEvidenceConflicts,
} from "../src/agent/evidenceConflicts";
import {
  createMissionPlan,
  getNextMissionPlanAction,
  type MissionPlan,
} from "../src/agent/missionPlan";
import {
  advanceMissionPlanFromReceipt,
  advanceMissionPlanFromToolResult,
} from "../src/agent/missionPlanAdvance";
import { runMissionVerifiers } from "../src/agent/verifiers";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import { evidenceFromToolResult } from "../src/agent/missionEvidence";
import { upsertMissionEvidenceRecord } from "../src/agent/missionLedger";
import type { MissionIntent, ToolExecutionResult } from "../src/tools/types";

test("research evidence binds to one relevant subquestion unless explicitly targeted", () => {
  const plan = researchPlan();
  const navigation: ResearchEvidence = {
    id: "web_search:quantum",
    kind: "web_source",
    title: "Search results",
    summary: "Candidate links only.",
    confidence: "medium",
  };
  const afterNavigation = applyResearchEvidence(plan, [navigation]);

  assert.deepEqual(
    afterNavigation.subquestions.map((item) => item.evidenceIds),
    [[], [], []],
  );
  assert.equal(afterNavigation.nextAction?.toolName, "web_fetch");

  const explicitlyBound = webEvidence(
    "web:comparison",
    "https://comparison.example.org/report",
    { subquestionId: "rq-2" },
  );
  const relevant = webEvidence(
    "web:quantum",
    "https://research.example.com/quantum-battery",
  );
  const synthesis = webEvidence(
    "web:limits",
    "https://analysis.example.net/limitations",
  );
  const applied = applyResearchEvidence(plan, [explicitlyBound, relevant, synthesis]);

  assert.deepEqual(applied.subquestions.map((item) => item.evidenceIds), [
    ["web:quantum"],
    ["web:comparison"],
    ["web:limits"],
  ]);
  assert.equal(applied.status, "complete");
});

test("merged same-source evidence keeps a later section passage when bound", () => {
  const url = "https://research.example.com/sectioned-quantum-report";
  const first = evidenceFromToolResult(
    "read_source_section",
    okResult("read_source_section", {
      url,
      normalizedUrl: url,
      title: "Sectioned quantum report",
      sourceStartChar: 0,
      content: "Quantum battery evidence from the first section.",
    }),
  );
  const second = evidenceFromToolResult(
    "read_source_section",
    okResult("read_source_section", {
      url,
      normalizedUrl: url,
      title: "Sectioned quantum report",
      sourceStartChar: 6000,
      content: "Quantum battery limitations from the second section.",
    }),
  );
  assert.ok(first?.passageId);
  assert.ok(second?.passageId);

  const evidence: ResearchEvidence[] = [];
  upsertMissionEvidenceRecord(evidence, {
    ...first,
    subquestionId: "rq-1",
  });
  upsertMissionEvidenceRecord(evidence, {
    ...second,
    subquestionId: "rq-1",
  });
  assert.equal(evidence.length, 1);
  assert.ok(evidence[0].passageIds?.includes(first.passageId));
  assert.ok(evidence[0].passageIds?.includes(second.passageId));

  const applied = applyResearchEvidence(researchPlan(), evidence);
  assert.deepEqual(applied.subquestions[0].evidenceIds, [first.id]);
});

test("search navigation does not prove a fetched source or a vault content read", () => {
  let plan = createPlan(
    "Search my vault for Project Alpha before answering.",
    ["semantic_search_notes", "read_file"],
    false,
  );
  plan = advanceMissionPlanFromToolResult({
    plan,
    toolName: "semantic_search_notes",
    result: okResult("semantic_search_notes", { results: [{ path: "Alpha.md" }] }),
    evidence: {
      id: "vault_search:alpha",
      kind: "vault_note",
      title: "Vault candidates",
      path: "Alpha.md",
      summary: "Candidate path and snippet.",
      confidence: "medium",
    },
  }).plan;

  assert.equal(plan.tasks[0].status, "in_progress");
  assert.equal(getNextMissionPlanAction(plan)?.toolName, "read_file");

  plan = advanceMissionPlanFromToolResult({
    plan,
    toolName: "read_file",
    result: okResult("read_file", { path: "Alpha.md", content: "Project Alpha evidence." }),
    evidence: {
      id: "vault:alpha",
      kind: "vault_note",
      title: "Alpha.md",
      path: "Alpha.md",
      summary: "Project Alpha evidence.",
      confidence: "high",
    },
  }).plan;

  assert.equal(plan.tasks[0].status, "complete");
});

test("specialized receipts satisfy only their matching mission-plan proof", () => {
  let renamePlan = createPlan(
    "Rename the current note to Project Alpha.",
    ["rename_current_file"],
    true,
  );
  assert.deepEqual(renamePlan.tasks[0].completionContract.requiredProof, [
    "rename_receipt",
  ]);

  renamePlan = advanceMissionPlanFromReceipt({
    plan: renamePlan,
    receipt: {
      toolName: "append_to_current_file",
      operation: "append",
      path: "Current.md",
      message: "Appended text.",
      bytesWritten: 10,
    },
  }).plan;
  assert.equal(renamePlan.tasks[0].status, "in_progress");

  renamePlan = advanceMissionPlanFromReceipt({
    plan: renamePlan,
    receipt: {
      toolName: "rename_current_file",
      operation: "rename_current_file",
      path: "Current.md",
      toPath: "Project Alpha.md",
      message: "Renamed note.",
    },
  }).plan;
  assert.equal(renamePlan.tasks[0].status, "complete");

  let writePlan = createPlan(
    "Append Project Alpha to the current note.",
    ["append_to_current_file"],
    true,
  );
  writePlan = advanceMissionPlanFromReceipt({
    plan: writePlan,
    receipt: {
      toolName: "rename_current_file",
      operation: "rename_current_file",
      path: "Current.md",
      toPath: "Project Alpha.md",
      message: "Renamed note.",
    },
  }).plan;
  assert.equal(writePlan.tasks[0].status, "in_progress");
});

test("verifiers require per-task fetched coverage, topic relevance, and passage citations", () => {
  const source = evidenceFromToolResult(
    "web_fetch",
    okResult("web_fetch", {
      title: "Quantum battery research",
      url: "https://research.example.com/quantum-battery",
      normalizedUrl: "https://research.example.com/quantum-battery",
      query: "latest quantum battery evidence",
      content:
        "Quantum battery evidence compares independent sources and documents current limitations.",
    }),
  );
  assert.ok(source);
  assert.ok(source.passageId?.startsWith("source:"));
  assert.ok(source.passageId?.includes(":passage:"));
  let plan = createPlan(
    "Research latest quantum battery sources and append a cited brief to the current note.",
    ["web_search", "web_fetch", "append_to_current_file"],
    true,
  );
  assert.equal(
    plan.tasks.find((task) =>
      task.completionContract.requiredProof.includes("web_evidence"),
    )?.completionContract.citationMode,
    "passage",
  );

  const unbound = runMissionVerifiers({
    plan,
    evidence: [source],
    receipts: [],
  });
  assert.ok(
    unbound.missing.includes(
      "verifier:task-research-web:source_coverage:0/1",
    ),
  );

  plan = advanceMissionPlanFromToolResult({
    plan,
    toolName: "web_fetch",
    result: okResult("web_fetch", { url: source.url, content: source.summary }),
    evidence: source,
  }).plan;
  const receipt = {
    toolName: "append_to_current_file" as const,
    operation: "append" as const,
    path: "Current.md",
    message: "Appended cited brief.",
    bytesWritten: 120,
  };
  plan = advanceMissionPlanFromReceipt({ plan, receipt }).plan;

  const urlOnly = runMissionVerifiers({
    plan,
    evidence: [source],
    receipts: [receipt],
    finalOutput: `Quantum battery findings: ${source.url}`,
  });
  assert.ok(
    urlOnly.missing.includes("verifier:citation_coverage:task-research-web"),
  );

  const irrelevant = runMissionVerifiers({
    plan,
    evidence: [source],
    receipts: [receipt],
    finalOutput: `Weather forecast [${source.passageId}].`,
  });
  assert.ok(irrelevant.missing.includes("verifier:final_relevance"));

  const verified = runMissionVerifiers({
    plan,
    evidence: [source],
    receipts: [receipt],
    finalOutput: `Quantum battery findings are supported by [${source.passageId}].`,
  });
  assert.equal(verified.status, "pass");
});

test("ordinary web summaries accept source URLs while preserving passage proof", () => {
  const source = evidenceFromToolResult(
    "web_fetch",
    okResult("web_fetch", {
      title: "API documentation",
      url: "https://example.com/api-docs",
      content: "API documentation describes the supported request schema.",
    }),
  );
  assert.ok(source?.passageId);
  let plan = createPlan(
    "Search the web for API documentation and summarize it with source URLs.",
    ["web_search", "web_fetch"],
    false,
  );
  assert.equal(plan.tasks[0].completionContract.citationMode, "source");
  plan = advanceMissionPlanFromToolResult({
    plan,
    toolName: "web_fetch",
    result: okResult("web_fetch", { url: source.url, content: source.summary }),
    evidence: source,
  }).plan;

  const verified = runMissionVerifiers({
    plan,
    evidence: [source],
    receipts: [],
    finalOutput: `API documentation summary: ${source.url}`,
  });
  assert.ok(
    !verified.missing.includes("verifier:citation_coverage:task-1"),
  );
});

test("similar vault note indices do not create numeric evidence conflicts", () => {
  const conflicts = detectEvidenceConflicts([
    {
      id: "vault_search:1",
      text: "E2E_DEEP_VAULT_CONTEXT note 1 discusses local retrieval, evidence coverage, and semantic expansion.",
    },
    {
      id: "vault_search:42",
      text: "E2E_DEEP_VAULT_TARGET note 42 discusses local retrieval, evidence coverage, and semantic expansion.",
    },
    {
      id: "vault:scaled-042",
      text: "# Scaled Vault 42\n\nE2E_DEEP_VAULT_TARGET note 42 discusses local retrieval, evidence coverage, and semantic expansion.",
    },
  ]);
  assert.equal(conflicts.length, 0);
});

test("two opposing passages detect an open evidence conflict", () => {
  const conflicts = detectEvidenceConflicts([
    {
      id: "source:alpha:passage:0",
      text: "Independent trials show the quantum battery electrolyte remains stable under load.",
    },
    {
      id: "source:beta:passage:0",
      text: "Independent trials show the quantum battery electrolyte does not remain stable under load.",
    },
  ]);

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].status, "open");
  assert.deepEqual(conflicts[0].passageIds, [
    "source:alpha:passage:0",
    "source:beta:passage:0",
  ].sort());
  assert.deepEqual(conflicts[0].claimIds, []);
});

test("open evidence conflicts force research acceptance needs_more_work", () => {
  const conflicts = detectEvidenceConflicts([
    {
      id: "p1",
      text: "The catalyst efficiency reaches 92 percent in production trials.",
    },
    {
      id: "p2",
      text: "The catalyst efficiency reaches 41 percent in production trials.",
    },
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].status, "open");

  const plan = hybridResearchPlan();
  const evidence = hybridEvidence();
  const openResult = evaluateResearchAcceptance({
    plan,
    evidence,
    conflicts,
    finalOutput:
      "Hybrid findings cite https://alpha.example.com/a and Notes/Alpha.md.\n\nLimitations: e2e.\n\nConfidence: medium.",
  });
  assert.ok(
    openResult.missing.some((item) => item.startsWith("open_evidence_conflicts")),
  );

  const verifier = runMissionVerifiers({
    plan: createPlan(
      "Deep research quantum batteries with vault notes and web sources.",
      ["web_search", "web_fetch", "read_file"],
      false,
    ),
    evidence,
    receipts: [],
    conflicts,
    finalOutput:
      "Hybrid findings cite https://alpha.example.com/a.\n\nLimitations: e2e.\n\nConfidence: medium.",
  });
  assert.equal(verifier.status, "needs_more_work");
  assert.ok(
    verifier.missing.some((item) => item.includes("open_evidence_conflicts")),
  );
});

test("acknowledged_limitation allows research acceptance with explicit limitation text", () => {
  const open = detectEvidenceConflicts([
    {
      id: "p1",
      text: "Clinic data show treatment X improves recovery rates.",
    },
    {
      id: "p2",
      text: "Clinic data show treatment X does not improve recovery rates.",
    },
  ]);
  assert.equal(open.length, 1);
  const acknowledged = acknowledgeEvidenceConflict(
    open[0],
    "Sources disagree on recovery rates",
  );
  assert.equal(acknowledged.status, "acknowledged_limitation");

  const plan = hybridResearchPlan();
  const evidence = hybridEvidence();
  const withoutLimitation = evaluateResearchAcceptance({
    plan,
    evidence,
    conflicts: [acknowledged],
    finalOutput:
      "Hybrid findings cite https://alpha.example.com/a and Notes/Alpha.md.\n\nConfidence: medium.",
  });
  assert.ok(
    withoutLimitation.missing.some((item) =>
      item.startsWith("conflict_limitation_text"),
    ) || withoutLimitation.missing.includes("limitations_section"),
  );

  const accepted = evaluateResearchAcceptance({
    plan,
    evidence,
    conflicts: [acknowledged],
    finalOutput:
      "Hybrid findings cite https://alpha.example.com/a and Notes/Alpha.md.\n\nLimitations: Sources disagree on recovery rates.\n\nConfidence: medium.",
  });
  assert.equal(accepted.missing.filter((item) => item.includes("conflict")).length, 0);
  assert.ok(!accepted.missing.some((item) => item.startsWith("open_evidence_conflicts")));

  const verifier = runMissionVerifiers({
    plan: createPlan(
      "Deep research quantum batteries with vault notes and web sources.",
      ["web_search", "web_fetch", "read_file"],
      false,
    ),
    evidence,
    receipts: [],
    conflicts: [acknowledged],
    finalOutput:
      "Hybrid findings.\n\nLimitations: Sources disagree on recovery rates.\n\nConfidence: medium.",
  });
  assert.equal(
    verifier.checks.find((check) => check.kind === "evidence_conflicts")?.status,
    "pass",
  );
});

function hybridResearchPlan(): ResearchPlan {
  return {
    version: 1,
    mode: "deep_hybrid",
    sourceRequirements: { minFetchedSources: 1, minDistinctDomains: 1 },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [
      {
        id: "rq-1",
        question: "Gather external source evidence.",
        requiredEvidenceType: "web_source",
        minEvidence: 1,
        status: "complete",
        evidenceIds: ["web:1"],
      },
      {
        id: "rq-2",
        question: "Retrieve local vault context.",
        requiredEvidenceType: "vault_note",
        minEvidence: 1,
        status: "complete",
        evidenceIds: ["vault:1"],
      },
      {
        id: "rq-3",
        question: "Resolve contradictions and state limitations/confidence.",
        requiredEvidenceType: "either",
        minEvidence: 1,
        status: "complete",
        evidenceIds: ["web:1"],
      },
    ],
    evidenceIds: ["web:1", "vault:1"],
    status: "complete",
  };
}

function hybridEvidence(): ResearchEvidence[] {
  return [
    {
      id: "web:1",
      kind: "web_source",
      title: "External",
      url: "https://alpha.example.com/a",
      summary: "External quantum battery evidence.",
      confidence: "high",
      passageIds: ["p1"],
    },
    {
      id: "vault:1",
      kind: "vault_note",
      title: "Alpha.md",
      path: "Notes/Alpha.md",
      summary: "Local vault note about quantum batteries.",
      confidence: "high",
    },
  ];
}

function researchPlan(): ResearchPlan {
  return {
    version: 1,
    mode: "deep_web",
    sourceRequirements: { minFetchedSources: 3, minDistinctDomains: 2 },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [
      subquestion("rq-1", "Find quantum battery evidence."),
      subquestion("rq-2", "Compare independent sources."),
      subquestion("rq-3", "Synthesize limitations and confidence."),
    ],
    evidenceIds: [],
    status: "in_progress",
  };
}

function subquestion(id: string, question: string) {
  return {
    id,
    question,
    requiredEvidenceType: "web_source" as const,
    minEvidence: 1,
    status: "pending" as const,
    evidenceIds: [],
  };
}

function webEvidence(
  id: string,
  url: string,
  binding: Partial<ResearchEvidence> = {},
): ResearchEvidence {
  return {
    id,
    kind: "web_source",
    title: "Quantum battery research",
    url,
    passageId: `${id}:passage:0-100`,
    passageIds: [`${id}:passage:0-100`],
    usableSource: true,
    summary: "Quantum battery evidence, comparison, and limitations.",
    confidence: "high",
    ...binding,
  };
}

function createPlan(
  prompt: string,
  allowedToolNames: string[],
  requireWriteCompletion: boolean,
): MissionPlan {
  return createMissionPlan({
    runId: "run:quality",
    prompt,
    missionIntent: intent(requireWriteCompletion),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_model_planning",
      allowedToolNames,
    },
    requiredTools: allowedToolNames,
    now: new Date("2026-07-10T12:00:00.000Z"),
  });
}

function intent(requireWriteCompletion: boolean): MissionIntent {
  return {
    mode: requireWriteCompletion ? "note_output" : "vault_context_answer",
    vaultContext: !requireWriteCompletion,
    noteOutput: requireWriteCompletion,
    explicitPersistence: requireWriteCompletion,
    explicitMutation: requireWriteCompletion,
    explicitDelete: false,
    allowAutonomousWrite: requireWriteCompletion,
    requireWriteCompletion,
    autonomyScope: deriveAutonomyScope("current note", {
      noteOutput: requireWriteCompletion,
      explicitPersistence: requireWriteCompletion,
      explicitMutation: requireWriteCompletion,
    }),
  };
}

function okResult(toolName: string, output: unknown): ToolExecutionResult {
  return { ok: true, toolName, output };
}
