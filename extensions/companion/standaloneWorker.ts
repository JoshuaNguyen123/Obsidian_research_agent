import {
  buildHeadlessExecutorCatalogV1,
  CompanionCoordinatorClientV1,
  CompanionLinearQueuePollerV1,
  CompanionSecretStoreClientV1,
  CompanionWorkerCoordinatorV1,
  createSessionBootstrapTokenLeaseV1,
  type HeadlessExecutorCatalogConfigV1,
  parseHeadlessExecutorCatalogConfigV1,
  normalizeLinearIssueReadbackV1,
  createCompanionLinearQueueCandidateObservationV1,
  sha256Fingerprint,
} from "@agentic-researcher/headless-runtime";
import { parseRenderedCompatibleWorkItemSpec } from "../../src/integrations/linear/WorkItemParser";
import { getLinearOperationDefinition } from "../../src/integrations/linear/operations";
import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { createPreparedBackgroundCodeStandaloneExecutorV1 } from "../code/background";
import {
  createPreparedBackgroundGitHubStandaloneExecutorV1,
  prepareBackgroundGitHubProviderDependencyFactoryV1,
} from "../integrations/background";
import { requestFixedProviderJsonV1 } from "./FixedProviderJsonV1";

interface WorkerArguments {
  baseUrl: string;
  coordinatorId: string;
  executorConfigPath: string | null;
  codeApplicationDataRoot: string;
  integrationsApplicationDataRoot: string;
  pollIntervalMs: number;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const tokenBuffer = readStdinBounded(4_096);
  let token = "";
  try {
    token = tokenBuffer.toString("utf8").trim();
  } finally {
    tokenBuffer.fill(0);
  }
  const credential = createSessionBootstrapTokenLeaseV1(token, {
    source: "service_bootstrap",
    persistent: true,
  });
  token = "";
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const executorConfig = readExecutorConfig(args.executorConfigPath);
    const client = new CompanionCoordinatorClientV1({
      baseUrl: args.baseUrl,
      credential,
      timeoutMs: 30_000,
      maxResponseBytes: 1_048_576,
    });
    const secretStore = new CompanionSecretStoreClientV1({
      baseUrl: args.baseUrl,
      credential,
      timeoutMs: 30_000,
    });
    const githubProviderFactory = await prepareBackgroundGitHubProviderDependencyFactoryV1({
      applicationDataRoot: args.integrationsApplicationDataRoot,
      secretStore,
    }).catch(() => null);
    const catalogFingerprint = await sha256Fingerprint(
      executorConfig ?? { version: 1, executors: {} },
    );
    const linearQueuePoller = new CompanionLinearQueuePollerV1({
      client,
      secretStore,
      coordinatorId: args.coordinatorId,
      catalogFingerprint,
      scan: readFixedLinearQueuePage,
    });
    const coordinator = new CompanionWorkerCoordinatorV1({
      client,
      coordinatorId: args.coordinatorId,
      catalogFingerprint,
      executorCatalog: buildHeadlessExecutorCatalogV1(
        executorConfig,
        {
          publicResearchFetch: {
            requestPinned: requestPinnedPublicSource,
            resolveHost: async (hostname) =>
              (await lookup(hostname, { all: true, verbatim: true })).map(
                (entry) => entry.address,
              ),
          },
          secretStore,
          linearReadIssue: readFixedLinearIssue,
          linearUpdateIssueState: updateFixedLinearIssueState,
          githubReadRepository: readFixedGitHubRepository,
          preparedBackgroundCodeExecutor:
            createPreparedBackgroundCodeStandaloneExecutorV1({
              applicationDataRoot: args.codeApplicationDataRoot,
            }),
          preparedBackgroundGitHubExecutor:
            createPreparedBackgroundGitHubStandaloneExecutorV1({
              applicationDataRoot: args.integrationsApplicationDataRoot,
              ...(githubProviderFactory
                ? { createRuntimeDependencies: githubProviderFactory }
                : {}),
              hostApprovalSignerAvailable: async () => {
                const description = await client.describeHostApprovalSigner();
                return description.persistent && description.provisioned;
              },
              hostApprovalReceiptVerifier: {
                async verify(receipt) {
                  return (await client.verifyHostApprovalReceipt(receipt)).verified;
                },
              },
            }),
        },
      ),
      pollIntervalMs: args.pollIntervalMs,
      linearQueuePoller,
      leaseSeconds: 60,
      heartbeatIntervalMs: 20_000,
    });
    await coordinator.runForever(controller.signal);
  } finally {
    credential.dispose();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function readFixedLinearQueuePage(
  input: {
    configuration: {
      queueProjectId: string;
    };
    cursor: { updatedAt: string; issueId: string } | null;
  },
  credential: string,
  signal: AbortSignal,
) {
  const operation = getLinearOperationDefinition("issues.list");
  if (!operation || operation.access !== "read" || operation.rootField !== "issues") {
    throw new Error("The fixed Linear issue-list catalog operation is unavailable.");
  }
  const response = asRecord(
    await requestFixedProviderJsonV1(
      new URL("https://api.linear.app/graphql"),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: credential,
          "Content-Type": "application/json",
          "User-Agent": "AgenticResearcherCompanion/0.3",
        },
        body: JSON.stringify({
          query: operation.document,
          variables: {
            first: 10,
            after: null,
            includeArchived: false,
            filter: {
              project: { id: { eq: input.configuration.queueProjectId } },
              ...(input.cursor
                ? { updatedAt: { gte: input.cursor.updatedAt } }
                : {}),
            },
          },
        }),
      },
      signal,
    ),
  );
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    throw new Error("Linear queue scan returned a provider error.");
  }
  const connection = asRecord(asRecord(response.data).issues);
  const nodes = Array.isArray(connection.nodes) ? connection.nodes : null;
  if (!nodes) throw new Error("Linear queue scan returned an invalid connection.");

  const snapshots = await Promise.all(
    nodes.map(async (value) => {
      const issue = asRecord(value);
      const project = asRecord(issue.project);
      const state = asRecord(issue.state);
      const id = requiredString(issue.id, "Linear queue issue id");
      const updatedAt = requiredString(
        issue.updatedAt,
        "Linear queue issue updatedAt",
      );
      if (
        project.id !== input.configuration.queueProjectId
      ) {
        return null;
      }
      if (
        input.cursor &&
        (updatedAt < input.cursor.updatedAt ||
          (updatedAt === input.cursor.updatedAt && id <= input.cursor.issueId))
      ) {
        return null;
      }
      return {
        issue,
        id,
        updatedAt,
        state,
        terminal:
          issue.trashed === true ||
          typeof issue.archivedAt === "string" ||
          typeof issue.completedAt === "string" ||
          typeof issue.canceledAt === "string",
      };
    }),
  );
  const ordered = snapshots
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .slice(0, 10);
  const candidates = [];
  for (const snapshot of ordered) {
    // Terminal records still advance the trusted project cursor, matching the
    // foreground supervisor, but can never become executable observations.
    if (snapshot.terminal) continue;
    if (typeof snapshot.issue.description !== "string") continue;
    let workItemFingerprint: string;
    try {
      workItemFingerprint = parseRenderedCompatibleWorkItemSpec(
        snapshot.issue.description,
      ).spec.fingerprint;
    } catch {
      // Provider content is untrusted. Only a valid signed work-item contract
      // can become a fingerprint-only candidate observation.
      continue;
    }
    const readback = await normalizeLinearIssueReadbackV1(snapshot.issue);
    if (!readback.snapshotFingerprint) {
      throw new Error("Linear queue candidate readback fingerprint is missing.");
    }
    candidates.push(
      await createCompanionLinearQueueCandidateObservationV1({
        issueId: snapshot.id,
        identifier: requiredString(
          snapshot.issue.identifier,
          "Linear queue issue identifier",
        ),
        queueProjectId: input.configuration.queueProjectId,
        remoteStateId: requiredString(
          snapshot.state.id,
          "Linear queue issue state id",
        ),
        remoteUpdatedAt: snapshot.updatedAt,
        workItemFingerprint,
        readbackFingerprint: readback.snapshotFingerprint,
      }),
    );
  }
  const last = ordered.at(-1);
  return {
    candidates,
    cursor: last ? { updatedAt: last.updatedAt, issueId: last.id } : input.cursor,
  };
}

