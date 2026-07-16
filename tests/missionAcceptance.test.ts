import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMissionAcceptance,
  formatMissionAcceptanceCorrection,
  type MissionAcceptanceReceiptLike,
} from "../src/agent/missionAcceptance";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import type { MissionIntent } from "../src/tools/types";
import type { ResearchPlan } from "../src/agent/researchPlan";

const baseIntent: MissionIntent = {
  mode: "chat_only",
  vaultContext: false,
  noteOutput: false,
  explicitPersistence: false,
  explicitMutation: false,
  explicitDelete: false,
  allowAutonomousWrite: false,
  requireWriteCompletion: false,
  autonomyScope: {
    read: { currentNote: false, vault: false, folders: [], files: [], web: false },
    write: { currentNote: false, folders: [], files: [], artifacts: false, researchMemory: false },
    destructive: { replaceCurrentNote: false, deleteCurrentNote: false, deletePaths: false },
  },
};

test("mission acceptance fails when a required write has no receipt", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Write a summary to the current note.",
    missionIntent: { ...baseIntent, requireWriteCompletion: true },
    requiredTools: ["append_to_current_file"],
    successfulTools: [],
    failedTools: [],
    evidence: [],
    receipts: [],
    operationGoals: { current_note_content: "pending" },
    finalOutput: "Done.",
  });

  assert.equal(result.status, "fail");
  assert.equal(result.nextAction, "Complete the required write or mutation with a receipt.");
  assert.ok(result.missing.includes("tool:append_to_current_file"));
  assert.ok(result.missing.includes("write_receipt"));
});

test("mission acceptance asks for more work when source evidence is missing", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Verify this with web sources and citations.",
    missionIntent: baseIntent,
    requiredTools: [],
    successfulTools: [],
    failedTools: [],
    evidence: [],
    receipts: [],
    operationGoals: {},
    finalOutput: "A citation-free answer.",
  });

  assert.equal(result.status, "needs_more_work");
  assert.equal(result.nextAction, "Gather web source evidence.");
  assert.ok(result.missing.includes("web_evidence"));
});

test("named vault Markdown sources do not require unrelated web evidence", () => {
  const result = evaluateMissionAcceptance({
    prompt:
      "Read the named vault notes Sources/Alpha.md and Sources/Beta.md, synthesize two findings, and append them to the current note.",
    missionIntent: {
      ...baseIntent,
      vaultContext: true,
      noteOutput: true,
      explicitPersistence: true,
      explicitMutation: true,
      requireWriteCompletion: true,
    },
    requiredTools: ["read_file", "append_to_current_file"],
    successfulTools: ["read_file", "append_to_current_file"],
    failedTools: [],
    evidence: [
      {
        id: "vault:alpha",
        kind: "vault_note",
        title: "Sources/Alpha.md",
        path: "Sources/Alpha.md",
        summary: "Owned vault evidence.",
        confidence: "high",
      },
    ],
    receipts: [
      {
        toolName: "append_to_current_file",
        operation: "append",
        path: "Current.md",
        bytesWritten: 42,
      },
    ],
    operationGoals: { current_note_content: "completed" },
    finalOutput: "Appended the two findings.",
  });

  assert.equal(result.missing.includes("web_evidence"), false);
  assert.equal(result.status, "pass");
});

test("mission acceptance passes when evidence and receipts satisfy the mission", () => {
  const receipt: MissionAcceptanceReceiptLike = {
    toolName: "append_to_current_file",
    path: "Current.md",
    operation: "append",
    bytesWritten: 42,
  };
  const result = evaluateMissionAcceptance({
    prompt: "Search my vault, cite sources, and write the answer to the note.",
    missionIntent: { ...baseIntent, requireWriteCompletion: true },
    requiredTools: ["inspect_vault_context", "web_fetch", "append_to_current_file"],
    successfulTools: ["inspect_vault_context", "web_fetch", "append_to_current_file"],
    failedTools: [],
    evidence: [
      {
        id: "vault:1",
        kind: "vault_note",
        title: "Vault search",
        summary: "Read two notes.",
        confidence: "high",
      },
      {
        id: "web:1",
        kind: "web_source",
        title: "Fetched source",
        summary: "Fetched source page.",
        confidence: "high",
      },
    ],
    receipts: [receipt],
    operationGoals: { current_note_content: "completed" },
    finalOutput: "Wrote the sourced answer.",
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.missing, []);
  assert.equal(result.confidence, 0.92);
});

test("mission acceptance accepts a scoped persistent artifact receipt without treating it as vault proof", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Draw a three-block architecture diagram.",
    missionIntent: {
      ...baseIntent,
      explicitMutation: true,
      requireWriteCompletion: true,
      autonomyScope: {
        ...baseIntent.autonomyScope,
        write: {
          ...baseIntent.autonomyScope.write,
          artifacts: true,
        },
      },
    },
    requiredTools: ["create_design_canvas"],
    successfulTools: ["create_design_canvas"],
    failedTools: [],
    evidence: [],
    receipts: [
      {
        toolName: "create_design_canvas",
        operation: "create",
        path: "Designs/architecture.canvas",
        bytesWritten: 1_024,
        resource: { system: "workspace", resourceType: "markdown" },
      },
    ],
    operationGoals: {},
    finalOutput: "Created the requested diagram.",
  });

  assert.equal(result.status, "pass");
  assert.ok(!result.missing.includes("write_receipt"));
});

