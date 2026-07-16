import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { InMemorySecretStoreV1 } from "../packages/headless-runtime/src/secretStoreV1";
import { LinearGraphqlClient } from "../src/integrations/linear/client";
import { createLinearTools } from "../src/integrations/linear/LinearTools";
import { GitHubApiError, GitHubRestClient } from "../src/integrations/github/GitHubRestClient";
import {
  LoopbackEphemeralGitAskpassBrokerV1,
  SpawnVerifiedGitCommandRunnerV1,
} from "../src/integrations/github/SecureGitPushRuntime";
import { sha256Fingerprint, type PreparedAction } from "../src/agent/actions";
import type { HttpTransport } from "../src/model/types";
import type {
  AgentTool,
  AgentToolActionExecution,
  ToolExecutionContext,
} from "../src/tools/types";
import { DefaultToolRegistry } from "../src/tools/ToolRegistry";

const DISPOSABLE_NAME = /(?:disposable|e2e|sandbox|test)/iu;
const PRODUCTION_NAME = /(?:^|[-_.\/])(prod|production)(?:$|[-_.\/])/iu;
const execFileAsync = promisify(execFile);

test.describe.serial("disposable live external smoke", () => {
  test("mutates, reads back, deduplicates, and cleans only the announced disposable provider", async () => {
    test.skip(
      process.env.E2E_LIVE_EXTERNAL !== "1",
      "Run only through npm run test:e2e:live with explicitly named disposable targets.",
    );
    test.setTimeout(30 * 60_000);

    const githubRepository = requiredEnvironment("E2E_LIVE_GITHUB_REPOSITORY");
    const linearProject = requiredEnvironment("E2E_LIVE_LINEAR_PROJECT");
    const provider = requiredEnvironment("E2E_LIVE_PROVIDER");
    expect(["linear", "github_draft", "github_merge"]).toContain(provider);
    expect(githubRepository).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
    expect(githubRepository).toMatch(DISPOSABLE_NAME);
    expect(githubRepository).not.toMatch(PRODUCTION_NAME);
    expect(linearProject).toMatch(DISPOSABLE_NAME);
    expect(linearProject).not.toMatch(PRODUCTION_NAME);
    const mergeRequested = provider === "github_merge";
    expect(process.env.E2E_LIVE_ALLOW_MERGE ?? "0").toBe(
      mergeRequested ? "1" : "0",
    );
    expect(process.env.LIVE_EXTERNAL_MERGE_CONFIRMATION ?? "").toBe(
      mergeRequested ? "MERGE_DISPOSABLE_PR" : "",
    );
    expect(process.env.AGENTIC_LIVE_EXTERNAL_CLEANUP_REQUIRED).toBe("true");

    if (provider === "linear") {
      await runLinearSmoke();
    } else {
      await runGitHubSmoke({ merge: mergeRequested });
    }

    test.info().annotations.push({
      type: "live-provider-proof",
      description:
        provider === "linear"
          ? "Created, independently read, duplicate-searched, commented on, and trashed one disposable Linear issue."
          : mergeRequested
            ? "Pushed local commits with ephemeral askpass, merged a disposable PR, and merged a compensating cleanup PR."
            : "Pushed one local commit with ephemeral askpass, verified a draft PR, then closed it and deleted its branch.",
    });
  });
});

