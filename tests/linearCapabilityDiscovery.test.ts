import test from "node:test";
import assert from "node:assert/strict";
import {
  LinearClientError,
  discoverLinearCapabilities,
  getLinearCapabilitySnapshotFreshness,
  parseLinearCapabilitySnapshot,
  sha256LinearValue,
  type LinearBaseRecord,
  type LinearCapabilityDiscoveryClient,
  type LinearCapabilitySnapshotV1,
  type LinearOperationResult,
} from "../src/integrations/linear";

const FETCHED_AT = "2026-07-12T15:00:00.000Z";
const DISCOVERED_AT = "2026-07-12T16:00:00.000Z";

test("connection discovery returns bounded choices and a secret-free capability report", async () => {
  const calls: Array<{
    operation: string;
    variables: Record<string, unknown> | undefined;
  }> = [];
  const client = createDiscoveryClient(async (operation, variables) => {
    calls.push({ operation, variables });
    return resultFor(operation);
  });

  const snapshot = await discoverLinearCapabilities(client, {
    at: DISCOVERED_AT,
    freshnessTtlMs: 10 * 60 * 1_000,
    maxItemsPerCollection: 7,
  });

  assert.deepEqual(calls.map((call) => call.operation), [
    "connection.context",
    "teams.list",
    "projects.list",
    "workflow_states.list",
  ]);
  assert.deepEqual(calls[0].variables, {});
  for (const call of calls.slice(1)) {
    assert.deepEqual(call.variables, { first: 7, includeArchived: false });
    assert.equal("id" in (call.variables ?? {}), false);
    assert.equal("input" in (call.variables ?? {}), false);
  }
  assert.deepEqual(snapshot.viewer, { id: "viewer-1", name: "Researcher" });
  assert.deepEqual(snapshot.workspace, { id: "workspace-1", name: "Acme" });
  assert.deepEqual(snapshot.teams, [
    { id: "team-1", name: "Platform", key: "PLAT" },
  ]);
  assert.deepEqual(snapshot.projects, [
    {
      id: "project-1",
      name: "Agentic Researcher",
      url: "https://linear.app/acme/project/agentic",
      teamIds: ["team-1"],
    },
  ]);
  assert.deepEqual(snapshot.workflowStates, [
    {
      id: "state-1",
      name: "In Progress",
      type: "started",
      teamId: "team-1",
    },
  ]);
  assert.equal(snapshot.sources[2].truncated, true);
  assert.equal(
    snapshot.capabilities.find((item) => item.id === "team_selection")?.enabled,
    true,
  );
  assert.deepEqual(snapshot.capabilities.at(-1), {
    id: "mutation_authority",
    enabled: false,
    summary:
      "Discovery grants no mutation authority; host policy and exact action approval remain required.",
  });
  assert.match(snapshot.snapshotHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(snapshot.freshUntil, "2026-07-12T16:10:00.000Z");
  assert.equal(JSON.stringify(snapshot).includes("lin_api_"), false);
  assert.deepEqual(
    await parseLinearCapabilitySnapshot(JSON.parse(JSON.stringify(snapshot))),
    snapshot,
  );
});

test("collection read failures remain visible without leaking error text or blocking other selectors", async () => {
  const secret = "lin_api_do_not_persist";
  const client = createDiscoveryClient(async (operation) => {
    if (operation === "projects.list") {
      throw new LinearClientError(
        "linear_forbidden",
        `Authorization ${secret} cannot read projects.`,
        { operationKey: operation },
      );
    }
    return resultFor(operation);
  });

  const snapshot = await discoverLinearCapabilities(client, { at: DISCOVERED_AT });

  assert.deepEqual(snapshot.projects, []);
  assert.deepEqual(snapshot.sources[2], {
    operation: "projects.list",
    enabled: false,
    itemCount: 0,
    truncated: false,
    errorCode: "linear_forbidden",
  });
  assert.equal(
    snapshot.capabilities.find((item) => item.id === "project_selection")?.enabled,
    false,
  );
  assert.equal(snapshot.teams.length, 1);
  assert.equal(snapshot.workflowStates.length, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /do_not_persist|Authorization/);
});

test("strict snapshot parsing rejects unknown state, tampering, and forged mutation authority", async () => {
  const snapshot = await discoverLinearCapabilities(
    createDiscoveryClient(async (operation) => resultFor(operation)),
    { at: DISCOVERED_AT },
  );

  await assert.rejects(
    parseLinearCapabilitySnapshot({ ...snapshot, apiKey: "lin_api_injected" }),
    /keys are invalid/,
  );
  await assert.rejects(
    parseLinearCapabilitySnapshot({
      ...snapshot,
      teams: [{ ...snapshot.teams[0], name: "Tampered" }],
    }),
    /hash does not match/,
  );

  const forgedWithoutHash = {
    ...snapshot,
    capabilities: snapshot.capabilities.map((capability) =>
      capability.id === "mutation_authority"
        ? { ...capability, enabled: true }
        : capability),
  };
  const { snapshotHash: _oldHash, ...forgedPayload } = forgedWithoutHash;
  const forged: LinearCapabilitySnapshotV1 = {
    ...forgedPayload,
    snapshotHash: await sha256LinearValue(forgedPayload),
  };
  await assert.rejects(
    parseLinearCapabilitySnapshot(forged),
    /report does not match/,
  );
});

test("snapshot freshness is deterministic and bounded", async () => {
  const snapshot = await discoverLinearCapabilities(
    createDiscoveryClient(async (operation) => resultFor(operation)),
    { at: DISCOVERED_AT, freshnessTtlMs: 60_000 },
  );

  assert.equal(
    getLinearCapabilitySnapshotFreshness(snapshot, "2026-07-12T15:59:59.999Z"),
    "not_yet_valid",
  );
  assert.equal(
    getLinearCapabilitySnapshotFreshness(snapshot, "2026-07-12T16:01:00.000Z"),
    "fresh",
  );
  assert.equal(
    getLinearCapabilitySnapshotFreshness(snapshot, "2026-07-12T16:01:00.001Z"),
    "stale",
  );
  await assert.rejects(
    discoverLinearCapabilities(
      createDiscoveryClient(async (operation) => resultFor(operation)),
      { at: DISCOVERED_AT, freshnessTtlMs: 24 * 60 * 60 * 1_000 + 1 },
    ),
    /freshness TTL/,
  );
});

test("malformed or over-bound collection results disable only that fixed source", async () => {
  const client = createDiscoveryClient(async (operation) => {
    if (operation === "teams.list") {
      return page(
        Array.from({ length: 3 }, (_, index) =>
          linearRecord("team", `team-${index}`, { name: `Team ${index}` })),
      );
    }
    return resultFor(operation);
  });

  const snapshot = await discoverLinearCapabilities(client, {
    at: DISCOVERED_AT,
    maxItemsPerCollection: 2,
  });

  assert.deepEqual(snapshot.teams, []);
  assert.deepEqual(snapshot.sources[1], {
    operation: "teams.list",
    enabled: false,
    itemCount: 0,
    truncated: false,
    errorCode: "linear_discovery_failed",
  });
  assert.equal(snapshot.projects.length, 1);
});

function createDiscoveryClient(
  execute: (
    operation: string,
    variables: Record<string, unknown> | undefined,
  ) => Promise<LinearOperationResult> | LinearOperationResult,
): LinearCapabilityDiscoveryClient {
  return {
    execute: async (operation, variables) => execute(operation, variables),
  };
}

function resultFor(operation: string): LinearOperationResult {
  switch (operation) {
    case "connection.context":
      return {
        viewer: { id: "viewer-1", name: "Researcher" },
        workspace: { id: "workspace-1", name: "Acme" },
        fetchedAt: FETCHED_AT,
      };
    case "teams.list":
      return page([
        linearRecord("team", "team-1", { name: "Platform", key: "PLAT" }),
      ]);
    case "projects.list":
      return page(
        [
          linearRecord("project", "project-1", {
            name: "Agentic Researcher",
            url: "https://linear.app/acme/project/agentic",
            attributes: { teams: ["team-1"] },
          }),
        ],
        true,
      );
    case "workflow_states.list":
      return page([
        linearRecord("workflow_state", "state-1", {
          name: "In Progress",
          type: "started",
          attributes: { team: "team-1" },
        }),
      ]);
    default:
      throw new Error(`Unexpected operation ${operation}`);
  }
}

function page(
  items: LinearBaseRecord[],
  hasNextPage = false,
): LinearOperationResult {
  return {
    items,
    pageInfo: {
      hasNextPage,
      ...(hasNextPage ? { endCursor: "next-page" } : {}),
    },
    fetchedAt: FETCHED_AT,
  };
}

function linearRecord(
  resourceType: "team" | "project" | "workflow_state",
  id: string,
  values: Partial<LinearBaseRecord>,
): LinearBaseRecord {
  return {
    resourceType,
    id,
    snapshotHash: `sha256:${"1".repeat(64)}`,
    ...values,
  };
}