test("mission acceptance does not let an external receipt satisfy artifact or vault proof", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Draw a three-block architecture diagram.",
    missionIntent: {
      ...baseIntent,
      explicitMutation: true,
      requireWriteCompletion: true,
      autonomyScope: {
        ...baseIntent.autonomyScope,
        write: {
          ...baseIntent.autonomyScope.write,
          artifacts: true,
        },
      },
    },
    requiredTools: ["create_design_canvas"],
    successfulTools: ["create_design_canvas"],
    failedTools: [],
    evidence: [],
    receipts: [
      {
        toolName: "linear_create_issue",
        operation: "create",
        path: "Designs/architecture.canvas",
        resource: { system: "linear", resourceType: "issue", id: "LIN-1" },
      },
    ],
    operationGoals: {},
    finalOutput: "Created the requested diagram.",
  });

  assert.equal(result.status, "fail");
  assert.ok(result.missing.includes("write_receipt"));
});

test("mission acceptance accepts a matching external mutation receipt only for that external action", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Create the approved Linear issue.",
    missionIntent: {
      ...baseIntent,
      explicitMutation: true,
      requireWriteCompletion: true,
    },
    requiredTools: ["linear_create_issue"],
    successfulTools: ["linear_create_issue"],
    failedTools: [],
    evidence: [],
    receipts: [
      {
        toolName: "linear_create_issue",
        operation: "create",
        resource: { system: "linear", resourceType: "issue", id: "LIN-2" },
      },
    ],
    operationGoals: {},
    finalOutput: "Created Linear issue LIN-2.",
  });

  assert.equal(result.status, "pass");
  assert.ok(!result.missing.includes("write_receipt"));
});

test("mission acceptance treats broad unscoped mutations as blocked scope requests", () => {
  const prompt = "Update my whole vault with this project summary.";
  const result = evaluateMissionAcceptance({
    prompt,
    missionIntent: {
      ...baseIntent,
      mode: "explicit_file_mutation",
      vaultContext: true,
      explicitMutation: true,
      allowAutonomousWrite: false,
      requireWriteCompletion: false,
      autonomyScope: deriveAutonomyScope(prompt, {
        noteOutput: true,
        explicitMutation: true,
        explicitPersistence: true,
      }),
    },
    requiredTools: [],
    successfulTools: [],
    failedTools: [],
    evidence: [],
    receipts: [],
    operationGoals: {},
    finalOutput: "Explicit file or folder scope is required.",
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.reasons, [
    "broad_unscoped_mutation_requires_explicit_scope",
  ]);
});

test("visible title missions require a rename receipt", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Rename the current note to Purple Horizon.",
    missionIntent: { ...baseIntent, requireWriteCompletion: true },
    requiredTools: ["rename_current_file"],
    successfulTools: [],
    failedTools: [],
    evidence: [],
    receipts: [
      {
        toolName: "append_to_current_file",
        path: "Untitled.md",
        operation: "append",
        bytesWritten: 100,
      },
    ],
    operationGoals: { current_note_title: "pending" },
    finalOutput: "Done.",
  });

  assert.equal(result.status, "needs_more_work");
  assert.ok(result.missing.includes("visible_title_rename"));
  assert.equal(result.nextAction, "Rename the visible current note title and produce a receipt.");
});

