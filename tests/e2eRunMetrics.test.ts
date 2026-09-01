import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExclusiveRunMetricRow,
  selectedProjectExecuted,
} from "../scripts/record-e2e-run-metrics.mjs";
import { RUN_CSV_HEADER } from "../scripts/run-proof-matrix.mjs";

test("direct real-AI metrics preserve typed acceptance and complete tool counts", () => {
  const row = buildExclusiveRunMetricRow({
    startedAt: Date.parse("2026-09-01T17:00:00.000Z"),
    endedAt: Date.parse("2026-09-01T17:01:14.000Z"),
    projects: ["desktop-code-delivery-real-live"],
    model: "glm-5.3-flash:cloud",
    head: "a".repeat(40),
    dirty: true,
    exitCode: 0,
    summaryFresh: true,
    summary: {
      records: [{
        toolCallsAttempted: 7,
        toolCallsFailed: 0,
        toolCallsVacuous: 0,
        toolCallsIntentionalNoOp: 0,
        toolCallsUndetermined: 0,
        refusalBuckets: Object.fromEntries([
          "tool_not_allowed",
          "frontier_narrowed_mid_response",
          "frontier_withheld_since_earlier_step",
          "mission_graph_authority_blocked",
          "invalid_arguments",
          "execution_failed",
          "authority_grant_invalid",
          "tool_failure_terminal",
        ].map((key) => [key, 0])),
      }],
      summaries: [{
        scenarioId: "CODE-DELIVERY-01",
        acceptanceStatus: "pass",
        retries: 0,
        artifactProofCount: 3,
        cleanupProofCount: 2,
        missionScorecard: { total: 1, acceptancePassed: true },
      }],
    },
  });
  const columns = RUN_CSV_HEADER.split(",");
  const cell = (name: string) => row[columns.indexOf(name)];
  assert.equal(row.length, columns.length);
  assert.equal(cell("mission_outcome"), "accepted");
  assert.equal(cell("primary_failure_class"), "none");
  assert.equal(cell("tool_events_observed"), 7);
  assert.equal(cell("tool_events_failed"), 0);
  assert.equal(cell("pct_tool_calls_failed"), "0.0%");
  assert.equal(cell("tool_events_source"), "summary");
  assert.equal(cell("tool_calls_succeeded"), 7);
  assert.equal(cell("acceptance_status"), "pass");
  assert.equal(cell("scorecard_total"), 1);
  assert.equal(cell("artifact_proof_count"), 3);
  assert.match(String(cell("notes")), /working tree dirty/u);
});

test("direct metrics require a non-skipped selected project execution", () => {
  const report = {
    suites: [{
      specs: [{
        tests: [{
          projectName: "desktop-code-delivery-real-live",
          results: [{ status: "passed" }],
        }, {
          projectName: "real-ai-soak",
          results: [{ status: "skipped" }],
        }],
      }],
    }],
  };
  assert.equal(
    selectedProjectExecuted(report, ["desktop-code-delivery-real-live"]),
    true,
  );
  assert.equal(selectedProjectExecuted(report, ["real-ai-soak"]), false);
});

test("direct failed-run metrics classify the Playwright error contract", () => {
  const row = buildExclusiveRunMetricRow({
    startedAt: Date.parse("2026-09-01T17:10:00.000Z"),
    endedAt: Date.parse("2026-09-01T17:11:14.000Z"),
    projects: ["interrupted-continuation-live"],
    model: "glm-5.3-flash:cloud",
    head: "b".repeat(40),
    dirty: true,
    exitCode: 1,
    summaryFresh: true,
    summary: {
      records: [{ failureCategory: "product_assertion" }],
      summaries: [{
        scenarioId: "INTERRUPT-01",
        acceptanceStatus: "needs_more_work",
      }],
    },
    logText:
      "Error: process:prior_plugin_run_did_not_settle — " +
      "the disabled coordinator remained active after its bounded shutdown window.",
  });
  const columns = RUN_CSV_HEADER.split(",");
  const cell = (name: string) => row[columns.indexOf(name)];
  assert.equal(
    cell("primary_failure_class"),
    "process:prior_plugin_run_did_not_settle",
  );
  assert.equal(cell("classification_confidence"), "mechanical");
});