async function runLinearSmoke(): Promise<void> {
  const token = requiredSecret("LINEAR_LIVE_TEST_TOKEN");
  const teamId = requiredEnvironment("LINEAR_LIVE_TEST_TEAM_ID");
  const projectId = requiredEnvironment("LINEAR_LIVE_TEST_PROJECT_ID");
  const store = new InMemorySecretStoreV1();
  const credential = await store.put({
    value: token,
    label: "Disposable Linear live smoke",
    metadata: {
      provider: "linear",
      credentialKind: "personal_api_key",
      scope: "disposable_live_e2e",
    },
  });
  let issueId: string | null = null;
  let commentId: string | null = null;
  const runSuffix = randomUUID();
  const title = `Agentic disposable live ${runSuffix}`;
  const description = [
    "Disposable live integration smoke. This issue must be removed by the same test.",
    `Run marker: ${runSuffix}`,
  ].join("\n\n");
  const context = liveToolContext(`Create and then clean up ${title}.`, `live-linear-${runSuffix}`);

  try {
    const lease = await store.lease(credential.referenceId, { ttlSeconds: 300 });
    try {
      await lease.withSecret(async (secret) => {
        const client = new LinearGraphqlClient({
          transport: fetchTransport,
          apiKey: secret,
          timeoutMs: 60_000,
        });
        const tools = createLinearTools({
          client,
          gate: 5,
          runIdFactory: () => context.runId!,
        });
        issueId = runSuffix;
        const created = await executePreparedTool(
          requiredTool(tools, "linear_create_issue"),
          {
            id: runSuffix,
            teamId,
            projectId,
            title,
            description,
          },
          { ...context, operationId: `linear-create-${runSuffix}` },
          "live-linear-create-approved",
        );
        issueId = created.receipt.resource.id;
        expect(created.receipt.readback.status).toBe("verified");
        expect(issueId).toBe(runSuffix);

        const readback = await client.execute("issues.get", { id: issueId });
        expect(readback).toMatchObject({
          resourceType: "issue",
          id: issueId,
          title,
          project: { id: projectId },
        });
        const duplicates = await client.execute("issues.search", {
          query: runSuffix,
          filter: { project: { id: { eq: projectId } } },
          first: 10,
          after: null,
          includeArchived: false,
        });
        expect(
          "items" in duplicates &&
            Array.isArray(duplicates.items) &&
            duplicates.items.filter((item) => item.id === issueId).length,
        ).toBe(1);

        const commentUuid = randomUUID();
        commentId = commentUuid;
        const commented = await executePreparedTool(
          requiredTool(tools, "linear_create_comment"),
          {
            id: commentUuid,
            issueId,
            body: `Disposable comment ${runSuffix}`,
          },
          { ...context, operationId: `linear-comment-${runSuffix}` },
          "live-linear-comment-approved",
        );
        commentId = commented.receipt.resource.id;
        expect(commentId).toBe(commentUuid);
        expect(commented.receipt.readback.status).toBe("verified");

        const deletedComment = await executePreparedTool(
          requiredTool(tools, "linear_delete_comment"),
          { id: commentId },
          { ...context, operationId: `linear-comment-delete-${runSuffix}` },
          "live-linear-delete-comment-approved",
        );
        expect(deletedComment.receipt.readback.status).toBe("verified");
        commentId = null;

        const trashed = await executePreparedTool(
          requiredTool(tools, "linear_trash_issue"),
          { id: issueId },
          { ...context, operationId: `linear-trash-${runSuffix}` },
          "live-linear-trash-approved",
        );
        expect(trashed.receipt.readback.status).toBe("verified");
        issueId = null;
      });
    } finally {
      lease.dispose();
    }
  } finally {
    // Cleanup retries use the same fixed provider operations and never claim
    // success silently. Any surviving ID makes the live gate fail loudly.
    if (issueId || commentId) {
      const cleanupLease = await store.lease(credential.referenceId, { ttlSeconds: 120 });
      try {
        await cleanupLease.withSecret(async (secret) => {
          const client = new LinearGraphqlClient({
            transport: fetchTransport,
            apiKey: secret,
            timeoutMs: 60_000,
          });
          const tools = createLinearTools({ client, gate: 5 });
          if (commentId) {
            await executePreparedTool(
              requiredTool(tools, "linear_delete_comment"),
              { id: commentId },
              { ...context, operationId: `linear-clean-comment-${runSuffix}` },
              "live-linear-cleanup-approved",
            );
            commentId = null;
          }
          if (issueId) {
            await executePreparedTool(
              requiredTool(tools, "linear_trash_issue"),
              { id: issueId },
              { ...context, operationId: `linear-clean-issue-${runSuffix}` },
              "live-linear-cleanup-approved",
            );
            issueId = null;
          }
        });
      } finally {
        cleanupLease.dispose();
      }
    }
    await store.remove(credential.referenceId);
    expect(issueId, "disposable Linear issue must not survive cleanup").toBeNull();
    expect(commentId, "disposable Linear comment must not survive cleanup").toBeNull();
  }
}

