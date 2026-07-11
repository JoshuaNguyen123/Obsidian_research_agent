import test from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, HttpTransport } from "../src/model/types";
import {
  LINEAR_GRAPHQL_ENDPOINT,
  LinearClientError,
  createLinearGraphqlClient,
  normalizeLinearRecord,
  type LinearIssueRecord,
  type LinearPage,
} from "../src/integrations/linear";

test("connection context uses the fixed endpoint and personal-key authorization", async () => {
  let captured: HttpRequest | undefined;
  const client = createLinearGraphqlClient({
    apiKey: "lin_api_test_secret",
    timeoutMs: 12_345,
    transport: async (request) => {
      captured = request;
      return {
        status: 200,
        headers: {},
        json: {
          data: {
            viewer: { id: "user-1", name: "Researcher" },
            organization: { id: "workspace-1", name: "Workspace" },
          },
        },
      };
    },
  });

  const result = await client.getConnectionContext();

  assert.equal(captured?.url, LINEAR_GRAPHQL_ENDPOINT);
  assert.equal(captured?.method, "POST");
  assert.equal(captured?.contentType, "application/json");
  assert.equal(captured?.headers?.Authorization, "lin_api_test_secret");
  assert.equal(captured?.timeoutMs, 12_345);
  const body = JSON.parse(String(captured?.body));
  assert.equal(body.operationName, "LinearConnectionContext");
  assert.deepEqual(body.variables, {});
  assert.equal(result.viewer.id, "user-1");
  assert.equal(result.workspace.id, "workspace-1");
});

test("missing key and unknown operation fail before transport", async () => {
  let calls = 0;
  const client = createLinearGraphqlClient({
    apiKey: "",
    transport: async () => {
      calls += 1;
      throw new Error("should not run");
    },
  });

  await assert.rejects(
    client.getConnectionContext(),
    (error: unknown) =>
      error instanceof LinearClientError && error.code === "linear_missing_api_key",
  );
  const configured = createLinearGraphqlClient({
    apiKey: "configured",
    transport: async () => {
      calls += 1;
      throw new Error("should not run");
    },
  });
  await assert.rejects(
    configured.execute("not.a.real.operation"),
    (error: unknown) =>
      error instanceof LinearClientError && error.code === "linear_unknown_operation",
  );
  assert.equal(calls, 0);
});

test("partial GraphQL responses are rejected and secrets are redacted", async () => {
  const secret = "lin_api_super_secret";
  const client = createLinearGraphqlClient({
    apiKey: secret,
    transport: async () => ({
      status: 200,
      headers: {},
      json: {
        data: { viewer: { id: "user-1", name: "Researcher" } },
        errors: [
          {
            message: `Authorization ${secret} was rejected`,
            path: ["organization"],
            extensions: { code: "FORBIDDEN" },
          },
        ],
      },
    }),
  });

  await assert.rejects(client.getConnectionContext(), (error: unknown) => {
    assert.ok(error instanceof LinearClientError);
    assert.equal(error.code, "linear_partial_response");
    assert.equal(error.details?.[0].code, "FORBIDDEN");
    assert.doesNotMatch(error.details?.[0].message ?? "", /super_secret/);
    assert.match(error.details?.[0].message ?? "", /REDACTED/);
    return true;
  });
});

test("HTTP status classification survives non-JSON error bodies", async () => {
  const client = createLinearGraphqlClient({
    apiKey: "key",
    transport: async () => ({
      status: 401,
      headers: {},
      text: "unauthorized",
    }),
  });

  await assert.rejects(
    client.getConnectionContext(),
    (error: unknown) =>
      error instanceof LinearClientError && error.code === "linear_auth",
  );
});

test("GraphQL extension codes are classified when no partial data exists", async () => {
  const client = createLinearGraphqlClient({
    apiKey: "key",
    transport: async () => ({
      status: 200,
      headers: {},
      json: {
        errors: [
          {
            message: "This token cannot read the workspace.",
            extensions: { code: "FORBIDDEN" },
          },
        ],
      },
    }),
  });

  await assert.rejects(
    client.getConnectionContext(),
    (error: unknown) =>
      error instanceof LinearClientError && error.code === "linear_forbidden",
  );
});

test("a null resource root with NOT_FOUND is absence, not partial success", async () => {
  const client = createLinearGraphqlClient({
    apiKey: "key",
    transport: async () => ({
      status: 200,
      headers: {},
      json: {
        data: { issue: null },
        errors: [
          {
            message: "Issue not found.",
            extensions: { code: "ENTITY_NOT_FOUND" },
          },
        ],
      },
    }),
  });

  await assert.rejects(
    client.execute("issues.get", { id: "missing" }),
    (error: unknown) =>
      error instanceof LinearClientError && error.code === "linear_not_found",
  );
});

