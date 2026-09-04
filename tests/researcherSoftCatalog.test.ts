import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCHER_SOFT_TOOL_NAMES,
  buildResearcherAssignment,
  filterResearcherToolNames,
} from "../src/orchestrator/researcherSoftCatalog";

test("filterResearcherToolNames keeps Soft researcher tools only", () => {
  const filtered = filterResearcherToolNames([
    "web_search",
    "web_fetch",
    "extract_document",
    "publish_research_to_linear",
    "append_to_current_file",
    "read_file",
  ]);
  assert.ok(filtered.includes("web_search"));
  assert.ok(filtered.includes("web_fetch"));
  assert.ok(filtered.includes("extract_document"));
  assert.ok(filtered.includes("read_file"));
  assert.ok(!filtered.includes("publish_research_to_linear"));
  assert.ok(RESEARCHER_SOFT_TOOL_NAMES.includes("extract_document"));
});

test("buildResearcherAssignment includes source floor and mission", () => {
  const assignment = buildResearcherAssignment({
    prompt: "Verify checkers rules with citations",
    explicitSourceCount: 2,
    deep: true,
  });
  assert.match(assignment, /read-only Researcher/i);
  assert.match(assignment, /at least 2 usable/i);
  assert.match(assignment, /checkers rules/i);
});