async function requestPinnedPublicSource(
  url: URL,
  address: string,
  signal: AbortSignal,
): Promise<Response> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise<Response>((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        method: "GET",
        path: `${url.pathname}${url.search}`,
        servername: url.hostname.replace(/^\[|\]$/g, ""),
        headers: {
          Accept: "text/plain,text/html,application/json,application/xml;q=0.8",
          "User-Agent": "AgenticResearcherCompanion/0.2",
          Host: url.host,
        },
        lookup: ((_hostname: string, _options: unknown, callback: Function) => {
          callback(null, address, address.includes(":") ? 6 : 4);
        }) as never,
      },
      (incoming) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
          else if (value !== undefined) headers.set(key, String(value));
        }
        resolve(
          new Response(Readable.toWeb(incoming) as ReadableStream, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage,
            headers,
          }),
        );
      },
    );
    const abort = () => request.destroy(new Error("Public research request aborted."));
    signal.addEventListener("abort", abort, { once: true });
    request.once("error", reject);
    request.once("close", () => signal.removeEventListener("abort", abort));
    request.end();
  });
}

function parseArguments(values: string[]): WorkerArguments {
  const read = (name: string): string | null => {
    const index = values.indexOf(name);
    return index >= 0 ? values[index + 1] ?? null : null;
  };
  const baseUrl = read("--base-url");
  const coordinatorId = read("--coordinator-id");
  const codeApplicationDataRoot = read("--code-application-data-root");
  const integrationsApplicationDataRoot = read("--integrations-application-data-root");
  if (!baseUrl || !coordinatorId || !codeApplicationDataRoot || !integrationsApplicationDataRoot) {
    throw new Error("Standalone companion worker arguments are incomplete.");
  }
  const poll = Number(read("--poll-interval-ms") ?? "2000");
  return {
    baseUrl,
    coordinatorId,
    codeApplicationDataRoot,
    integrationsApplicationDataRoot,
    executorConfigPath: read("--executor-config"),
    pollIntervalMs: Number.isFinite(poll)
      ? Math.max(250, Math.min(60_000, Math.floor(poll)))
      : 2_000,
  };
}