async function runGitHubSmoke(input: { merge: boolean }): Promise<void> {
  const token = requiredSecret("GITHUB_LIVE_TEST_TOKEN");
  const [owner, repository] = requiredEnvironment("E2E_LIVE_GITHUB_REPOSITORY").split("/");
  if (!owner || !repository) throw new Error("GitHub live repository is invalid.");
  const store = new InMemorySecretStoreV1();
  const credential = await store.put({
    value: token,
    label: "Disposable GitHub live smoke",
    metadata: {
      provider: "github",
      credentialKind: "fine_grained_pat",
      scope: "disposable_live_e2e",
    },
  });
  const tempRoot = path.join(os.tmpdir(), `agentic-live-github-${randomUUID()}`);
  await mkdir(tempRoot, { recursive: false });
  const gitExecutable = await resolveGitExecutable();
  const runner = new SpawnVerifiedGitCommandRunnerV1({
    gitExecutable,
    timeoutMs: 180_000,
    maxOutputBytes: 2_000_000,
  });
  const bindingFingerprint = await sha256Fingerprint({ owner, repository });
  const broker = new LoopbackEphemeralGitAskpassBrokerV1({
    secretStore: store,
    tempRoot,
    lifetimeMs: 120_000,
  });
  const remoteUrl = `https://github.com/${owner}/${repository}.git`;
  const repoRoot = path.join(tempRoot, "repository");
  const suffix = randomUUID().replace(/-/gu, "").slice(0, 20);
  const branch = `codex/live-e2e-${suffix}`;
  const markerRelativePath = `agentic-live-smoke/${suffix}.md`;
  let branchSha: string | null = null;
  let pullRequestNumber: number | null = null;
  let cleanupBranch: string | null = null;
  let cleanupBranchSha: string | null = null;
  let cleanupPullRequestNumber: number | null = null;
  let defaultBranch: string | null = null;
  let markerMerged = false;
  let markerCleaned = false;

  try {
    const lease = await store.lease(credential.referenceId, { ttlSeconds: 300 });
    try {
      await lease.withSecret(async (secret) => {
        const client = new GitHubRestClient({
          transport: fetchTransport,
          token: secret,
          timeoutMs: 60_000,
        });
        const identity = await client.getAuthenticatedUser();
        expect(identity.login).toMatch(/^[A-Za-z0-9-]+(?:\[bot\])?$/u);
        const repo = await client.getRepository(owner, repository);
        expect(repo.fullName.toLowerCase()).toBe(`${owner}/${repository}`.toLowerCase());
        const base = repo.defaultBranch;
        defaultBranch = base;

        await withAskpass(broker, credential.referenceId, bindingFingerprint, async (environment) => {
          await requireGitSuccess(
            runner,
            tempRoot,
            ["clone", "--no-tags", "--single-branch", "--branch", base, remoteUrl, repoRoot],
            environment,
          );
        });
        await requireGitSuccess(runner, repoRoot, ["checkout", "-b", branch]);
        const markerPath = path.join(repoRoot, ...markerRelativePath.split("/"));
        await mkdir(path.dirname(markerPath), { recursive: true });
        await writeFile(
          markerPath,
          `# Disposable GitHub smoke\n\nMarker ${suffix}. This file is removed by the cleanup flow.\n`,
          { encoding: "utf8", flag: "wx" },
        );
        await requireGitSuccess(runner, repoRoot, ["add", "--", markerRelativePath]);
        await requireGitSuccess(runner, repoRoot, [
          "-c",
          "user.name=Agentic Researcher Live E2E",
          "-c",
          "user.email=agentic-live-e2e@users.noreply.github.com",
          "commit",
          "-m",
          `test: disposable live smoke ${suffix}`,
        ]);
        branchSha = await gitText(runner, repoRoot, ["rev-parse", "HEAD"]);
        await withAskpass(broker, credential.referenceId, bindingFingerprint, async (environment) => {
          await requireGitSuccess(
            runner,
            repoRoot,
            ["push", remoteUrl, `HEAD:refs/heads/${branch}`],
            environment,
          );
        });
        expect((await client.getReference(owner, repository, branch)).sha).toBe(branchSha);

        const existing = await client.listPullRequestsForHead(owner, repository, branch, base);
        expect(existing).toHaveLength(0);
        const pullRequest = await client.createDraftPullRequest({
          owner,
          repository,
          title: `Disposable live smoke ${suffix}`,
          body: `Disposable-only run marker ${suffix}. Cleanup is mandatory.`,
          head: branch,
          base,
        });
        pullRequestNumber = pullRequest.number;
        expect(pullRequest.draft).toBe(true);
        expect(pullRequest.head.sha).toBe(branchSha);
        const exactDuplicate = await client.listPullRequestsForHead(
          owner,
          repository,
          branch,
          base,
        );
        expect(exactDuplicate.filter((item) => item.number === pullRequest.number)).toHaveLength(1);

        if (!input.merge) {
          const closed = await client.closePullRequest({
            owner,
            repository,
            number: pullRequest.number,
          });
          expect(closed.state).toBe("closed");
          pullRequestNumber = null;
          await client.deleteAgentBranch({
            owner,
            repository,
            branch,
            expectedSha: branchSha,
          });
          branchSha = null;
          return;
        }

        await client.markPullRequestReadyForReview({
          owner,
          repository,
          number: pullRequest.number,
        });
        const merged = await client.mergePullRequestSquash({
          owner,
          repository,
          number: pullRequest.number,
          expectedHeadSha: branchSha,
          commitTitle: `test: disposable live smoke ${suffix}`,
        });
        expect(merged.merged).toBe(true);
        expect((await client.getPullRequest(owner, repository, pullRequest.number)).merged).toBe(true);
        markerMerged = true;
        pullRequestNumber = null;
        await deleteBranchIfPresent(client, owner, repository, branch, branchSha);
        branchSha = null;

        cleanupBranch = `codex/live-e2e-cleanup-${suffix}`;
        await requireGitSuccess(runner, repoRoot, ["fetch", "--no-tags", remoteUrl, base]);
        await requireGitSuccess(runner, repoRoot, [
          "checkout",
          "-B",
          cleanupBranch,
          "FETCH_HEAD",
        ]);
        await unlink(markerPath);
        await requireGitSuccess(runner, repoRoot, ["add", "--", markerRelativePath]);
        await requireGitSuccess(runner, repoRoot, [
          "-c",
          "user.name=Agentic Researcher Live E2E",
          "-c",
          "user.email=agentic-live-e2e@users.noreply.github.com",
          "commit",
          "-m",
          `test: clean disposable live smoke ${suffix}`,
        ]);
        cleanupBranchSha = await gitText(runner, repoRoot, ["rev-parse", "HEAD"]);
        await withAskpass(broker, credential.referenceId, bindingFingerprint, async (environment) => {
          await requireGitSuccess(
            runner,
            repoRoot,
            ["push", remoteUrl, `HEAD:refs/heads/${cleanupBranch}`],
            environment,
          );
        });
        const cleanupPr = await client.createDraftPullRequest({
          owner,
          repository,
          title: `Cleanup disposable live smoke ${suffix}`,
          body: `Compensating cleanup for disposable-only run ${suffix}.`,
          head: cleanupBranch,
          base,
        });
        cleanupPullRequestNumber = cleanupPr.number;
        await client.markPullRequestReadyForReview({
          owner,
          repository,
          number: cleanupPr.number,
        });
        const cleanupMerge = await client.mergePullRequestSquash({
          owner,
          repository,
          number: cleanupPr.number,
          expectedHeadSha: cleanupBranchSha,
          commitTitle: `test: clean disposable live smoke ${suffix}`,
        });
        expect(cleanupMerge.merged).toBe(true);
        markerCleaned = true;
        cleanupPullRequestNumber = null;
        await deleteBranchIfPresent(
          client,
          owner,
          repository,
          cleanupBranch,
          cleanupBranchSha,
        );
        cleanupBranch = null;
        cleanupBranchSha = null;
      });
    } finally {
      lease.dispose();
    }
  } finally {
    // Best-effort provider cleanup is exact and safe; a failure is rethrown by
    // the main body and the surviving identifiers are reported by assertions.
    const cleanupLease = await store.lease(credential.referenceId, { ttlSeconds: 300 });
    try {
      await cleanupLease.withSecret(async (secret) => {
        const client = new GitHubRestClient({ transport: fetchTransport, token: secret });
        if (defaultBranch) {
          for (const candidate of await client.listPullRequestsForHead(
            owner,
            repository,
            branch,
            defaultBranch,
          )) {
            if (candidate.state === "open") {
              await ignoreNotFound(() => client.closePullRequest({
                owner,
                repository,
                number: candidate.number,
              }));
            }
          }
          if (cleanupBranch) {
            for (const candidate of await client.listPullRequestsForHead(
              owner,
              repository,
              cleanupBranch,
              defaultBranch,
            )) {
              if (candidate.state === "open") {
                await ignoreNotFound(() => client.closePullRequest({
                  owner,
                  repository,
                  number: candidate.number,
                }));
              }
            }
          }
        }
        if (cleanupPullRequestNumber) {
          await ignoreNotFound(() => client.closePullRequest({
            owner,
            repository,
            number: cleanupPullRequestNumber!,
          }));
          cleanupPullRequestNumber = null;
        }
        if (pullRequestNumber) {
          await ignoreNotFound(() => client.closePullRequest({
            owner,
            repository,
            number: pullRequestNumber!,
          }));
          pullRequestNumber = null;
        }
        if (cleanupBranch && cleanupBranchSha) {
          await ignoreNotFound(() => client.deleteAgentBranch({
            owner,
            repository,
            branch: cleanupBranch!,
            expectedSha: cleanupBranchSha!,
          }));
          cleanupBranch = null;
          cleanupBranchSha = null;
        }
        if (branchSha) {
          await ignoreNotFound(() => client.deleteAgentBranch({
            owner,
            repository,
            branch,
            expectedSha: branchSha!,
          }));
          branchSha = null;
        }
      });
    } finally {
      cleanupLease.dispose();
      await store.remove(credential.referenceId);
      await rm(tempRoot, { recursive: true, force: true });
    }
    expect(pullRequestNumber, "disposable PR must not survive cleanup").toBeNull();
    expect(cleanupPullRequestNumber, "cleanup PR must not remain open").toBeNull();
    expect(branchSha, "disposable branch must not survive cleanup").toBeNull();
    expect(cleanupBranchSha, "cleanup branch must not survive cleanup").toBeNull();
    expect(
      !markerMerged || markerCleaned,
      "a merged disposable marker requires a verified compensating cleanup merge",
    ).toBe(true);
  }
}

