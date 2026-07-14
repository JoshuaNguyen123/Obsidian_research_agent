import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { verifyPreparedActionFingerprint } from "../../src/agent/actions/canonicalize";
import type { ActionReceipt } from "../../src/agent/actions/types";
import {
  GitHubPublicationWorkflowV1,
  type GitHubPublicationApprovalPortV1,
  type GitHubPublicationCheckV1,
  type GitHubPublicationCheckpointV1,
  type GitHubPublicationHandoffV1,
  type GitHubPublicationProviderPortV1,
  type GitHubPublicationPullRequestV1,
  type GitHubPublicationReviewV1,
  type GitHubPublicationWorkflowOptionsV1,
  type PublishVerifiedCodeRequestV1,
  type TrustedGitHubPublicationBindingV1,
} from "../../src/integrations/github/GitHubPublicationWorkflow";

const execFileAsync = promisify(execFile);
const GIT_SHA = /^[a-f0-9]{40}$/u;
const FIXTURE_PREFIX = "agentic-phase7-github-";

export interface Phase7ApprovalObservation {
  kind: "publish" | "repair_fast_forward" | "ready" | "merge";
  fingerprint: string;
  requiredConfirmations: 1 | 2;
  preparedFingerprintVerified: boolean;
}

export interface Phase7PushObservation {
  beforeRemoteSha: string | null;
  remoteSha: string;
  command: readonly string[];
  fastForwardVerified: boolean;
}

export interface Phase7GitFixture {
  root: string;
  repositoryRoot: string;
  bareRemoteRoot: string;
  branch: string;
  baseSha: string;
  firstCommitSha: string;
  firstTreeSha: string;
  commitRepair(): Promise<{ commitSha: string; treeSha: string; parentSha: string }>;
  pushVerified(commitSha: string): Promise<Phase7PushObservation>;
  remoteBranchSha(): Promise<string | null>;
  cleanup(): Promise<void>;
}

export interface Phase7GitHubHarness {
  fixture: Phase7GitFixture;
  provider: Phase7FakeGitHubProvider;
  workflow: GitHubPublicationWorkflowV1;
  binding: TrustedGitHubPublicationBindingV1;
  approvals: Phase7ApprovalObservation[];
  checkpoints: GitHubPublicationCheckpointV1[];
  pushes: Phase7PushObservation[];
  finalizerReceiptIds: string[];
  request(input: {
    publicationId: string;
    commitSha: string;
    treeSha: string;
    baseSha: string;
    completionProof?: "draft_pr" | "merged_pr";
  }): PublishVerifiedCodeRequestV1;
  driftNextMergeApproval(): void;
}

