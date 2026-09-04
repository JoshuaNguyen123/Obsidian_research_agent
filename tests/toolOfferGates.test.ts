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
import { OFFLINE_RESEARCH_CATALOG_PROBES } from "../e2e/fixtures/offlineExpandScenarios";

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
  for (const prompt of SCHOLARLY_CITE_PROMPTS) {
    assert.equal(
      isAllowedForMission("export_bibtex", prompt, researchIntent()),
      false,
      `export_bibtex must stay off bare cite-N-sources: ${prompt}`,
    );
  }
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

test("Add a flowchart offers mermaid; explicit canvas dest suppresses it", () => {
  const flowchart = "Add a flowchart to this note";
  assert.equal(shouldOfferMermaidBlock(flowchart), true);
  assert.equal(
    isAllowedForMission("upsert_mermaid_block", flowchart, researchIntent()),
    true,
  );
  const canvas = "Move this flowchart onto an Obsidian canvas";
  assert.equal(shouldOfferMermaidBlock(canvas), false);
  assert.equal(
    isAllowedForMission("upsert_mermaid_block", canvas, researchIntent()),
    false,
  );
});

test("create_design_* follows missionGrantsDesignCapability", () => {
  const research = "Write a note on transformer architecture.";
  assert.equal(
    isAllowedForMission("create_design_canvas", research, researchIntent()),
    false,
  );
  assert.equal(
    isAllowedForMission("create_svg_design", research, researchIntent()),
    false,
  );
  const design = "create a canvas diagram of the flow";
  assert.equal(
    isAllowedForMission("create_design_canvas", design, researchIntent()),
    true,
  );
});

test("Inspect the repo does not offer workspace create or artifact export", () => {
  const prompt = "Inspect the repo";
  assert.equal(
    isAllowedForMission("code_workspace_create", prompt, researchIntent()),
    false,
  );
  assert.equal(
    isAllowedForMission("export_workspace_artifact", prompt, researchIntent()),
    false,
  );
  assert.equal(
    isAllowedForMission("code_workspace_read", prompt, researchIntent()),
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
  assert.equal(
    isLinearToolOfferedForMission("linear_create_issue", issues),
    false,
  );
  assert.equal(
    isLinearToolOfferedForMission("linear_update_issue", issues),
    false,
  );
  assert.equal(
    isLinearToolOfferedForMission("linear_archive_issue", issues),
    false,
  );
  assert.equal(
    isLinearToolOfferedForMission("linear_trash_issue", issues),
    false,
  );
  assert.equal(
    isLinearToolOfferedForMission(
      "linear_create_issue",
      "Create a Linear issue for this bug",
    ),
    true,
  );
  assert.equal(
    isLinearToolOfferedForMission(
      "linear_create_issue",
      "Could you write me a 1000 word essay on china's government? Then turn the essay into linear issues?",
    ),
    true,
  );
  assert.equal(
    isLinearToolOfferedForMission(
      "linear_archive_issue",
      "Archive this Linear issue",
    ),
    true,
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

test("offline research catalog probes offer extract, citation verify, dataset json, and flowchart mermaid", () => {
  assert.equal(OFFLINE_RESEARCH_CATALOG_PROBES.length, 4);
  for (const probe of OFFLINE_RESEARCH_CATALOG_PROBES) {
    const prompt = probe.prompt.split("{marker}").join("OFFLINE_CATALOG_PROBE");
    assert.equal(
      isAllowedForMission(probe.expectedTool, prompt, researchIntent()),
      true,
      `${probe.id} must offer ${probe.expectedTool}`,
    );
  }
});