function readExecutorConfig(path: string | null): HeadlessExecutorCatalogConfigV1 | null {
  if (!path) return null;
  return parseHeadlessExecutorCatalogConfigV1(
    JSON.parse(readFileSync(path, "utf8")),
  );
}

async function readFixedLinearIssue(
  input: { issueId: string },
  credential: string,
  signal: AbortSignal,
) {
  const response = await requestFixedProviderJsonV1(
    new URL("https://api.linear.app/graphql"),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: credential,
        "Content-Type": "application/json",
        "User-Agent": "AgenticResearcherCompanion/0.3",
      },
      body: JSON.stringify({
        query:
          `query CompanionIssueReadback($id: String!) {
            issue(id: $id) {
              id identifier url title description priority estimate dueDate trashed
              createdAt updatedAt archivedAt completedAt canceledAt
              team { id name key }
              state { id name type }
              project { id name url }
              cycle { id name }
              projectMilestone { id name }
              assignee { id name url }
              parent { id identifier title url }
              labels(first: 50) { nodes { id name color } }
            }
          }`,
        variables: { id: input.issueId },
      }),
    },
    signal,
  );
  const record = asRecord(response);
  const errors = Array.isArray(record.errors) ? record.errors : [];
  if (errors.length > 0) {
    throw new Error("Linear issue readback returned a provider error.");
  }
  const issue = asRecord(asRecord(record.data).issue);
  const normalized = await normalizeLinearIssueReadbackV1(issue);
  const rawProjectId = asRecord(issue.project).id;
  const projectId =
    typeof rawProjectId === "string" && rawProjectId.length > 0
      ? rawProjectId
      : undefined;
  let workItemFingerprint: string | undefined;
  if (typeof issue.description === "string") {
    try {
      workItemFingerprint = parseRenderedCompatibleWorkItemSpec(
        issue.description,
      ).spec.fingerprint;
    } catch {
      // Untrusted issue prose is never projected. Queue callers require this
      // field and will fail closed; ordinary fixed readbacks may omit it.
    }
  }
  return { ...normalized, projectId, workItemFingerprint };
}

async function updateFixedLinearIssueState(
  input: { issueId: string; stateId: string },
  credential: string,
  signal: AbortSignal,
): Promise<{ providerRequestId: string | null }> {
  const response = await requestFixedProviderJsonV1(
    new URL("https://api.linear.app/graphql"),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: credential,
        "Content-Type": "application/json",
        "User-Agent": "AgenticResearcherCompanion/0.3",
      },
      body: JSON.stringify({
        query:
          "mutation CompanionIssueStateUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }",
        variables: { id: input.issueId, input: { stateId: input.stateId } },
      }),
    },
    signal,
  );
  const record = asRecord(response);
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    throw new Error("Linear issue state update returned a provider error.");
  }
  const update = asRecord(asRecord(record.data).issueUpdate);
  const issue = asRecord(update.issue);
  if (update.success !== true || issue.id !== input.issueId) {
    throw new Error("Linear issue state update returned an invalid response.");
  }
  return { providerRequestId: null };
}

async function readFixedGitHubRepository(
  input: { owner: string; repository: string },
  credential: string,
  signal: AbortSignal,
) {
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`,
  );
  const response = asRecord(
    await requestFixedProviderJsonV1(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${credential}`,
          "User-Agent": "AgenticResearcherCompanion/0.3",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      signal,
    ),
  );
  return {
    id: requiredInteger(response.id, "GitHub repository id"),
    nodeId: requiredString(response.node_id, "GitHub repository node id"),
    fullName: requiredString(response.full_name, "GitHub repository full name"),
    defaultBranch: requiredString(
      response.default_branch,
      "GitHub repository default branch",
    ),
    private: requiredBoolean(response.private, "GitHub repository private"),
    archived: requiredBoolean(response.archived, "GitHub repository archived"),
    updatedAt: requiredString(response.updated_at, "GitHub repository updatedAt"),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    throw new Error(`${field} is invalid.`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} is invalid.`);
  }
  return value as number;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} is invalid.`);
  return value;
}

function readStdinBounded(maxBytes: number): Buffer {
  const value = readFileSync(0);
  if (value.byteLength > maxBytes) {
    value.fill(0);
    throw new Error("Standalone worker bootstrap input exceeded its limit.");
  }
  return value;
}

void main().catch(() => {
  process.exitCode = 1;
});