export async function createPhase7GitHubHarness(
  marker: string,
): Promise<Phase7GitHubHarness> {
  const fixture = await createPhase7GitFixture(marker);
  const approvals: Phase7ApprovalObservation[] = [];
  const checkpoints: GitHubPublicationCheckpointV1[] = [];
  const pushes: Phase7PushObservation[] = [];
  const finalizerReceiptIds: string[] = [];
  const provider = new Phase7FakeGitHubProvider(fixture);
  const binding: TrustedGitHubPublicationBindingV1 = {
    bindingFingerprint: fingerprint(`binding:${marker}`),
    profileKey: "phase7-local-fixture",
    owner: "agentic-fixture",
    repository: "publication-proof",
    baseBranch: "main",
    accountId: "phase7-account",
    accountLogin: "phase7-agent",
    requiredChecks: ["ci"],
    mergeMethod: "squash",
  };
  let driftNextMerge = false;
  let receiptSequence = 0;
  const receipt = (
    operation: ActionReceipt["operation"],
    resourceType: string,
    resourceId: string,
  ): ActionReceipt =>
    actionReceipt(
      `phase7-receipt-${++receiptSequence}`,
      operation,
      resourceType,
      resourceId,
    );

  const approvalPort: GitHubPublicationApprovalPortV1 = {
    async request(input) {
      const verified = await verifyPreparedActionFingerprint(input.preparedAction);
      approvals.push({
        kind: input.kind,
        fingerprint: input.approvalFingerprint,
        requiredConfirmations: input.requiredConfirmations,
        preparedFingerprintVerified: verified,
      });
      if (!verified || input.preparedAction.payloadFingerprint !== input.approvalFingerprint) {
        return {
          approved: false,
          approvalFingerprint: input.approvalFingerprint,
          reason: "Prepared action fingerprint did not verify.",
        };
      }
      if (input.kind === "merge" && driftNextMerge) {
        driftNextMerge = false;
        provider.driftPullRequestAfterApproval();
      }
      return {
        approved: true,
        approvalFingerprint: input.approvalFingerprint,
        approvalId: `phase7-approval-${approvals.length}`,
        confirmations: input.requiredConfirmations,
      };
    },
  };

  const options: GitHubPublicationWorkflowOptionsV1 = {
    push: {
      async publish(input) {
        if (input.approvalFingerprint.length !== "sha256:".length + 64) {
          throw new Error("The local push did not receive an exact approval fingerprint.");
        }
        const pushed = await fixture.pushVerified(input.handoff.commitSha);
        pushes.push(pushed);
        provider.observeVerifiedPush(
          input.handoff.agentBranch,
          pushed.remoteSha,
          input.binding.baseBranch,
        );
        return {
          status: "verified" as const,
          remoteSha: pushed.remoteSha,
          receipt: receipt(
            "publish",
            "repository_branch",
            `${binding.owner}/${binding.repository}:${fixture.branch}`,
          ),
        };
      },
    },
    provider: provider.withReceiptFactory(receipt),
    approvals: approvalPort,
    checkpoints: {
      async persist(checkpoint) {
        checkpoints.push(clone(checkpoint));
      },
    },
    finalizers: {
      async finalizeLinearLink() {
        const receiptId = `phase7-linear-link-${finalizerReceiptIds.length + 1}`;
        finalizerReceiptIds.push(receiptId);
        return { receiptId };
      },
      async finalizeLinearCompletion() {
        const receiptId = `phase7-linear-complete-${finalizerReceiptIds.length + 1}`;
        finalizerReceiptIds.push(receiptId);
        return { receiptId };
      },
      async finalizeObsidian() {
        const receiptId = `phase7-obsidian-${finalizerReceiptIds.length + 1}`;
        finalizerReceiptIds.push(receiptId);
        return { receiptId };
      },
    },
    approvalIdentity: {
      runId: `phase7-run-${safeMarker(marker)}`,
      toolCallId: `phase7-tool-call-${safeMarker(marker)}`,
      toolName: "publish_verified_code_to_github",
    },
    now: monotonicClock(),
  };

  return {
    fixture,
    provider,
    workflow: new GitHubPublicationWorkflowV1(options),
    binding,
    approvals,
    checkpoints,
    pushes,
    finalizerReceiptIds,
    request(input) {
      const handoff: GitHubPublicationHandoffV1 = {
        profileKey: binding.profileKey,
        workspaceId: `phase7-workspace-${safeMarker(marker)}`,
        agentBranch: fixture.branch,
        baseSha: input.baseSha,
        commitSha: input.commitSha,
        treeSha: input.treeSha,
        diffFingerprint: fingerprint(`diff:${input.commitSha}`),
        validationReceiptFingerprints: [
          fingerprint(`targeted:${input.commitSha}`),
          fingerprint(`full:${input.commitSha}`),
        ],
        handoffFingerprint: fingerprint(`handoff:${input.commitSha}`),
      };
      return {
        explicitUserMission: true,
        publicationId: input.publicationId,
        title: `Phase 7 publication ${marker}`,
        body: `Verified local publication for ${marker}.`,
        handoff,
        binding,
        completionProof: input.completionProof ?? "merged_pr",
      };
    },
    driftNextMergeApproval() {
      driftNextMerge = true;
    },
  };
}

export class Phase7FakeGitHubProvider {
  private pullRequest: GitHubPublicationPullRequestV1 | null = null;
  private reviews: GitHubPublicationReviewV1[] = [];
  private pushedHead: { branch: string; sha: string; base: string } | null = null;
  private receiptFactory:
    | ((operation: ActionReceipt["operation"], resourceType: string, resourceId: string) => ActionReceipt)
    | null = null;
  private timestampSequence = 0;

  createCount = 0;
  readbackCount = 0;
  readyCount = 0;
  mergeCount = 0;

