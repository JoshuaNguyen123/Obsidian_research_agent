import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDeveloperMissionGraphV1,
  applyDeveloperMissionReceiptV1,
  applyDeveloperMissionToolStartV1,
  createDeveloperMissionProgressV1,
  developerMissionCompletionFromProjectRunReportV1,
  normalizeDeveloperMissionCompletionV1,
} from "../src/ui/developerMissionProgress";
import type { ProjectRunReportV1 } from "../src/agent/projectRunReport";

test("full developer lifecycle renders six stable phases", () => {
  const progress = createDeveloperMissionProgressV1([
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "code_validation",
    "private_github_publication",
    "reflection",
    "reconciliation_cleanup",
  ]);

  assert.deepEqual(
    progress?.phases.map(({ id, label, status }) => ({ id, label, status })),
    [
      { id: "research", label: "Research", status: "pending" },
      { id: "linear_plan", label: "Linear plan", status: "pending" },
      { id: "implement", label: "Implement", status: "pending" },
      { id: "test", label: "Test", status: "pending" },
      { id: "github", label: "GitHub", status: "pending" },
      { id: "reflect", label: "Reflect", status: "pending" },
    ],
  );
});

test("legacy or explicitly narrowed lifecycle does not invent absent phases", () => {
  const progress = createDeveloperMissionProgressV1([
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "private_github_publication",
    "reconciliation_cleanup",
  ]);
  assert.deepEqual(
    progress?.phases.map((phase) => phase.id),
    ["research", "linear_plan", "implement", "github"],
  );
});

test("graph nodes and verified receipts advance phases without tool start paying proof", () => {
  let progress = createDeveloperMissionProgressV1([
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "code_validation",
    "github_publication",
    "reflection",
  ]);
  progress = applyDeveloperMissionGraphV1(progress, [
    { id: "lifecycle-accepted_research", status: "complete" },
    { id: "lifecycle-linear_hierarchy", status: "running" },
  ]);
  assert.equal(progress?.phases[0]?.status, "complete");
  assert.equal(progress?.phases[1]?.status, "active");

  progress = applyDeveloperMissionToolStartV1(progress, "code_workspace_edit");
  assert.equal(progress?.phases[2]?.status, "active");
  assert.notEqual(progress?.phases[2]?.status, "complete");

  progress = applyDeveloperMissionReceiptV1(
    progress,
    "code_workspace_validate_full",
    "validation receipt verified",
  );
  assert.notEqual(progress?.phases[3]?.status, "complete");
  progress = applyDeveloperMissionReceiptV1(
    progress,
    "code_commit_verified",
    "validation and exact commit readback verified",
  );
  assert.equal(progress?.phases[3]?.status, "complete");
});

test("completion view rejects unsafe URLs and vault paths while retaining details artifacts", () => {
  const completion = normalizeDeveloperMissionCompletionV1({
    version: 1,
    kind: "developer_mission_completion",
    status: "complete",
    summary: "  Delivery verified.  ",
    artifacts: [
      { kind: "results", label: "Results", vaultPath: "Agent Work/Results/run.md" },
      { kind: "linear", label: "Linear ENG-42", url: "https://linear.app/acme/issue/ENG-42" },
      { kind: "validation", label: "Validation", url: "javascript:alert(1)" },
      { kind: "commit", label: "Commit", vaultPath: "../unsafe.md" },
      { kind: "results", label: "Absolute result", vaultPath: "/unsafe.md" },
    ],
  });

  assert.equal(completion.summary, "Delivery verified.");
  assert.deepEqual(completion.artifacts[0], {
    kind: "results",
    label: "Results",
    vaultPath: "Agent Work/Results/run.md",
  });
  assert.deepEqual(completion.artifacts[1], {
    kind: "linear",
    label: "Linear ENG-42",
    url: "https://linear.app/acme/issue/ENG-42",
  });
  assert.deepEqual(completion.artifacts[2], {
    kind: "validation",
    label: "Validation",
  });
  assert.deepEqual(completion.artifacts[3], {
    kind: "commit",
    label: "Commit",
  });
  assert.deepEqual(completion.artifacts[4], {
    kind: "results",
    label: "Absolute result",
  });
});

test("durable project report adapts into the same six-phase completion truth", () => {
  const phaseIds = [
    "research",
    "linear_plan",
    "implement",
    "test",
    "github",
    "reflect",
  ] as const;
  const report = {
    destination: {
      kind: "markdown",
      path: "Agent Work/Results/project/run.md",
      source: "default",
    },
    phases: phaseIds.map((phase) => ({
      phase,
      label: phase,
      status: "verified",
      startedAt: "2026-08-19T12:00:00.000Z",
      completedAt: "2026-08-19T12:01:00.000Z",
      evidenceEventIds: [],
      blockerEventIds: [],
    })),
    evidence: [
      {
        evidenceKind: "linear_hierarchy_readback",
        resource: { id: "ENG-42", url: "https://linear.app/example/ENG-42" },
      },
      {
        evidenceKind: "full_validation",
        resource: { id: "validation-1", url: null },
      },
      {
        evidenceKind: "commit_readback",
        resource: {
          id: "commit-1",
          revision: "0123456789012345678901234567890123456789",
          url: "https://github.com/example/repo/commit/0123456789012345678901234567890123456789",
        },
      },
      {
        evidenceKind: "github_draft_pr_readback",
        resource: { id: "7", url: "https://github.com/example/repo/pull/7" },
      },
    ],
    complete: true,
  } as unknown as ProjectRunReportV1;

  const completion = developerMissionCompletionFromProjectRunReportV1(report);
  assert.equal(completion.status, "complete");
  assert.equal(completion.progress?.phases.length, 6);
  assert.ok(completion.progress?.phases.every((phase) => phase.status === "complete"));
  assert.deepEqual(
    completion.artifacts.map((artifact) => artifact.kind),
    ["results", "linear", "validation", "commit", "pull_request"],
  );
});