async function executePreparedTool(
  tool: AgentTool,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  grantId: string,
): Promise<AgentToolActionExecution> {
  const registry = new DefaultToolRegistry([tool]);
  const prepared = await registry.prepare(
    { id: context.operationId ?? `${tool.name}-live`, name: tool.name, arguments: args },
    context,
  );
  if (!prepared.ok) throw new Error(`${prepared.error.code}: ${prepared.error.message}`);
  const action: PreparedAction = prepared.action;
  const authorization = {
    preparedActionId: action.id,
    payloadFingerprint: action.payloadFingerprint,
    grantId,
  };
  const authorizedContext: ToolExecutionContext = {
    ...context,
    authorizedAction: authorization,
  };
  const executed = await registry.executePrepared(
    action,
    authorizedContext,
    authorization,
  );
  if (executed.ok && executed.receipt) {
    return {
      output: executed.output,
      receipt: executed.receipt,
      mutationState: "applied",
    };
  }
  if (
    (executed.mutationState === "may_have_applied" ||
      executed.mutationState === "unknown") &&
    tool.reconcile
  ) {
    const reconciled = await registry.reconcile(action, authorizedContext);
    if (reconciled.outcome !== "committed" || !reconciled.receipt) {
      throw new Error(
        `${executed.error?.code ?? "live_reconciliation_failed"}: ${reconciled.message}`,
      );
    }
    return {
      output: { reconciled: true },
      receipt: reconciled.receipt,
      mutationState: "applied",
    };
  }
  throw new Error(
    `${executed.error?.code ?? "live_mutation_failed"}: ${executed.error?.message ?? "Prepared provider mutation failed."}`,
  );
}

function requiredTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool?.prepare || !tool.executePrepared) {
    throw new Error(`Required prepared live tool is unavailable: ${name}.`);
  }
  return tool;
}

function liveToolContext(prompt: string, runId: string): ToolExecutionContext {
  return {
    app: {} as never,
    settings: {} as never,
    originalPrompt: prompt,
    runId,
    operationId: `${runId}-operation`,
    httpTransport: fetchTransport,
    now: () => new Date(),
  };
}

const fetchTransport: HttpTransport = async (request) => {
  const timeout = AbortSignal.timeout(Math.max(1, request.timeoutMs ?? 30_000));
  const signal = request.abortSignal
    ? AbortSignal.any([request.abortSignal, timeout])
    : timeout;
  const response = await fetch(request.url, {
    method: request.method ?? "GET",
    headers: request.headers,
    body:
      typeof request.body === "string"
        ? request.body
        : request.body instanceof ArrayBuffer
          ? request.body
          : undefined,
    signal,
    redirect: "error",
    credentials: "omit",
  });
  const text = await response.text();
  let json: unknown;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    status: response.status,
    headers,
    text,
    ...(json === undefined ? {} : { json }),
  };
};

async function resolveGitExecutable(): Promise<string> {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const argument = process.platform === "win32" ? "git.exe" : "git";
  const result = await execFileAsync(command, [argument], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64_000,
  });
  const first = result.stdout.split(/\r?\n/gu).map((value) => value.trim()).find(Boolean);
  if (!first || !path.isAbsolute(first)) throw new Error("A fixed absolute Git executable is required.");
  return realpath(first);
}