test("highlight missions require a highlight receipt with matches", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Find and highlight silver lantern in the current note.",
    missionIntent: { ...baseIntent, requireWriteCompletion: true },
    requiredTools: ["highlight_current_file_phrase"],
    successfulTools: ["highlight_current_file_phrase"],
    failedTools: [],
    evidence: [],
    receipts: [
      {
        toolName: "highlight_current_file_phrase",
        path: "Current.md",
        operation: "highlight",
        affectedCount: 0,
      },
    ],
    operationGoals: { current_note_highlight: "done" },
    finalOutput: "Highlighted.",
  });

  assert.equal(result.status, "needs_more_work");
  assert.ok(result.missing.includes("highlight_receipt"));
  assert.equal(result.nextAction, "Highlight the requested phrase in the current note and produce a receipt.");
});

test("mission acceptance correction names missing tools that are still available", () => {
  const correction = formatMissionAcceptanceCorrection(
    {
      status: "needs_more_work",
      confidence: 0.55,
      missing: ["web_evidence", "web_fetch"],
      reasons: ["missing_web_evidence"],
      nextAction: "web_evidence",
    },
    ["web_search", "web_fetch"],
  );

  assert.match(correction, /Mission acceptance is incomplete/);
  assert.match(correction, /web_fetch/);
});

test("deep research acceptance requires fetched sources and final quality sections", () => {
  const researchPlan: ResearchPlan = {
    version: 1,
    mode: "deep_web",
    sourceRequirements: { minFetchedSources: 3, minDistinctDomains: 2 },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [
      {
        id: "rq-1",
        question: "Gather sources.",
        requiredEvidenceType: "web_source",
        minEvidence: 3,
        status: "in_progress",
        evidenceIds: ["web:1"],
      },
    ],
    evidenceIds: ["web:1"],
    status: "in_progress",
  };

  const result = evaluateMissionAcceptance({
    prompt: "Do deep research with sources.",
    missionIntent: baseIntent,
    requiredTools: [],
    successfulTools: ["web_fetch"],
    failedTools: [],
    evidence: [
      {
        id: "web:1",
        kind: "web_source",
        title: "One",
        url: "https://alpha.example.com/source",
        passageId: "source:alpha:passage:0-100",
        passageIds: ["source:alpha:passage:0-100"],
        usableSource: true,
        summary: "one",
        confidence: "high",
      },
    ],
    receipts: [],
    operationGoals: {},
    researchPlan,
    finalOutput: "One source only.",
  });

  assert.equal(result.status, "needs_more_work");
  assert.ok(result.missing.includes("fetched_sources:1/3"));
  assert.ok(result.missing.includes("research_plan_items"));
  assert.ok(result.missing.includes("citation_url_coverage"));
  assert.ok(result.missing.includes("limitations_section"));
  assert.ok(result.missing.includes("confidence_section"));
});

test("deep research acceptance passes with source coverage, limitations, and confidence", () => {
  const urls = [
    "https://alpha.example.com/source",
    "https://beta.example.org/source",
    "https://gamma.example.net/source",
  ];
  const researchPlan: ResearchPlan = {
    version: 1,
    mode: "deep_web",
    sourceRequirements: { minFetchedSources: 3, minDistinctDomains: 2 },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [
      {
        id: "rq-1",
        question: "Gather sources.",
        requiredEvidenceType: "web_source",
        minEvidence: 3,
        status: "complete",
        evidenceIds: ["web:1", "web:2", "web:3"],
      },
    ],
    evidenceIds: ["web:1", "web:2", "web:3"],
    status: "complete",
  };

  const result = evaluateMissionAcceptance({
    prompt: "Do deep research with sources.",
    missionIntent: baseIntent,
    requiredTools: [],
    successfulTools: ["web_fetch"],
    failedTools: [],
    evidence: urls.map((url, index) => ({
      id: `web:${index + 1}`,
      kind: "web_source" as const,
      title: `Source ${index + 1}`,
      url,
      passageId: `source:${index + 1}:passage:0-100`,
      passageIds: [`source:${index + 1}:passage:0-100`],
      usableSource: true,
      summary: "source",
      confidence: "high" as const,
    })),
    receipts: [],
    operationGoals: {},
    researchPlan,
    finalOutput: `Sources: ${urls.join(" ")} ${urls
      .map((_url, index) => `source:${index + 1}:passage:0-100`)
      .join(" ")}\n\nLimitations: e2e.\n\nConfidence: high.`,
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.missing, []);
});