test("rate-limit errors preserve reset metadata and read retryability", async () => {
  const client = createLinearGraphqlClient({
    apiKey: "key",
    transport: async () => ({
      status: 400,
      headers: { "X-RateLimit-Requests-Reset": "1900000000000" },
      json: {
        errors: [
          { message: "Slow down", extensions: { code: "RATELIMITED" } },
        ],
      },
    }),
  });

  await assert.rejects(client.execute("teams.list"), (error: unknown) => {
    assert.ok(error instanceof LinearClientError);
    assert.equal(error.code, "linear_rate_limited");
    assert.equal(error.retryAtMs, 1_900_000_000_000);
    assert.equal(error.retryable, true);
    return true;
  });
});

test("mutation transport uncertainty is never marked retryable", async () => {
  const secret = "lin_api_mutation_secret";
  const client = createLinearGraphqlClient({
    apiKey: secret,
    transport: async () => {
      throw new Error(`Request timed out with ${secret}`);
    },
  });

  await assert.rejects(
    client.execute("issues.create", {
      input: { id: "client-id", teamId: "team-id", title: "Ticket" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof LinearClientError);
      assert.equal(error.code, "linear_timeout");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /mutation_secret/);
      return true;
    },
  );
});

test("pagination is bounded and connection nodes are normalized", async () => {
  let captured: HttpRequest | undefined;
  const transport: HttpTransport = async (request) => {
    captured = request;
    return {
      status: 200,
      headers: {},
      json: {
        data: {
          teams: {
            nodes: [
              {
                id: "team-1",
                name: "Platform",
                key: "PLAT",
                description: "Team",
                color: "#00ff00",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-02T00:00:00.000Z",
                archivedAt: null,
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
          },
        },
      },
    };
  };
  const client = createLinearGraphqlClient({ apiKey: "key", transport });

  const result = (await client.execute("teams.list", {
    first: 999,
  })) as LinearPage<{ id: string; snapshotHash: string }>;

  const variables = JSON.parse(String(captured?.body)).variables;
  assert.equal(variables.first, 50);
  assert.equal(variables.includeArchived, false);
  assert.equal(result.items[0].id, "team-1");
  assert.match(result.items[0].snapshotHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.pageInfo, {
    hasNextPage: true,
    endCursor: "cursor-2",
  });
});

test("fixed operations reject unknown variables and unsafe nested JSON", async () => {
  let calls = 0;
  const client = createLinearGraphqlClient({
    apiKey: "key",
    transport: async () => {
      calls += 1;
      return { status: 200, headers: {}, json: { data: {} } };
    },
  });

  await assert.rejects(
    client.execute("teams.list", { arbitraryGraphql: "query { viewer { id } }" }),
    (error: unknown) =>
      error instanceof LinearClientError && error.code === "linear_invalid_arguments",
  );
  await assert.rejects(
    client.execute("issues.create", {
      input: JSON.parse('{"title":"x","__proto__":{"polluted":true}}'),
    }),
    (error: unknown) =>
      error instanceof LinearClientError && error.code === "linear_invalid_arguments",
  );
  await assert.rejects(
    client.execute("teams.list", {}, { deadlineAt: Number.NaN }),
    (error: unknown) =>
      error instanceof LinearClientError && error.code === "linear_invalid_arguments",
  );
  assert.equal(calls, 0);
});

test("issue records use a stable normalized shape", async () => {
  const client = createLinearGraphqlClient({
    apiKey: "key",
    transport: async () => ({
      status: 200,
      headers: {},
      json: {
        data: {
          issue: {
            id: "issue-1",
            identifier: "PLAT-42",
            url: "https://linear.app/acme/issue/PLAT-42",
            title: "Add adapter",
            description: "Implement the fixed adapter.",
            trashed: false,
            priority: 2,
            estimate: 3,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
            team: { id: "team-1", name: "Platform", key: "PLAT" },
            state: { id: "state-1", name: "Todo", type: "unstarted" },
            project: null,
            cycle: null,
            projectMilestone: null,
            assignee: null,
            parent: null,
            labels: { nodes: [{ id: "label-1", name: "agent" }] },
          },
        },
      },
    }),
  });

  const issue = (await client.execute("issues.get", {
    id: "PLAT-42",
  })) as LinearIssueRecord;

  assert.equal(issue.identifier, "PLAT-42");
  assert.equal(issue.trashed, false);
  assert.equal(issue.team.key, "PLAT");
  assert.equal(issue.state.type, "unstarted");
  assert.deepEqual(issue.labels, [{ id: "label-1", name: "agent" }]);
  assert.match(issue.snapshotHash, /^sha256:[0-9a-f]{64}$/);
});

test("generic records retain bounded attributes needed for mutation readback", async () => {
  const project = await normalizeLinearRecord("project", {
    id: "project-1",
    name: "Roadmap",
    priority: 2,
    trashed: false,
    status: { id: "status-1", name: "Planned" },
    teams: { nodes: [{ id: "team-1", name: "Platform" }] },
    labels: { nodes: [{ id: "label-1", name: "agent" }] },
  });

  assert.equal(project.trashed, false);
  assert.deepEqual(project.labels, [{ id: "label-1", name: "agent" }]);
  assert.equal(project.attributes?.priority, 2);
  assert.equal(project.attributes?.status, "status-1");
  assert.deepEqual(project.attributes?.teams, ["team-1"]);
  assert.deepEqual(project.attributes?.labels, ["label-1"]);
});