async function withAskpass(
  broker: LoopbackEphemeralGitAskpassBrokerV1,
  credentialReferenceId: string,
  repositoryBindingFingerprint: string,
  use: (environment: Readonly<Record<string, string>>) => Promise<void>,
): Promise<void> {
  await broker.withHandle({
    credentialReferenceId,
    repositoryBindingFingerprint,
    use: (handle) =>
      use({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS_REQUIRE: "force",
        GIT_ASKPASS: handle.executablePath,
        GCM_INTERACTIVE: "Never",
        AGENTIC_RESEARCHER_ASKPASS_HANDLE: handle.id,
      }),
  });
}

async function requireGitSuccess(
  runner: SpawnVerifiedGitCommandRunnerV1,
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  },
): Promise<void> {
  const result = await runner.run({
    cwd,
    args,
    environment,
    inheritEnvironment: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Fixed Git operation failed with exit ${result.exitCode}: ${result.stderr.slice(0, 1_000)}`);
  }
}

async function gitText(
  runner: SpawnVerifiedGitCommandRunnerV1,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await runner.run({
    cwd,
    args,
    environment: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
    inheritEnvironment: false,
  });
  if (result.exitCode !== 0) throw new Error(`Git read failed with exit ${result.exitCode}.`);
  const value = result.stdout.trim();
  if (!value) throw new Error("Git read returned an empty value.");
  return value;
}

async function deleteBranchIfPresent(
  client: GitHubRestClient,
  owner: string,
  repository: string,
  branch: string,
  expectedSha: string,
): Promise<void> {
  await ignoreNotFound(() =>
    client.deleteAgentBranch({ owner, repository, branch, expectedSha }),
  );
}

async function ignoreNotFound(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof GitHubApiError && error.code === "github_not_found") return;
    throw error;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value || value.length > 8_192 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${name} is required and must be bounded; no external mutation was attempted.`);
  }
  return value;
}

function requiredSecret(name: string): string {
  const value = process.env[name] ?? "";
  if (value.length < 20 || value.length > 8_192 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${name} is missing or invalid; no external mutation was attempted.`);
  }
  return value;
}
