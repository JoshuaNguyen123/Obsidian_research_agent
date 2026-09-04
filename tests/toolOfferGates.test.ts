import assert from "node:assert/strict";
import test from "node:test";

import {
  getNamedLinearDeepNouns,
  hasCitationVerifyResolveOfferIntent,
  hasCitationWorkIntent,
  hasCreateFileIntent,
  hasDatasetAnalysisIntent,
  hasDocumentExtractIntent,
  hasGitHubPrOrIssueRefIntent,
  hasSidecarCreateFileIntent,
  hasTemplateIntent,
} from "../src/agent/promptIntentClassifiers";
import {
  EXTRACT_DOCUMENT_TOOL_NAME,
  getOfferedGitHubCatalogReadToolNames,
  isAllowedForMission,
  isLinearToolOfferedForMission,
  measureCitationVerifyResolveOfferRate,
  shouldOfferCreateFile,
  shouldOfferMermaidBlock,
} from "../src/agent/toolOfferGates";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import type { MissionIntent } from "../src/tools/types";

const PARAPHRASE_SOURCE_PROMPTS = [
  "Write a 1000 word essay on photosynthesis. Cite your sources.",
  "Write a 1000 word essay on photosynthesis. Include sources.",
  "Write a 1000 word essay on photosynthesis. Back this up with sources.",
  "Write a 1000 word essay on photosynthesis using four sources.",
] as const;

const SCHOLARLY_CITE_PROMPTS = [
  "Cite at least 5 scholarly sources in this note.",
  "Write a research brief. Cite at least 8 scholarly and academic sources.",
] as const;

const METRIC_A_PROMPTS = [
  ...PARAPHRASE_SOURCE_PROMPTS,
  ...SCHOLARLY_CITE_PROMPTS,
] as const;

function researchIntent(overrides: Partial<MissionIntent> = {}): MissionIntent {
  return {
    mode: "note_output",
    vaultContext: false,
    noteOutput: true,
    explicitPersistence: false,
    explicitMutation: false,
    explicitDelete: false,
    allowAutonomousWrite: false,
    requireWriteCompletion: false,
    autonomyScope: {
      read: {
        currentNote: false,
        vault: false,
        folders: [],
        files: [],
        web: true,
      },
      write: {
        currentNote: true,
        folders: [],
        files: [],
        artifacts: true,
        researchMemory: false,
      },
      destructive: {
        replaceCurrentNote: false,
        deleteCurrentNote: false,
        deletePaths: false,
      },
    },
    ...overrides,
  };
}

test("metric A: cite-your-sources and scholarly-cite prompts offer verify or resolve", () => {
  for (const prompt of METRIC_A_PROMPTS) {
    assert.equal(
      hasCitationWorkIntent(prompt),
      false,
      `old bibliographic gate must stay closed: ${prompt}`,
    );
    assert.equal(
      hasCitationVerifyResolveOfferIntent(prompt),
      true,
      prompt,
    );
  }
  const measured = measureCitationVerifyResolveOfferRate(
    METRIC_A_PROMPTS,
    researchIntent(),
  );
  assert.equal(measured.total, METRIC_A_PROMPTS.length);
  assert.equal(measured.offered, METRIC_A_PROMPTS.length);
  assert.equal(measured.pct, 100);
  assert.equal(
    isAllowedForMission(
      "export_bibtex",
      PARAPHRASE_SOURCE_PROMPTS[0],
      researchIntent(),
    ),
    false,
  );
});

test("metric B: add a mermaid flowchart offers upsert_mermaid_block", () => {
  const prompt = "Add a mermaid flowchart to this note";
  assert.equal(shouldOfferMermaidBlock(prompt), true);
  assert.equal(
    isAllowedForMission("upsert_mermaid_block", prompt, researchIntent()),
    true,
  );
  assert.equal(
    isAllowedForMission("read_mermaid_block", prompt, researchIntent()),
    true,
  );
});

test("metric C: extract_document is registered and analyze_dataset is offered for Results.csv", () => {
  const names = createDefaultToolRegistry()
    .getDefinitions()
    .map((definition) => definition.function.name);
  assert.ok(
    names.includes(EXTRACT_DOCUMENT_TOOL_NAME),
    "extract_document must be in the default registry",
  );
  assert.equal(hasDatasetAnalysisIntent("summarize Results.csv"), true);
  assert.equal(hasDatasetAnalysisIntent("plot the *.csv export"), true);
  assert.equal(
    isAllowedForMission(
      "analyze_dataset",
      "summarize Results.csv",
      researchIntent(),
    ),
    true,
  );
  assert.equal(hasDocumentExtractIntent("Extract text from this PDF"), true);
  assert.equal(
    isAllowedForMission(
      EXTRACT_DOCUMENT_TOOL_NAME,
      "Extract text from this PDF",
      researchIntent(),
    ),
    true,
  );
});

test("create_file stays available for bib/csv sidecars even with template intent", () => {
  const prompt = "Create references.bib from the bibliography template";
  assert.equal(hasSidecarCreateFileIntent(prompt), true);
  assert.equal(hasCreateFileIntent(prompt), true);
  assert.equal(hasTemplateIntent(prompt), true);
  assert.equal(shouldOfferCreateFile(prompt), true);
  assert.equal(
    isAllowedForMission("create_file", prompt, researchIntent()),
    true,
  );
});

test("Linear offer stays on issues/projects/progress unless a deeper noun is named", () => {
  const issues = "Show my Linear issues";
  assert.equal(getNamedLinearDeepNouns(issues).length, 0);
  assert.equal(isLinearToolOfferedForMission("linear_list_issues", issues), true);
  assert.equal(
    isLinearToolOfferedForMission("linear_list_projects", issues),
    true,
  );
  assert.equal(
    isLinearToolOfferedForMission("linear_list_project_updates", issues),
    true,
  );
  assert.equal(
    isLinearToolOfferedForMission("linear_list_cycles", issues),
    false,
  );
  assert.equal(
    isLinearToolOfferedForMission("linear_create_comment", issues),
    false,
  );

  const cycles = "Show my Linear cycles";
  assert.ok(getNamedLinearDeepNouns(cycles).includes("cycle"));
  assert.equal(
    isLinearToolOfferedForMission("linear_list_cycles", cycles),
    true,
  );
});

test("GitHub catalog read tools are offered on PR / issue #N language", () => {
  assert.equal(hasGitHubPrOrIssueRefIntent("Review PR #42"), true);
  assert.deepEqual(getOfferedGitHubCatalogReadToolNames("Review PR #42"), [
    "github_get_pull_request",
  ]);
  assert.equal(hasGitHubPrOrIssueRefIntent("Check issue #18"), true);
  assert.deepEqual(getOfferedGitHubCatalogReadToolNames("Check issue #18"), [
    "github_get_issue",
  ]);
  assert.equal(
    isAllowedForMission(
      "github_get_pull_request",
      "Review PR #42",
      researchIntent(),
    ),
    true,
  );
});
