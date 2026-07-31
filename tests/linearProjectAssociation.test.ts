import assert from "node:assert/strict";
import test from "node:test";
import {
  decideLinearProjectAssociationPolicy,
  deriveLinearProjectNameFromMission,
  hasPlainLinearIssueOnlyIntent,
  matchAssociatedLinearProject,
} from "../src/integrations/linear/linearProjectAssociation";
import { resolveLinearProjectAssociation } from "../src/integrations/linear/resolveLinearProjectAssociation";
import { listAllLinearPages } from "../src/integrations/linear/linearPagination";
import type { LinearToolClient } from "../src/integrations/linear/LinearTools";
import type { LinearBaseRecord, LinearPage } from "../src/integrations/linear/types";
import { buildByokPhaseAResearchPrompt } from "../e2e/fixtures/byokAutonomousJourneyPrompt";

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
  assert.equal(
    hasPlainLinearIssueOnlyIntent(
      "Create a Linear project for this mission, file one standalone Linear issue there, and do not create an initiative.",
    ),
    false,
  );
  assert.equal(
    hasPlainLinearIssueOnlyIntent(
      "Do not create a new project; use the configured project and create one Linear issue there.",
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

function project(id: string, name: string, teamId = "team-1"): LinearBaseRecord {
  return {
    resourceType: "project",
    id,
    name,
    attributes: { teams: [teamId] },
    snapshotHash: "hash",
  } as LinearBaseRecord;
}

function page(
  items: LinearBaseRecord[],
  hasNextPage: boolean,
  endCursor?: string,
): LinearPage<LinearBaseRecord> {
  return {
    items,
    pageInfo: { hasNextPage, ...(endCursor ? { endCursor } : {}) },
    fetchedAt: new Date().toISOString(),
  };
}

test("an existing project on page two is found instead of creating a duplicate", async () => {
  // Regression: only the first 50-row page was ever read, and team filtering
  // is client-side, so a workspace past 50 projects missed its existing
  // project, created a duplicate, and the host then persisted the duplicate
  // id as the sticky queue default.
  const listCalls: Array<Record<string, unknown>> = [];
  let created = 0;
  const client: LinearToolClient = {
    execute: async (key, variables = {}) => {
      if (key === "projects.list") {
        listCalls.push(variables);
        return variables.after === "cursor-1"
          ? page([project("proj-existing", "Checkers research")], false)
          : page(
              // Page one: fifty unrelated projects from other teams.
              Array.from({ length: 50 }, (_, i) =>
                project(`other-${i}`, `Other ${i}`, "team-other"),
              ),
              true,
              "cursor-1",
            );
      }
      if (key === "projects.create") {
        created += 1;
        return project("proj-duplicate", "Checkers research");
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

  assert.equal(created, 0, "must not create a duplicate");
  assert.equal(result.created, false);
  assert.equal(result.projectId, "proj-existing");
  assert.equal(listCalls.length, 2);
  assert.equal(listCalls[1]?.after, "cursor-1");
});

test("the page sweep is capped and a mutation-ack readback resolves across pages", async () => {
  // The create path re-lists to find the new project when the adapter returns
  // only a mutation ack; that readback must also paginate, or a create could
  // throw after succeeding and orphan the project.
  let phase: "before" | "after" = "before";
  let listCallsThisPhase = 0;
  const client: LinearToolClient = {
    execute: async (key, variables = {}) => {
      if (key === "projects.list") {
        listCallsThisPhase += 1;
        const cursor = typeof variables.after === "string" ? variables.after : "";
        if (phase === "before") {
          // Endless filler: every page claims another page. The sweep must
          // stop at its cap rather than crawling forever.
          const index = cursor ? Number.parseInt(cursor.slice(7), 10) : 0;
          return page(
            [project(`filler-${index}`, `Filler ${index}`, "team-other")],
            true,
            `cursor-${index + 1}`,
          );
        }
        // Readback after create: the new project appears on page two.
        return cursor === "rb-1"
          ? page([project("proj-new", "Checkers research")], false)
          : page([project("rb-filler", "Filler", "team-other")], true, "rb-1");
      }
      if (key === "projects.create") {
        phase = "after";
        listCallsThisPhase = 0;
        // Mutation ack with no id: forces the readback path.
        return { resourceType: "project", id: "", snapshotHash: "hash" } as LinearBaseRecord;
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
  assert.equal(listCallsThisPhase, 2, "readback found the project on page two");
});

test("listAllLinearPages dedupes shifted rows and stops on a repeated cursor", async () => {
  let calls = 0;
  const client: LinearToolClient = {
    execute: async (_key, variables = {}) => {
      calls += 1;
      // The server repeats a row across pages (rows shift during pagination)
      // and then repeats the cursor itself, which would loop forever.
      return variables.after
        ? page([project("p1", "One"), project("p2", "Two")], true, "same-cursor")
        : page([project("p1", "One")], true, "same-cursor");
    },
  };
  const sweep = await listAllLinearPages(client, "projects.list", { first: 50 });
  assert.deepEqual(
    sweep.items.map((item) => item.id),
    ["p1", "p2"],
  );
  assert.equal(sweep.truncated, true);
  assert.equal(calls, 2);
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

test("the BYOK research publication wording cannot list or create a Linear project", async () => {
  const prompt = buildByokPhaseAResearchPrompt({
    marker: "BYOK_AUTONOMOUS_projectless",
    profileKey: "byok-disposable-repo",
    validationProfileKey: "byok-python-unittest",
  });
  assert.equal(hasPlainLinearIssueOnlyIntent(prompt), true);
  let providerCalls = 0;
  const client: LinearToolClient = {
    execute: async (key) => {
      providerCalls += 1;
      throw new Error(`Unexpected ${key}`);
    },
  };

  const result = await resolveLinearProjectAssociation({
    client,
    prompt,
    associationText: "Autonomous BYOK CRDT research",
    teamId: "team-1",
    configuredProjectId: "stale-project",
  });

  assert.equal(providerCalls, 0);
  assert.equal(result.projectId, null);
  assert.equal(result.decision.mode, "team_only");
  assert.equal(result.created, false);
});