  constructor(private readonly fixture: Phase7GitFixture) {}

  withReceiptFactory(
    factory: (
      operation: ActionReceipt["operation"],
      resourceType: string,
      resourceId: string,
    ) => ActionReceipt,
  ): GitHubPublicationProviderPortV1 {
    this.receiptFactory = factory;
    return this;
  }

  observeVerifiedPush(branch: string, sha: string, base: string): void {
    this.pushedHead = { branch, sha, base };
    if (this.pullRequest) {
      this.pullRequest = {
        ...this.pullRequest,
        head: { ref: branch, sha },
        updatedAt: this.nextTimestamp(),
      };
    }
  }

  setReview(
    state: "APPROVED" | "CHANGES_REQUESTED" | null,
    body = "Review evidence only.",
  ): void {
    this.reviews = state
      ? [
          {
            id: this.timestampSequence + 1,
            userLogin: "phase7-reviewer",
            state,
            submittedAt: this.nextTimestamp(),
            body,
          },
        ]
      : [];
  }

  driftPullRequestAfterApproval(): void {
    if (!this.pullRequest) throw new Error("Cannot drift a missing pull request.");
    this.pullRequest = {
      ...this.pullRequest,
      updatedAt: this.nextTimestamp(),
    };
  }

  currentPullRequest(): GitHubPublicationPullRequestV1 | null {
    return this.pullRequest ? clone(this.pullRequest) : null;
  }

  async listPullRequestsForHead(
    _owner: string,
    _repository: string,
    head: string,
    base: string,
  ): Promise<GitHubPublicationPullRequestV1[]> {
    if (
      !this.pullRequest ||
      this.pullRequest.state !== "open" ||
      this.pullRequest.head.ref !== head ||
      this.pullRequest.base.ref !== base
    ) {
      return [];
    }
    return [clone(this.pullRequest)];
  }

