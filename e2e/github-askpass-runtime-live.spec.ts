import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createVerifiedCodePublicationHandoffV1 } from "../packages/core-api/src/verifiedCodePublicationHandoffV1";
import {
  AGENT_GIT_COMMIT_EMAIL_V1,
  AGENT_GIT_COMMIT_NAME_V1,
} from "../packages/core-api/src/agentGitCommitIdentityV1";
import { detectRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import type { VerifiedLocalCommitReceiptV1 } from "../extensions/code/repair/types";
import { createTrustedGitHubRepositoryBindingV1 } from "../src/integrations/github/TrustedGitHubRepositoryBindingV1";
import { createTrustedGitHubRepositoryBindingV2 } from "../src/integrations/github/TrustedGitHubRepositoryBindingV2";
import {
  DisposableExternalCleanupManifest,
  preflightGhRepositoryDeleteAuthority,
  safeExternalCleanupError,
} from "./fixtures/externalCleanup";
import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./fixtures/nativeObsidianHarness";
import { laneSelectedV1 } from "./fixtures/laneSelection";

const execFileAsync = promisify(execFile);
const LANE = "github-askpass-runtime-live";

/**
 * The one lane that proves the PRODUCTION verified-push composition against a
 * real GitHub remote: plugin.createVerifiedGitPushGateway() wires the real
 * SpawnVerifiedGitCommandRunnerV1, LoopbackEphemeralGitAskpassBrokerV1, and the
 * durable attempt store, and this spec drives gateway.push() itself — not
 * hand-built argv — so verifyLocalIdentity, base preflight, atomic push,
 * remote readback, receipt minting, and idempotent short-circuit all execute
 * for real. The remote readback assertion below uses gh api, independent of
 * the gateway's own readback.
 */
test("production verified git push gateway pushes and reads back a disposable private repository", async () => {
  test.skip(process.platform !== "win32", "Native Obsidian askpass proof requires Windows.");
  test.skip(
    !laneSelectedV1(LANE),
    `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`,
  );
  test.setTimeout(10 * 60_000);

  const token = process.env.E2E_GITHUB_TOKEN?.trim() ?? "";
  if (!/^gh[pousr]_[A-Za-z0-9]{20,500}$/u.test(token)) {
    throw new Error(
      "E2E_GITHUB_TOKEN must be a classic/OAuth GitHub token with repo and delete_repo scopes.",
    );
  }
  await preflightGhRepositoryDeleteAuthority();

  const suffix = randomUUID().replace(/-/gu, "").slice(0, 12);
  const account = JSON.parse(
    (
      await execFileAsync("gh", ["api", "user", "--jq", "{id: .id, login: .login}"], {
        windowsHide: true,
        timeout: 30_000,
      })
    ).stdout.trim(),
  ) as { id: number; login: string };
  const owner = account.login;
  const repository = `e2e-askpass-runtime-${suffix}`;
  const fullName = `${owner}/${repository}`;
  const branch = `codex/askpass-proof-${suffix}`;
  const worktree = await mkdtemp(
    path.join(os.tmpdir(), "agentic-askpass-runtime-live-"),
  );
  const cleanup = new DisposableExternalCleanupManifest();
  let harness: NativeObsidianHarness | null = null;

  cleanup.registerAtCreate(`github:${fullName}`, async () => {
    const exists = await execFileAsync(
      "gh",
      ["repo", "view", fullName, "--json", "nameWithOwner"],
      { windowsHide: true, timeout: 30_000 },
    )
      .then(() => true)
      .catch(() => false);
    if (!exists) return;
    await execFileAsync("gh", ["repo", "delete", fullName, "--yes"], {
      windowsHide: true,
      timeout: 60_000,
    });
    const remains = await execFileAsync(
      "gh",
      ["repo", "view", fullName, "--json", "nameWithOwner"],
      { windowsHide: true, timeout: 30_000 },
    )
      .then(() => true)
      .catch(() => false);
    if (remains) {
      throw new Error(`Disposable GitHub repository still exists: ${fullName}`);
    }
  });

  let primaryError: unknown = null;
  try {
    // Local worktree shaped exactly like a verified code-repair result: a base
    // commit on main and one agent commit on a codex/ branch, both authored by
    // the host-pinned agent identity that verifyLocalIdentity requires.
    await git(worktree, ["init", "-b", "main"]);
    await git(worktree, ["config", "user.name", "Agentic Researcher"]);
    await git(worktree, [
      "config",
      "user.email",
      "agentic-researcher@example.invalid",
    ]);
    await writeFile(
      path.join(worktree, "README.md"),
      `# Secure askpass runtime proof\n\n${suffix}\n`,
      "utf8",
    );
    await git(worktree, ["add", "README.md"]);
    await git(worktree, ["commit", "-m", `Base commit ${suffix}`]);
    const baseSha = (await git(worktree, ["rev-parse", "HEAD"])).trim();
    await git(worktree, ["checkout", "-b", branch]);
    const proofBody = `Verified push gateway proof ${suffix}\n`;
    await writeFile(path.join(worktree, "PROOF.md"), proofBody, "utf8");
    await git(worktree, ["add", "PROOF.md"]);
    await git(worktree, ["commit", "-m", `Verify secure askpass runtime ${suffix}`]);
    const commitSha = (await git(worktree, ["rev-parse", "HEAD"])).trim();
    const treeSha = (await git(worktree, ["rev-parse", "HEAD^{tree}"])).trim();

    await execFileAsync("gh", ["repo", "create", fullName, "--private"], {
      windowsHide: true,
      timeout: 60_000,
    });
    const repositoryReadback = JSON.parse(
      (
        await execFileAsync(
          "gh",
          [
            "api",
            `repos/${fullName}`,
            "--jq",
            "{id: .id, fullName: .full_name, htmlUrl: .html_url, defaultBranch: .default_branch, private: .private, visibility: .visibility, archived: .archived}",
          ],
          { windowsHide: true, timeout: 30_000 },
        )
      ).stdout.trim(),
    ) as {
      id: number;
      fullName: string;
      htmlUrl: string;
      defaultBranch: string;
      private: boolean;
      visibility: "private" | "public" | "internal";
      archived: boolean;
    };
    const repositoryId = repositoryReadback.id;
    expect(Number.isSafeInteger(repositoryId) && repositoryId > 0).toBe(true);
    expect(repositoryReadback.private).toBe(true);
    expect(repositoryReadback.visibility).toBe("private");

    // Production-shaped trust objects with the real SHAs. Validation receipt
    // fingerprints are synthetic (this lane proves the push runtime, not the
    // sandbox pipeline); the parser enforces format, and every git-visible
    // field (branch, SHAs, tree, parent, identity) is real and verified.
    const committedAt = new Date().toISOString();
    const profile = detectRepositoryProfileV2({
      key: `askpass-proof-${suffix}`,
      displayName: "Askpass runtime proof",
      repositoryRoot: worktree,
      defaultBranch: "main",
      files: ["README.md", "PROOF.md"],
    });
    const binding = createTrustedGitHubRepositoryBindingV1({
      key: `github-askpass-proof-${suffix}`,
      profile,
      owner,
      repository,
      repositoryId,
      verifiedAccountId: account.id,
      verifiedAccountLogin: account.login,
      trustedAt: committedAt,
    });
    const proofSha256 = `sha256:${createHash("sha256").update(proofBody, "utf8").digest("hex")}`;
    const localCommitEvidence = {
      requestId: `askpass-proof-${suffix}`,
      runId: `run-${suffix}`,
      worktreeId: `worktree-${suffix}`,
      workspaceId: `workspace-${suffix}`,
      branch,
      baseSha,
      commitSha,
      parentSha: baseSha,
      treeSha,
      diffFingerprint: proofSha256,
      changedPaths: ["PROOF.md"],
      artifactHashes: [
        { path: "PROOF.md", sha256: proofSha256, bytes: Buffer.byteLength(proofBody) },
      ],
      changedArtifacts: [{ path: "PROOF.md", sha256: proofSha256 }],
      identity: {
        authorName: AGENT_GIT_COMMIT_NAME_V1,
        authorEmail: AGENT_GIT_COMMIT_EMAIL_V1,
        committerName: AGENT_GIT_COMMIT_NAME_V1,
        committerEmail: AGENT_GIT_COMMIT_EMAIL_V1,
      },
      targetedValidationReceiptId: `targeted-${suffix}`,
      fullValidationReceiptId: `full-${suffix}`,
      targetedValidationFingerprint: proofSha256,
      fullValidationFingerprint: proofSha256,
      committedAt,
    };
    const localCommit: VerifiedLocalCommitReceiptV1 = {
      version: 1,
      kind: "verified_local_commit",
      id: `verified-commit-${suffix}`,
      status: "verified",
      ...localCommitEvidence,
      fingerprint: canonicalSha256(localCommitEvidence),
    };
    const handoff = createVerifiedCodePublicationHandoffV1({
      id: `handoff-${suffix}`,
      repositoryProfileKey: profile.key,
      repositoryProfileFingerprint: binding.repositoryProfileFingerprint,
      canonicalWorktreeRoot: worktree,
      baseBranch: profile.defaultBranch,
      localCommit,
      preparedAt: new Date(Date.parse(committedAt) + 1_000).toISOString(),
    });

    harness = await startNativeObsidianHarness({
      label: `askpass-runtime-${suffix}`,
      corePluginDataOverrides: {
        e2eHarnessAttestationEnabled: true,
        githubEnabled: true,
      },
      setup: async () => undefined,
    });
    const installed = await harness.page.evaluate(
      async ({ pluginId, accessToken }) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        return plugin?.setGitHubHarnessAccessToken?.(accessToken);
      },
      { pluginId: NATIVE_CORE_PLUGIN_ID, accessToken: token },
    );
    expect(installed?.ok, installed?.message ?? "GitHub credential install failed.").toBe(
      true,
    );

    // Refresh the exact visibility evidence immediately before gateway.push;
    // the V2 attestation binds this observation time and provider readback.
    const freshRepositoryReadback = JSON.parse(
      (
        await execFileAsync(
          "gh",
          [
            "api",
            `repos/${fullName}`,
            "--jq",
            "{id: .id, fullName: .full_name, htmlUrl: .html_url, defaultBranch: .default_branch, private: .private, visibility: .visibility, archived: .archived}",
          ],
          { windowsHide: true, timeout: 30_000 },
        )
      ).stdout.trim(),
    ) as typeof repositoryReadback;
    const repositoryObservedAt = new Date().toISOString();
    expect(freshRepositoryReadback.id).toBe(repositoryId);
    expect(freshRepositoryReadback.private).toBe(true);
    expect(freshRepositoryReadback.visibility).toBe("private");
    const privateRepositoryBinding = createTrustedGitHubRepositoryBindingV2({
      key: binding.key,
      profile,
      owner,
      repository,
      repositoryReadback: freshRepositoryReadback,
      expectedVisibility: "private",
      observedAt: repositoryObservedAt,
      verifiedAccountId: account.id,
      verifiedAccountLogin: account.login,
      trustedAt: committedAt,
    });

    // Drive the PRODUCTION gateway end to end, twice: the first call must
    // dispatch, readback-verify, and mint a receipt; the second identical call
    // must short-circuit on the durable attempt record without redispatching.
    const observed = await harness.page.evaluate(
      async ({ pluginId, handoff, binding, privateRepositoryBinding, profile }) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        if (!plugin?.createVerifiedGitPushGateway || !plugin.githubCredential) {
          throw new Error("Verified Git push production composition is unavailable.");
        }
        const gateway = await plugin.createVerifiedGitPushGateway();
        const input = {
          handoff,
          binding,
          privateRepositoryBinding,
          expectedVisibility: "private",
          profile,
          credentialReferenceId: plugin.githubCredential.tokenReferenceId,
        };
        const first = await gateway.push(input);
        const second = await gateway.push(input);
        return { first, second };
      },
      {
        pluginId: NATIVE_CORE_PLUGIN_ID,
        handoff: JSON.parse(JSON.stringify(handoff)),
        binding: JSON.parse(JSON.stringify(binding)),
        privateRepositoryBinding: JSON.parse(
          JSON.stringify(privateRepositoryBinding),
        ),
        profile: JSON.parse(JSON.stringify(profile)),
      },
    );

    expect(
      observed.first.status,
      JSON.stringify(observed.first),
    ).toBe("pushed_verified");
    if (observed.first.status !== "pushed_verified") throw new Error("unreachable");
    expect(observed.first.receipt.kind).toBe("verified_git_push");
    expect(observed.first.receipt.commitKind).toBe("committed");
    expect(observed.first.receipt.remoteSha).toBe(commitSha);
    expect(observed.first.receipt.branch).toBe(branch);

    // Idempotency: the durable attempt record short-circuits the second push
    // with the SAME receipt. A redispatch would have minted a fresh
    // "already_present" receipt with a different id.
    expect(observed.second.status).toBe("pushed_verified");
    if (observed.second.status !== "pushed_verified") throw new Error("unreachable");
    expect(observed.second.receipt.id).toBe(observed.first.receipt.id);

    // Independent remote readback via gh api — not the gateway's own ls-remote.
    const remoteBranchSha = (
      await execFileAsync(
        "gh",
        ["api", `repos/${fullName}/git/ref/heads/${branch}`, "--jq", ".object.sha"],
        { windowsHide: true, timeout: 30_000 },
      )
    ).stdout.trim();
    const remoteMainSha = (
      await execFileAsync(
        "gh",
        ["api", `repos/${fullName}/git/ref/heads/main`, "--jq", ".object.sha"],
        { windowsHide: true, timeout: 30_000 },
      )
    ).stdout.trim();
    expect(remoteBranchSha).toBe(commitSha);
    expect(remoteMainSha).toBe(baseSha);
    console.log(
      `ASKPASS-RUNTIME verified repo=${fullName} branch=${branch} commit=${commitSha} receipt=${observed.first.receipt.id}`,
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await harness?.close().catch(() => undefined);
    const failures = await cleanup.cleanupAll();
    await rm(worktree, { recursive: true, force: true });
    if (failures.length > 0) {
      const cleanupError = new Error(
        `Askpass live cleanup failed: ${failures.join("; ")}`,
      );
      if (!primaryError) throw cleanupError;
      console.error(safeExternalCleanupError(cleanupError));
    }
  }
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    timeout: 60_000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout;
}

/** Mirrors the canonical-JSON sha256 used for receipt fingerprints. */
function canonicalSha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}
