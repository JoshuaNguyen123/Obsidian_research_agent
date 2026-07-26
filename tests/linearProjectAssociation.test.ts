import assert from "node:assert/strict";
import test from "node:test";
import {
  decideLinearProjectAssociationPolicy,
  deriveLinearProjectNameFromMission,
  hasPlainLinearIssueOnlyIntent,
  matchAssociatedLinearProject,
} from "../src/integrations/linear/linearProjectAssociation";
import { resolveLinearProjectAssociation } from "../src/integrations/linear/resolveLinearProjectAssociation";
import type { LinearToolClient } from "../src/integrations/linear/LinearTools";
import type { LinearBaseRecord, LinearPage } from "../src/integrations/linear/types";

test("plain issue intent skips project association", () => {
  assert.equal(
    hasPlainLinearIssueOnlyIntent(
      "Just create a general issue in Linear about the typo.",
    ),
    true,
  );
  assert.equal(
    hasPlainLinearIssueOnlyIntent(
      "Create a Linear issue without a project for this bug.",
    ),
    true,
  );
  assert.equal(
    hasPlainLinearIssueOnlyIntent(
      "File a standalone Linear ticket for the typo.",
    ),
    true,
  );
});

test("ordinary issue creation still associates to a project by default", () => {
  assert.equal(
    hasPlainLinearIssueOnlyIntent("Create a Linear issue for the flaky login."),
    false,
  );
});

test("mission-shaped Linear work is not plain issue intent", () => {
  assert.equal(
    hasPlainLinearIssueOnlyIntent(
      "Publish accepted research to Linear and create the project hierarchy.",
    ),
    false,
  );
  assert.equal(
    hasPlainLinearIssueOnlyIntent(
      "Build checkers end to end with Linear tasks and GitHub.",
    ),
    false,
  );
  assert.equal(
    hasPlainLinearIssueOnlyIntent(
      "Create a Linear project for this mission and file the issues there.",
    ),
    false,
  );
});

test("policy uses configured project when present on the team", () => {
  const decision = decideLinearProjectAssociationPolicy({
    prompt: "Publish research findings to Linear.",
    associationText: "Checkers research",
    configuredProjectId: "proj-configured",
    candidates: [
      { id: "proj-configured", name: "Queue", teamIds: ["team-1"] },
      { id: "proj-other", name: "Checkers research", teamIds: ["team-1"] },
    ],
    teamId: "team-1",
  });
  assert.deepEqual(decision, {
    mode: "use_existing",
    projectId: "proj-configured",
    reason: "configured",
    projectName: "Queue",
  });
});

test("policy prefers lineage project over name match", () => {
  const decision = decideLinearProjectAssociationPolicy({
    prompt: "Continue the mission in Linear.",
    associationText: "Checkers",
    lineageProjectIds: ["proj-lineage"],
    candidates: [
      { id: "proj-lineage", name: "Unrelated label", teamIds: ["team-1"] },
      { id: "proj-name", name: "Checkers", teamIds: ["team-1"] },
    ],
    teamId: "team-1",
  });
  assert.equal(decision.mode, "use_existing");
  if (decision.mode !== "use_existing") return;
  assert.equal(decision.projectId, "proj-lineage");
  assert.equal(decision.reason, "lineage");
});

test("policy matches an associated project by title", () => {
  const match = matchAssociatedLinearProject(
    [
      { id: "a", name: "Vault cleanup" },
      { id: "b", name: "Python Checkers Game" },
    ],
    "python checkers game implementation",
  );
  assert.equal(match?.id, "b");

  const decision = decideLinearProjectAssociationPolicy({
    prompt: "Create Linear issues for the python checkers game.",
    associationText: "Python Checkers Game",
    candidates: [
      { id: "a", name: "Vault cleanup", teamIds: ["team-1"] },
      { id: "b", name: "Python Checkers Game", teamIds: ["team-1"] },
    ],
    teamId: "team-1",
  });
  assert.deepEqual(decision, {
    mode: "use_existing",
    projectId: "b",
    reason: "associated_match",
    projectName: "Python Checkers Game",
  });
});

test("policy creates a project when none are associated", () => {
  const decision = decideLinearProjectAssociationPolicy({
    prompt: "Publish accepted research to Linear.",
    associationText: "End-to-end checkers workflow",
    candidates: [{ id: "a", name: "Unrelated", teamIds: ["team-1"] }],
    teamId: "team-1",
  });
  assert.equal(decision.mode, "create_project");
  if (decision.mode !== "create_project") return;
  assert.match(decision.projectName, /checkers/i);
});

test("plain issue policy stays team-only even when candidates exist", () => {
  const decision = decideLinearProjectAssociationPolicy({
    prompt: "Create a general Linear issue about the typo in the README.",
    associationText: "README typo",
    configuredProjectId: "proj-configured",
    candidates: [
      { id: "proj-configured", name: "Queue", teamIds: ["team-1"] },
    ],
    teamId: "team-1",
  });
  assert.deepEqual(decision, {
    mode: "team_only",
    reason: "plain_issue_intent",
  });
});

test("deriveLinearProjectNameFromMission strips issue verbs", () => {
  assert.equal(
    deriveLinearProjectNameFromMission(
      "Create a Linear issue for checkers rules research",
    ),
    "checkers rules research",
  );
});

test("resolveLinearProjectAssociation creates when empty", async () => {
  const created: Array<Record<string, unknown>> = [];
  const client: LinearToolClient = {
    execute: async (key, variables = {}) => {
      if (key === "projects.list") {
        return {
          items: [],
          pageInfo: { hasNextPage: false },
          fetchedAt: new Date().toISOString(),
        } satisfies LinearPage<LinearBaseRecord>;
      }
      if (key === "projects.create") {
        created.push(variables.input as Record<string, unknown>);
        return {
          resourceType: "project",
          id: "proj-new",
          name: String((variables.input as { name?: string }).name ?? ""),
          snapshotHash: "hash",
        } satisfies LinearBaseRecord;
      }
      throw new Error(`Unexpected ${key}`);
    },
  };

  const result = await resolveLinearProjectAssociation({
    client,
    prompt: "Publish research findings to Linear for checkers.",
    associationText: "Checkers research",
    teamId: "team-1",
  });

  assert.equal(result.created, true);
  assert.equal(result.projectId, "proj-new");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0]?.teamIds, ["team-1"]);
});

test("resolveLinearProjectAssociation stays team-only for plain issues", async () => {
  let listed = false;
  const client: LinearToolClient = {
    execute: async (key) => {
      if (key === "projects.list") {
        listed = true;
        return {
          items: [
            {
              resourceType: "project",
              id: "proj-1",
              name: "Queue",
              attributes: { teams: ["team-1"] },
              snapshotHash: "hash",
            },
          ],
          pageInfo: { hasNextPage: false },
          fetchedAt: new Date().toISOString(),
        } satisfies LinearPage<LinearBaseRecord>;
      }
      throw new Error(`Unexpected ${key}`);
    },
  };

  const result = await resolveLinearProjectAssociation({
    client,
    prompt: "Create a general Linear issue about the README typo.",
    associationText: "README typo",
    teamId: "team-1",
    configuredProjectId: "proj-1",
  });

  assert.equal(listed, false);
  assert.equal(result.projectId, null);
  assert.equal(result.decision.mode, "team_only");
  assert.equal(result.created, false);
});