  async createDraftPullRequest(input: {
    owner: string;
    repository: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ pullRequest: GitHubPublicationPullRequestV1; receipt: ActionReceipt }> {
    if (!this.pushedHead || this.pushedHead.branch !== input.head || this.pushedHead.base !== input.base) {
      throw new Error("Draft PR creation occurred before exact remote branch readback.");
    }
    this.createCount += 1;
    this.pullRequest = {
      number: 7,
      htmlUrl: `https://github.com/${input.owner}/${input.repository}/pull/7`,
      state: "open",
      draft: true,
      merged: false,
      head: { ref: input.head, sha: this.pushedHead.sha },
      base: { ref: input.base, sha: this.fixture.baseSha },
      updatedAt: this.nextTimestamp(),
    };
    return {
      pullRequest: clone(this.pullRequest),
      receipt: this.receipt("publish", "pull_request", "agentic-fixture/publication-proof#7"),
    };
  }

  async getPullRequest(): Promise<GitHubPublicationPullRequestV1> {
    if (!this.pullRequest) throw new Error("Pull request does not exist.");
    this.readbackCount += 1;
    return clone(this.pullRequest);
  }

  async listCheckRuns(): Promise<GitHubPublicationCheckV1[]> {
    return [{ name: "ci", status: "completed", conclusion: "success" }];
  }

  async getCombinedStatus(): Promise<[]> {
    return [];
  }

  async listPullRequestReviews(): Promise<GitHubPublicationReviewV1[]> {
    return clone(this.reviews);
  }

  async markPullRequestReady(): Promise<{
    pullRequest: GitHubPublicationPullRequestV1;
    receipt: ActionReceipt;
  }> {
    if (!this.pullRequest) throw new Error("Pull request does not exist.");
    this.readyCount += 1;
    this.pullRequest = {
      ...this.pullRequest,
      draft: false,
      updatedAt: this.nextTimestamp(),
    };
    return {
      pullRequest: clone(this.pullRequest),
      receipt: this.receipt("update", "pull_request", "agentic-fixture/publication-proof#7"),
    };
  }

  async mergePullRequest(input: {
    owner: string;
    repository: string;
    number: number;
    sha: string;
    mergeMethod: "squash" | "merge" | "rebase";
  }): Promise<{ merged: boolean; sha: string; receipt: ActionReceipt }> {
    if (!this.pullRequest || input.sha !== this.pullRequest.head.sha) {
      throw new Error("Merge was not pinned to the current verified head SHA.");
    }
    if (input.mergeMethod !== "squash") {
      throw new Error("Fixture repository permits squash merge only.");
    }
    this.mergeCount += 1;
    const mergeSha = createHash("sha1")
      .update(`merge:${input.sha}:${this.mergeCount}`, "utf8")
      .digest("hex");
    this.pullRequest = {
      ...this.pullRequest,
      state: "closed",
      draft: false,
      merged: true,
      updatedAt: this.nextTimestamp(),
    };
    return {
      merged: true,
      sha: mergeSha,
      receipt: this.receipt("merge", "pull_request", "agentic-fixture/publication-proof#7"),
    };
  }

  private receipt(
    operation: ActionReceipt["operation"],
    resourceType: string,
    resourceId: string,
  ): ActionReceipt {
    if (!this.receiptFactory) throw new Error("Receipt factory is not configured.");
    return this.receiptFactory(operation, resourceType, resourceId);
  }

  private nextTimestamp(): string {
    this.timestampSequence += 1;
    return new Date(Date.parse("2026-07-12T12:00:00.000Z") + this.timestampSequence * 1_000)
      .toISOString();
  }
}

async function createPhase7GitFixture(marker: string): Promise<Phase7GitFixture> {
  const root = await mkdtemp(path.join(tmpdir(), FIXTURE_PREFIX));
  const repositoryRoot = path.join(root, "repository");
  const bareRemoteRoot = path.join(root, "remote.git");
  const hooksRoot = path.join(root, "disabled-hooks");
  const branch = `codex/phase7-${safeMarker(marker)}`;
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(hooksRoot, { recursive: true });
  await git(repositoryRoot, hooksRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, hooksRoot, ["config", "user.name", "Phase 7 E2E"]);
  await git(repositoryRoot, hooksRoot, ["config", "user.email", "phase7-e2e@example.invalid"]);
  await writeFile(path.join(repositoryRoot, "value.txt"), `base:${marker}\n`, "utf8");
  await git(repositoryRoot, hooksRoot, ["add", "--", "value.txt"]);
  await git(repositoryRoot, hooksRoot, ["commit", "-m", "phase7 fixture base"]);
  const baseSha = await git(repositoryRoot, hooksRoot, ["rev-parse", "HEAD"]);
  await git(root, hooksRoot, ["init", "--bare", bareRemoteRoot]);
  await git(repositoryRoot, hooksRoot, ["push", bareRemoteRoot, "main:refs/heads/main"]);
  await git(repositoryRoot, hooksRoot, ["switch", "-c", branch]);
  await writeFile(path.join(repositoryRoot, "value.txt"), `published:${marker}:1\n`, "utf8");
  await git(repositoryRoot, hooksRoot, ["add", "--", "value.txt"]);
  await git(repositoryRoot, hooksRoot, ["commit", "-m", "phase7 verified publication"]);
  const firstCommitSha = await git(repositoryRoot, hooksRoot, ["rev-parse", "HEAD"]);
  const firstTreeSha = await git(repositoryRoot, hooksRoot, ["rev-parse", "HEAD^{tree}"]);
  for (const [label, sha] of [
    ["base", baseSha],
    ["first commit", firstCommitSha],
    ["first tree", firstTreeSha],
  ] as const) {
    if (!GIT_SHA.test(sha)) {
      await cleanupPhase7Fixture(root);
      throw new Error(`Phase 7 ${label} did not produce a full Git SHA.`);
    }
  }

  return {
    root,
    repositoryRoot,
    bareRemoteRoot,
    branch,
    baseSha,
    firstCommitSha,
    firstTreeSha,
    async commitRepair() {
      const parentSha = await git(repositoryRoot, hooksRoot, ["rev-parse", "HEAD"]);
      await writeFile(path.join(repositoryRoot, "value.txt"), `published:${marker}:2\n`, "utf8");
      await git(repositoryRoot, hooksRoot, ["add", "--", "value.txt"]);
      await git(repositoryRoot, hooksRoot, ["commit", "-m", "phase7 review repair"]);
      return {
        parentSha,
        commitSha: await git(repositoryRoot, hooksRoot, ["rev-parse", "HEAD"]),
        treeSha: await git(repositoryRoot, hooksRoot, ["rev-parse", "HEAD^{tree}"]),
      };
    },
    async pushVerified(commitSha) {
      const head = await git(repositoryRoot, hooksRoot, ["rev-parse", "HEAD"]);
      const currentBranch = await git(repositoryRoot, hooksRoot, ["branch", "--show-current"]);
      if (head !== commitSha || currentBranch !== branch) {
        throw new Error("Local branch identity drifted before the verified push.");
      }
      const beforeRemoteSha = await readRemoteBranchSha(repositoryRoot, hooksRoot, bareRemoteRoot, branch);
      let fastForwardVerified = beforeRemoteSha === null;
      if (beforeRemoteSha && beforeRemoteSha !== commitSha) {
        fastForwardVerified = await isAncestor(repositoryRoot, hooksRoot, beforeRemoteSha, commitSha);
        if (!fastForwardVerified) throw new Error("Fixture refused a non-fast-forward publication update.");
      }
      const command = [
        "push",
        "--porcelain",
        "--no-verify",
        bareRemoteRoot,
        `${commitSha}:refs/heads/${branch}`,
      ] as const;
      if (command.some((argument) => argument === "--force" || argument === "-f")) {
        throw new Error("Fixture push unexpectedly requested force.");
      }
      await git(repositoryRoot, hooksRoot, [...command]);
      const remoteSha = await readRemoteBranchSha(repositoryRoot, hooksRoot, bareRemoteRoot, branch);
      if (remoteSha !== commitSha) {
        throw new Error("Bare remote readback did not match the expected verified commit.");
      }
      return { beforeRemoteSha, remoteSha, command, fastForwardVerified };
    },
    remoteBranchSha: () => readRemoteBranchSha(repositoryRoot, hooksRoot, bareRemoteRoot, branch),
    cleanup: () => cleanupPhase7Fixture(root),
  };
}

async function readRemoteBranchSha(
  cwd: string,
  hooksRoot: string,
  remote: string,
  branch: string,
): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const output = await git(cwd, hooksRoot, ["ls-remote", "--heads", remote, ref]);
  if (!output) return null;
  const match = /^([a-f0-9]{40})\s+(.+)$/u.exec(output);
  if (!match || match[2] !== ref) throw new Error("Bare remote ref readback was invalid.");
  return match[1];
}

async function isAncestor(
  cwd: string,
  hooksRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(cwd, hooksRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, hooksRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      `core.hooksPath=${hooksRoot}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 1_048_576,
    },
  );
  return stdout.trim();
}

async function cleanupPhase7Fixture(root: string): Promise<void> {
  const verified = await realpath(root).catch(() => null);
  if (!verified) return;
  const temp = await realpath(tmpdir());
  if (path.dirname(verified) !== temp || !path.basename(verified).startsWith(FIXTURE_PREFIX)) {
    throw new Error(`Refusing to remove unowned Phase 7 fixture: ${verified}`);
  }
  await rm(verified, { recursive: true, force: true });
}

function actionReceipt(
  id: string,
  operation: ActionReceipt["operation"],
  resourceType: string,
  resourceId: string,
): ActionReceipt {
  return {
    version: 1,
    id,
    runId: "phase7-run",
    actionId: `action-${id}`,
    toolName: `github_${operation}`,
    operation,
    resource: {
      system: "github",
      resourceType,
      id: resourceId,
    },
    message: `${operation} verified by Phase 7 integration fixture.`,
    payloadFingerprint: fingerprint(`payload:${id}`),
    grantId: "phase7-grant",
    startedAt: "2026-07-12T12:00:00.000Z",
    committedAt: "2026-07-12T12:00:01.000Z",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-12T12:00:01.000Z",
      observedFingerprint: fingerprint(`readback:${id}`),
    },
  };
}

function monotonicClock(): () => Date {
  let sequence = 0;
  return () => new Date(Date.parse("2026-07-12T13:00:00.000Z") + ++sequence * 1_000);
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function safeMarker(marker: string): string {
  const safe = marker.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  return (safe || "fixture").slice(0, 48);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function readPhase7FixtureValue(fixture: Phase7GitFixture): Promise<string> {
  return readFile(path.join(fixture.repositoryRoot, "value.txt"), "utf8");
}
