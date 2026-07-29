import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import {
  createRepositoryProfile,
  createRepositoryProfileRegistry,
} from "../src/agent/repositories/RepositoryProfile";
import {
  GitHubApiError,
  GitHubRestClient,
} from "../src/integrations/github/GitHubRestClient";
import type { HttpTransport } from "../src/model/types";
import {
  deleteDisposableGitHubRepositoryAndVerify,
  DisposableExternalCleanupManifest,
  preflightDisposableRepositoryDeleteAuthority,
  proveRestCreateAndDeleteProbe,
  orderGitHubHarnessTokensForPush,
  safeExternalCleanupError,
} from "./fixtures/externalCleanup";
import { ensureDurableLinearQueueProject } from "./fixtures/linearQueueProvisioning";
import { PHASE4_CODE_PLUGIN_ID } from "./fixtures/phase4Harness";
import { createFlowRealTypeScriptFixture } from "./fixtures/phase4GitRepo";
import { NATIVE_CORE_PLUGIN_ID } from "./fixtures/nativeObsidianHarness";
import {
  assertProductionAdoptedSandboxV1,
  hostProvisionedSandboxRuntimeDigestV1,
  startRealAiHarness,
  type RealAiHarness,
} from "./fixtures/realAiHarness";
import { laneSelectedV1 } from "./fixtures/laneSelection";

const LANE = "compound-flow-real-live";
const PROFILE_KEY = "compound-flow-real-ts";
const VALIDATION_PROFILE_KEY = "compound-flow-real-ts-validation";

/**
 * Agentic compound proof: live Chat set-loose Soft+Bound for Research →
 * Linear publication → Code → GitHub → note reflection → Linear completion in
 * ONE continuous mission (no mid-run Bound approvals). No host
 * prepare/execute and no Node GitHub create as the pass path. Activation is
 * prompt + Run Mission only (no starter chip).
 *
 * Research uses the deterministic test-owned web backend by default; set
 * COMPOUND_REAL_LIVE_WEB=1 to hit the live internet instead. Stage 6 (mark
 * the Linear issue complete with a durable summary) is host finalization
 * inside publish_verified_code_to_github; this spec deep-reads the provider
 * to prove the issue reached its configured completed state with the
 * lineage summary comment before cleanup trashes it.
 */
test("COMPOUND-REAL Obsidian agent Linear Code GitHub note reflection", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(
    !laneSelectedV1(LANE),
    `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`,
  );
  test.skip(
    process.env.E2E_AI_MODE !== "real" || process.env.E2E_REAL_AI !== "1",
    "Requires E2E_REAL_AI=1 and E2E_AI_MODE=real.",
  );
  test.setTimeout(60 * 60_000);

  const envGithubToken = process.env.E2E_GITHUB_TOKEN?.trim() ?? "";
  if (
    envGithubToken &&
    !/^github_pat_[A-Za-z0-9_-]{20,500}$/u.test(envGithubToken) &&
    !/^gh[pousr]_[A-Za-z0-9]{20,500}$/u.test(envGithubToken)
  ) {
    throw new Error(
      "E2E_GITHUB_TOKEN must be a github_pat_ fine-grained token or gh[pousr]_ classic/OAuth token with repo create+delete, or unset to use the vault lease / gh harness fallback.",
    );
  }
  const suffix = randomUUID().replace(/-/gu, "").slice(0, 12);
  // Avoid the substring "COMPOUND" / "write … Linear issue" phrasing that can
  // inflate MissionGraph into a multi-stage code ladder on a Linear-only phase.
  const marker = `FLOW_REAL_${suffix}`;
  const notePath = `E2E Agent Tests/FLOW-REAL-${suffix}.md`;
  const repository = safeDisposableRepositoryName(`e2e-flow-real-${suffix}`);
  const workspaceId = `flow-real-${suffix}`;
  const relativeCodePath = "src/flow_real.ts";
  // No hard-coded fallback. A literal team id here meant the lane appeared to
  // work without the variable set, and would silently mutate whatever
  // workspace that id belonged to after a credential change. Membership in the
  // connected workspace is asserted against the live snapshot below.
  const teamId = requiredEnvironment("LINEAR_LIVE_TEST_TEAM_ID");
  const sandboxReadinessStartedAt = Date.now();
  const fixture = await createFlowRealTypeScriptFixture(marker);
  const requestId = `flow-real-request-${suffix}`;

  let harness: RealAiHarness | null = null;
  let repositoryCreated = false;
  let githubLogin: string | null = null;
  let issueUrl: string | null = null;
  let githubHtmlUrl: string | null = null;
  let githubClient: GitHubRestClient | null = null;
  let primaryError: unknown = null;
  let issueId: string | null = null;
  let workspaceRoot: string | null = null;
  let workspaceBranch: string | null = null;
  const cleanupManifest = new DisposableExternalCleanupManifest();

  try {
    // Resolve GitHub identity first when an env PAT is present so the profile
    // can bind the disposable repo name; otherwise bind after vault lease.
    if (envGithubToken) {
      githubClient = new GitHubRestClient({
        transport: fetchTransport,
        token: envGithubToken,
        timeoutMs: 60_000,
      });
      githubLogin = (await githubClient.getAuthenticatedUser()).login;
    }

    const profile = createRepositoryProfile({
      key: PROFILE_KEY,
      displayName: "Compound flow real TypeScript project",
      repositoryRoot: fixture.root,
      defaultBranch: "main",
      // Root scope so sandbox prep covers any trusted workspace change under
      // the worktree; protectedPaths still fence package.json/scripts.
      allowedPathPrefixes: ["src"],
      validationProfile: {
        id: VALIDATION_PROFILE_KEY,
        bootstrapCommands: [],
        validationCommands: [
          {
            command: "python3",
            args: ["scripts/verify_project.py"],
            label: "Flow-real marker contract verification",
          },
        ],
        protectedPaths: ["scripts", "package.json"],
        allowedGeneratedPaths: [],
      },
      runtimeDigests: { python: hostProvisionedSandboxRuntimeDigestV1() },
      promotionPolicy: {
        localBasePromotion: "disabled",
        completionProof: "draft_pr",
        githubRepository: githubLogin
          ? `${githubLogin}/${repository}`
          : `pending/${repository}`,
        requiredChecks: [],
      },
    });

    harness = await startRealAiHarness(
      `flow-real-${suffix}`,
      {
        missionTimeoutMs: 50 * 60_000,
        completionTimeoutMs: 50 * 60_000,
      },
      {
        maxAgentSteps: 128,
        maxRunMinutes: 60,
        // Keep provider HTTP timeout well below the 45m mission wait so a
        // stalled model call fails closed instead of hanging the harness.
        requestTimeoutMs: 10 * 60_000,
        completionDrivenLoops: true,
        autoContinueLongRuns: true,
        workingMode: "automatic",
        autonomyProfile: "automatic",
        thinkingMode: "medium",
        orchestratorEnabled: false,
        githubEnabled: true,
        linearEnabled: true,
        linearDefaultTeamId: teamId,
        numCtx: 100_000,
        semanticSearchEnabled: true,
        repositoryProfileRegistry: createRepositoryProfileRegistry([profile]),
      },
      {
        preserveConfiguredLinearCredential: true,
        preserveConfiguredGitHubCredential: true,
      },
    );

    await ensureGitHubConnected(harness.page, envGithubToken || null);
    const vaultGithub = await readGitHubIdentity(harness.page);
    githubLogin = vaultGithub.login;
    if (!githubClient && vaultGithub.token) {
      githubClient = new GitHubRestClient({
        transport: fetchTransport,
        token: vaultGithub.token,
        timeoutMs: 60_000,
      });
    }
    if (!githubClient || !githubLogin) {
      throw new Error(
        "GitHub must be ready via E2E_GITHUB_TOKEN (github_pat_…) or a vault fine-grained PAT with Administration:write.",
      );
    }
    // Agent-driven github_create_private_repository uses the vault lease, not
    // gh CLI. Fail closed unless that lease can create+delete; when the vault
    // fine-grained PAT lacks Administration:write, install the local gh OAuth
    // token through the harness-only credential API (test vault only).
    githubClient = await ensureGitHubCreateCapableCredential({
      page: harness.page,
      client: githubClient,
      owner: githubLogin,
      preferredToken: envGithubToken || null,
    });
    // Profile may have been seeded as pending/<repo> when only the vault lease
    // supplies login. Bind the exact owner/repo before the mission so
    // github_create_private_repository does not mutate under owner "pending".
    profile.promotionPolicy.githubRepository = `${githubLogin}/${repository}`;
    await bindGitHubRepositoryDestination(
      harness.page,
      PROFILE_KEY,
      `${githubLogin}/${repository}`,
    );
    // Prove delete by clearing known residue via REST (vault/E2E PAT) and/or
    // gh delete_repo before any disposable repository can be created.
    const deleteAuthority = await preflightDisposableRepositoryDeleteAuthority({
      client: githubClient,
      owner: githubLogin,
    });
    const residue = deleteAuthority.residue ?? [];
    console.log(
      [
        `FLOW-REAL delete authority via=${deleteAuthority.via}`,
        residue.length
          ? `residue=${residue.map((item) => `${item.repository}=${item.status}`).join(" ")}`
          : "residue=n/a",
      ].join(" "),
    );
    // Register-at-create: every exact, suffix-bound resource is on the manifest
    // before the mission starts so mid-run provider creates still vanish.
    cleanupManifest.registerAtCreate("Linear cleanup", async () => {
      // Published titles are model-chosen but marker-constrained, so fall
      // back from the exact legacy title to a bare-marker search before
      // giving up. Trashing the issue disposes its comments too.
      const discovered = issueId
        ? { id: issueId }
        : (await findLinearIssueByTitle(harness!.page, `Flow real ${marker}`, teamId)) ??
          (await findLinearIssueByTitle(harness!.page, marker, teamId));
      if (!discovered?.id) return;
      await cleanupLinearIssue(harness!.page, discovered.id);
      issueId = null;
    });
    cleanupManifest.registerAtCreate("Workspace cleanup", async () => {
      const binding = await resolveWorkspaceCleanupBinding(harness!.page, workspaceId);
      workspaceRoot = binding?.workspaceRoot ?? workspaceRoot;
      workspaceBranch = binding?.workspaceBranch ?? workspaceBranch;
      if (!workspaceRoot && !workspaceBranch) return;
      if (!workspaceRoot || !workspaceBranch) throw new Error("owned workspace binding was incomplete.");
      await fixture.removeOwnedWorktree(workspaceRoot, workspaceBranch);
      workspaceRoot = null;
      workspaceBranch = null;
    });
    cleanupManifest.registerAtCreate("GitHub cleanup", async () => {
      await deleteDisposableGitHubRepositoryAndVerify({
        client: githubClient!, owner: githubLogin!, repository,
      });
      repositoryCreated = false;
    });
    await prepareAgentChatSurface(harness.page, teamId);
    // Research sources: deterministic owned backend unless the operator opts
    // into the live internet with COMPOUND_REAL_LIVE_WEB=1. The real model
    // still performs real research reasoning either way.
    const liveWeb = process.env.COMPOUND_REAL_LIVE_WEB === "1";
    if (!liveWeb) {
      await harness.installOwnedWebBackend({ sourceCount: 2, topic: "generic" });
    }
    await expectTrustedRepositoryProfile(harness.page, PROFILE_KEY, fixture.root);
    await harness.seedNote(
      notePath,
      [
        `# Flow real ${marker}`,
        "",
        "Tracking note for an agentic Obsidian → Linear → Code → GitHub → reflection run.",
        "",
      ].join("\n"),
      true,
    );

    // No injected provider configuration: the plugin must adopt the
    // host-provisioned binding and pass its own boundary probe.
    const adoptedSandbox = await assertProductionAdoptedSandboxV1(
      harness.page,
      sandboxReadinessStartedAt,
    );
    expect(adoptedSandbox.selectedProvider).toBe("wsl2");

    // The env var names a team; this proves the connected workspace actually
    // contains it. Without this the lane would happily mutate a stranger's
    // workspace if the credential were swapped.
    const connectedTeamIds = await harness.page.evaluate((pluginId) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const teams = plugin?.linearCapabilitySnapshot?.teams ?? [];
      return Array.isArray(teams)
        ? teams.map((team: any) => String(team?.id ?? ""))
        : [];
    }, NATIVE_CORE_PLUGIN_ID);
    expect(
      connectedTeamIds,
      `LINEAR_LIVE_TEST_TEAM_ID ${teamId} is not a team in the connected Linear workspace (${connectedTeamIds.join(", ") || "none discovered"}).`,
    ).toContain(teamId);

    // Continuous set-loose compound mission (one Run Mission; no Bound approvals).
    // Prompt must hit full-pipeline / compound lifecycle detection: "full pipeline"
    // plus Linear + repository/workspace + GitHub + reflection (Flow real).
    await focusNote(harness.page, notePath);
    const compoundMission = [
      `Run the full pipeline for Flow real ${marker}: web research, Linear issue, repository workspace, private GitHub, and note reflection.`,
      // Stage 1 — research first. Owned backend serves two deterministic
      // sources unless COMPOUND_REAL_LIVE_WEB=1; "before accepting findings"
      // keeps the proof-gated acceptance path that publish_research_to_linear
      // requires.
      `First research the Flow real ${marker} topic using exactly two public web sources and fetch both sources before accepting findings. Write the accepted findings into the current note ${notePath} using the canonical headings ## Problem and impact, ## Evidence and source links, and ## Proposed work, citing both fetched source URLs and passages.`,
      // Stage 2 — research → Linear. publish_research_to_linear creates the
      // lineage that finalizeLinearLink/finalizeLinearCompletion resolve; a
      // bare linear_create_issue would leave the publication parked at
      // waiting_linear_link forever.
      `Publish the accepted research note to Linear in the configured destination. The package is code work for repository key ${PROFILE_KEY} and validation requirement ${VALIDATION_PROFILE_KEY}. After publishing, call linear_get_issue for the returned issue and read back its title and URL before opening the code workspace.`,
      // Foreground repair scope pair required for durable validate/commit.
      `Create repository workspace ${workspaceId} and use one repair request id ${requestId} for every validation and commit call.`,
      `Use the trusted local repository profile key ${PROFILE_KEY}: call code_sandbox_status, then code_workspace_create (kind repository, repositoryProfileKey ${PROFILE_KEY}, workspaceId ${workspaceId}).`,
      // Fixture seeds src/flow_real.ts with PLACEHOLDER_REPLACE_ME. Agent must
      // hash-bound rewrite the exact marker, then run the validate/commit ladder.
      `Read the exact existing workspace file ${relativeCodePath} via code_workspace_read path ${relativeCodePath}, then code_workspace_write_expected path ${relativeCodePath} with the exact one-line content export const marker = "${marker}"; (double quotes only).`,
      `Then call code_validate_fast, code_repair_record_cycle, code_validate_targeted, code_validate_full, and code_commit_verified with that same requestId ${requestId}.`,
      `Do not rewrite package.json or scripts.`,
      // Prose + tool token: snake_case alone does not match \bcreate\b intent regexes.
      `Create the exact private GitHub repository ${githubLogin}/${repository} (github_create_private_repository).`,
      `After the verified commit exists, call publish_verified_code_to_github with action publish_draft for trusted profile ${PROFILE_KEY} so a draft pull request URL exists (create-only is not enough).`,
      // Prose keeps hasAppendIntent; tool token is also recognized.
      `Append a Flow real reflection to the current note via append_to_current_file containing marker ${marker}, the Linear issue URL, the private GitHub repo URL, the draft PR URL, and workspace ${workspaceId}.`,
      // Avoid "Do not stop … before Linear/code/GitHub" — that used to false-negate stages.
      // Never mention completing/closing the Linear issue: completion is host
      // finalization inside publish, and completion vocabulary flips stage
      // detection into reconciliation_cleanup which may pause for approval.
      `Decide tool order yourself from the set-loose allowed tools. Do not ask for approval. Do not trash or delete. Do not merge. Stay in the tool loop until research, the published Linear issue, verified commit, draft PR, and reflection proofs exist.`,
    ].join(" ");
    await harness.submitMission(compoundMission, {
      waitForCompletion: false,
      timeoutMs: 50 * 60_000,
    });
    await harness.waitUntilIdleOrComplete(50 * 60_000);

    // Harness already fails mid-run on Bound Approve; re-check at Idle.
    const boundApproveStillVisible = await harness.page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          "button[data-testid='chat-approval-approve']:not(:disabled), button.agentic-researcher-approval-approve:not(:disabled)",
        ),
      ).some((button) => button.getClientRects().length > 0),
    );
    expect(
      boundApproveStillVisible,
      "set-loose COMPOUND-REAL must not leave a Bound Approve control after Idle",
    ).toBe(false);

    const finalNote = await readNote(harness.page, notePath);

    // Stage 1 — research evidence must live in the initiating note.
    expect(finalNote, "research problem heading missing").toMatch(/##\s*Problem and impact/iu);
    expect(finalNote, "research evidence heading missing").toMatch(/##\s*Evidence and source links/iu);
    expect(finalNote, "research work heading missing").toMatch(
      /##\s*Proposed work/iu,
    );
    if (!liveWeb) {
      expect(
        finalNote,
        "owned primary source URL must be cited in the note",
      ).toContain("primary.owned.example");
      expect(
        finalNote,
        "owned alternate source URL must be cited in the note",
      ).toContain("alternate-owned.example");
      const ownedWebMetrics = await harness.readOwnedWebMetrics();
      expect(
        ownedWebMetrics.fetchTransportCalls,
        "research must fetch both owned sources through the real research loop",
      ).toBeGreaterThanOrEqual(2);
    }
    const citedUrls = new Set(finalNote.match(/https?:\/\/[^\s)\]>"']+/giu) ?? []);
    expect(
      citedUrls.size,
      "research note must cite at least two distinct source URLs",
    ).toBeGreaterThanOrEqual(2);

    // Stage 2 — the Linear issue must be derived from the accepted research
    // via publish_research_to_linear (checkpoint), not a bare create.
    const researchPublication = await readCompleteResearchPublication(
      harness.page,
      notePath,
    );
    expect(
      researchPublication,
      "accepted research publication checkpoint must be complete for the note",
    ).not.toBeNull();
    expect(
      researchPublication!.issueId,
      "research publication checkpoint must carry its Linear issue id",
    ).toBeTruthy();
    expect(
      researchPublication!.backlinkVerified,
      "research publication backlink must be verified",
    ).toBe(true);
    issueId = researchPublication!.issueId;

    issueUrl = extractLinearUrl(finalNote);
    if (!issueUrl) {
      const title = `Flow real ${marker}`;
      const recovered =
        (await findLinearIssueByTitle(harness.page, title, teamId)) ??
        (await findLinearIssueByTitle(harness.page, marker, teamId));
      issueId = recovered?.id ?? issueId;
      issueUrl = recovered?.url ?? null;
      if (issueUrl) {
        console.log(
          `FLOW-REAL Linear URL recovered via title search title=${JSON.stringify(title)} url=${issueUrl}`,
        );
      }
    }
    if (!issueUrl) {
      const idleDiagnostics = await harness.page.evaluate(({ pluginId }) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        const snapshot = plugin?.getMissionRunSnapshot?.();
        const ledger = snapshot?.lastMissionLedger;
        return {
          stopReason: snapshot?.lastComplete?.stopReason ?? null,
          autoContinueRecommended:
            snapshot?.lastComplete?.autoContinueRecommended ?? null,
          ledgerStatus: ledger?.status ?? null,
          acceptanceStatus: ledger?.acceptance?.status ?? null,
          canResume: ledger?.canResume === true,
          nextAction: String(ledger?.nextAction ?? "").slice(0, 300),
          receiptCount: ledger?.receiptCount ?? null,
          notePreview: "",
        };
      }, { pluginId: NATIVE_CORE_PLUGIN_ID });
      console.error(
        "FLOW-REAL missing Linear URL diagnostics:",
        JSON.stringify({ ...idleDiagnostics, notePreview: finalNote.slice(0, 500) }),
      );
    }
    expect(
      issueUrl,
      "continuous agent must leave a Linear issue URL (note or title recovery)",
    ).toMatch(/^https:\/\/linear\.app\//iu);
    expect(finalNote).toContain(marker);

    const remote = await githubClient!.getRepository(githubLogin!, repository);
    expect(remote.private, "agent must create a private GitHub repository").toBe(
      true,
    );
    githubHtmlUrl = remote.htmlUrl;
    repositoryCreated = true;
    expect(
      finalNote,
      "reflection note must include the private GitHub repository URL",
    ).toContain(githubHtmlUrl!);
    expect(
      finalNote,
      "reflection section heading must be present",
    ).toMatch(/##\s*Flow real(?:\s+reflection)?/i);

    const codeProbe = await softProbeCodeDepth(
      harness.page,
      workspaceId,
      relativeCodePath,
      marker,
      PROFILE_KEY,
    );
    expect(
      codeProbe.depth,
      `continuous set-loose must reach verified commit; detail=${codeProbe.detail ?? ""}`,
    ).toBe("committed");

    const draftPrMatch = finalNote.match(
      /https:\/\/github\.com\/[^\s)\]"']+\/pull\/\d+/iu,
    );
    expect(
      draftPrMatch?.[0],
      "reflection note must include a draft PR URL (not create-only)",
    ).toMatch(/\/pull\/\d+/iu);

    if (process.env.COMPOUND_REAL_MERGE === "1") {
      expect(
        finalNote,
        "COMPOUND_REAL_MERGE=1 expects merge evidence in the note",
      ).toMatch(/\bmerged\b|\bmerge commit\b|\/commits\//i);
    }

    // Stage 6 — deep readback. Host finalization inside
    // publish_verified_code_to_github must have (a) commented the durable
    // summary on the research-derived issue and (b) moved it to the
    // configured completed workflow state. Prove both against the provider
    // BEFORE cleanup trashes the issue.
    const publication = await pollForFinalizedGithubPublication(
      harness.page,
      repository,
      3 * 60_000,
    );
    expect(publication.pullRequestHtmlUrl).toContain(`/${repository}/pull/`);
    expect(publication.pullRequestNumber).toBeGreaterThanOrEqual(1);
    const completionReceipt = await readExternalActionReceipt(
      harness.page,
      publication.linearCompletionReceiptId,
    );
    expect(completionReceipt.toolName).toBe("linear_update_issue");
    expect(
      completionReceipt.readbackStatus,
      "issue completion must have verified provider readback",
    ).toBe("verified");
    const completedIssueId = completionReceipt.resourceId;
    expect(completedIssueId).toBeTruthy();
    expect(
      completedIssueId,
      "completion must target the research-derived Linear issue",
    ).toBe(issueId);
    const linkReceipt = await readExternalActionReceipt(
      harness.page,
      publication.linearLinkReceiptId,
    );
    expect(linkReceipt.toolName).toBe("linear_create_comment");
    expect(linkReceipt.resourceId).toBeTruthy();
    const completionProof = await readLinearIssueCompletionProof(
      harness.page,
      completedIssueId,
    );
    expect(
      completionProof.configuredCompletedStateId,
      "linearCompletedStateId must be configured",
    ).toBeTruthy();
    expect(
      completionProof.stateType,
      "provider readback must show the issue in a completed workflow state",
    ).toBe("completed");
    expect(completionProof.stateId).toBe(completionProof.configuredCompletedStateId);
    expect(completionProof.completedAt).toBeTruthy();
    expect(completionProof.trashed).toBe(false);
    // Read the exact durable comment identity from its receipt. This is a
    // stronger independent provider check than a paginated/filterable list:
    // it proves that the finalizer's own comment exists, is attached to this
    // exact completed issue, and still contains the published PR lineage.
    const summaryComment = await readLinearCommentProof(
      harness.page,
      linkReceipt.resourceId,
    );
    expect(summaryComment.id).toBe(linkReceipt.resourceId);
    expect(
      summaryComment.issueId,
      "durable summary comment from finalizeLinearLink must belong to the completed issue",
    ).toBe(completedIssueId);
    expect(summaryComment.archivedAt).toBe("");
    expect(summaryComment.body).toMatch(/pull request #\d+/iu);
    expect(summaryComment.body).toContain(publication.pullRequestHtmlUrl);
    expect(summaryComment.body).toContain(
      `Publication lineage: \`${publication.publicationId}\``,
    );

    console.log(
      [
        "FLOW-REAL success",
        `linear=${issueUrl}`,
        `github=${githubHtmlUrl}`,
        `note=${notePath}`,
        `workspace=${workspaceId}`,
        `codeDepth=${codeProbe.depth}`,
        `draftPr=${draftPrMatch?.[0] ?? ""}`,
        codeProbe.detail ? `codeDetail=${codeProbe.detail}` : "",
        `stage6=finalized`,
        `linearCompleted=${completedIssueId}`,
        `summaryComment=${linkReceipt.resourceId}`,
        "mode=continuous-set-loose",
        `researchVia=${liveWeb ? "agent-live-web" : "agent-owned-web"}`,
        "linearVia=agent",
        "codeVia=agent",
        "githubVia=agent",
        "reflectionVia=agent",
        "completionVia=host-finalization",
      ]
        .filter(Boolean)
        .join(" "),
    );
    test.info().annotations.push({
      type: "compound-flow-real",
      description: [
        `linear=${issueUrl}`,
        `github=${githubHtmlUrl}`,
        `note=${notePath}`,
        `marker=${marker}`,
        `codeDepth=${codeProbe.depth}`,
        `stage6=finalized`,
        `linearCompleted=${completedIssueId}`,
        "mode=continuous-set-loose",
        `researchVia=${liveWeb ? "agent-live-web" : "agent-owned-web"}`,
        "linearVia=agent",
        "codeVia=agent",
        "githubVia=agent",
        "reflectionVia=agent",
        "completionVia=host-finalization",
      ].join(" "),
    });

  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = await cleanupManifest.cleanupAll();
    await harness?.close().catch((error) => cleanupErrors.push(`Harness cleanup: ${safeExternalCleanupError(error)}`));
    await fixture.cleanup().catch((error) => cleanupErrors.push(`Fixture cleanup: ${safeExternalCleanupError(error)}`));
    if (cleanupErrors.length > 0) {
      throw new Error([
        primaryError ? `COMPOUND-REAL failed: ${safeExternalCleanupError(primaryError)}` : "COMPOUND-REAL assertions passed",
        `mandatory cleanup failed: ${cleanupErrors.join("; ")}`,
      ].join("; "));
    }
  }
  if (primaryError) throw primaryError;
});

async function readNote(page: Page, notePath: string): Promise<string> {
  return page.evaluate(async ({ notePath }) => {
    const app = (window as typeof window & { app?: any }).app;
    const file = app.vault.getAbstractFileByPath(notePath);
    if (!file) throw new Error(`Tracking note missing: ${notePath}`);
    return app.vault.read(file);
  }, { notePath });
}

async function focusNote(page: Page, notePath: string): Promise<void> {
  await page.evaluate(async ({ pluginId, notePath }) => {
    const app = (window as typeof window & { app?: any }).app;
    const plugin = app?.plugins?.plugins?.[pluginId];
    const file = app.vault.getAbstractFileByPath(notePath);
    if (!file) throw new Error(`Tracking note missing for focus: ${notePath}`);
    const leaf =
      app.workspace.getLeavesOfType("markdown")[0] ?? app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await plugin?.activateView?.();
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, notePath });
  await page.getByRole("tab", { name: "Chat" }).click().catch(() => undefined);
}

function extractLinearUrl(note: string): string | null {
  const match = note.match(/https:\/\/linear\.app\/[^\s)\]>"']+/iu);
  return match?.[0]?.replace(/[.,;]+$/u, "") ?? null;
}

async function findLinearIssueByTitle(
  page: Page,
  title: string,
  teamId: string,
): Promise<{ id: string; url: string } | null> {
  return page.evaluate(
    async ({ pluginId, title, teamId }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      if (!plugin?.createToolRegistry) return null;
      const registry = plugin.createToolRegistry();
      const context = {
        ...plugin.createToolExecutionContext(`find linear ${title}`),
        runId: `flow-real-linear-find-${Date.now()}`,
        operationId: `linear_search_issues-find-${Date.now()}`,
        deadlineAt: Date.now() + 60_000,
      };
      const tryNames = ["linear_search_issues", "linear_list_issues"] as const;
      for (const name of tryNames) {
        // Discovery requires both a registered tool and an executable registry.
        if (!registry.getDescriptor?.(name) || !registry.execute) continue;
        const result = await registry.execute(
          {
            id: `${name}-find`,
            name,
            arguments:
              name === "linear_search_issues"
                ? { query: title, first: 10 }
                : { teamId, first: 25 },
          },
          { ...context, operationId: `${name}-find-${Date.now()}` },
        );
        if (!result?.ok) continue;
        const issues = Array.isArray((result.output as any)?.items)
          ? (result.output as any).items
          : Array.isArray((result.output as any)?.issues)
          ? (result.output as any).issues
          : Array.isArray((result.output as any)?.nodes)
            ? (result.output as any).nodes
            : Array.isArray(result.output)
              ? result.output
              : [];
        const match = issues.find((issue: any) => {
          const issueTitle = String(issue?.title ?? issue?.name ?? "").trim();
          return issueTitle === title || issueTitle.includes(title);
        });
        const url = String(
          match?.url ?? match?.issue?.url ?? match?.attributes?.url ?? "",
        ).trim();
        const id = String(match?.id ?? match?.uuid ?? match?.issue?.id ?? "").trim();
        if (id && /^https:\/\/linear\.app\//iu.test(url)) return { id, url };
      }
      return null;
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, title, teamId },
  );
}

/** Complete research-publication checkpoint bound to the note, or null. */
async function readCompleteResearchPublication(
  page: Page,
  notePath: string,
): Promise<{
  publicationId: string;
  issueId: string;
  backlinkVerified: boolean;
} | null> {
  return page.evaluate(({ pluginId, notePath }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
    const checkpoints = Object.values(
      plugin.researchPublicationCheckpointNamespace?.checkpoints ?? {},
    ) as any[];
    const matched = checkpoints.find(
      (checkpoint) =>
        checkpoint?.artifact?.notePath === notePath &&
        checkpoint?.status === "complete",
    );
    if (!matched) return null;
    return {
      publicationId: String(matched.publicationId ?? ""),
      issueId: String(matched.issue?.id ?? ""),
      backlinkVerified:
        typeof matched.backlink?.afterSha256 === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(matched.backlink.afterSha256),
    };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, notePath });
}

/**
 * Wait for the GitHub publication checkpoint bound to the disposable repo to
 * reach "finalized" with all three finalization receipts. Finalization runs
 * inside publish_verified_code_to_github, so this is normally instant; the
 * bounded poll only covers a retry-on-next-continuation lag.
 */
async function pollForFinalizedGithubPublication(
  page: Page,
  repository: string,
  timeoutMs: number,
): Promise<{
  publicationId: string;
  status: string;
  pullRequestHtmlUrl: string;
  pullRequestNumber: number;
  linearLinkReceiptId: string;
  linearCompletionReceiptId: string;
  obsidianReceiptId: string;
}> {
  const deadline = Date.now() + timeoutMs;
  let observed: unknown = null;
  for (;;) {
    const publications = await page.evaluate(({ pluginId, repository }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
      const checkpoints = Object.values(
        plugin.githubPublicationCheckpointNamespace?.checkpoints ?? {},
      ) as any[];
      return checkpoints
        .filter((checkpoint) =>
          String(checkpoint?.pullRequest?.htmlUrl ?? "").includes(
            `/${repository}/pull/`,
          ),
        )
        .map((checkpoint) => ({
          publicationId: String(checkpoint.publicationId ?? ""),
          status: String(checkpoint.status ?? ""),
          pullRequestHtmlUrl: String(checkpoint.pullRequest?.htmlUrl ?? ""),
          pullRequestNumber: Number(checkpoint.pullRequest?.number ?? 0),
          linearLinkReceiptId: String(checkpoint.linearLinkReceiptId ?? ""),
          linearCompletionReceiptId: String(
            checkpoint.linearCompletionReceiptId ?? "",
          ),
          obsidianReceiptId: String(checkpoint.obsidianReceiptId ?? ""),
        }));
    }, { pluginId: NATIVE_CORE_PLUGIN_ID, repository });
    observed = publications;
    const finalized = publications.find(
      (item) =>
        item.status === "finalized" &&
        item.linearLinkReceiptId &&
        item.linearCompletionReceiptId &&
        item.obsidianReceiptId,
    );
    if (finalized) return finalized;
    if (Date.now() >= deadline) {
      throw new Error(
        `GitHub publication never reached finalized with all finalization receipts; observed=${JSON.stringify(observed).slice(0, 800)}`,
      );
    }
    await page.waitForTimeout(5_000);
  }
}

/** Redacted projection of one external action receipt from the ledger. */
async function readExternalActionReceipt(
  page: Page,
  receiptId: string,
): Promise<{
  id: string;
  toolName: string;
  resourceId: string;
  readbackStatus: string;
}> {
  return page.evaluate(({ pluginId, receiptId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
    const entry = (plugin.externalActionReceiptLedger?.entries ?? []).find(
      (candidate: any) => candidate?.receipt?.id === receiptId,
    );
    if (!entry) throw new Error(`External action receipt missing: ${receiptId}`);
    const receipt = entry.receipt;
    return {
      id: String(receipt.id ?? ""),
      toolName: String(receipt.toolName ?? ""),
      resourceId: String(receipt.resource?.id ?? ""),
      readbackStatus: String(receipt.readback?.status ?? ""),
    };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, receiptId });
}

/**
 * Independent provider readback for stage 6: the issue's workflow state and
 * its comments via the production secret-backed Linear client.
 */
async function readLinearIssueCompletionProof(
  page: Page,
  issueId: string,
): Promise<{
  stateId: string;
  stateType: string;
  completedAt: string;
  trashed: boolean;
  configuredCompletedStateId: string;
}> {
  return page.evaluate(async ({ pluginId, issueId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    const client = plugin?.createSecretBackedLinearClient?.();
    if (!plugin || !client) {
      throw new Error("Production Linear readback client is unavailable.");
    }
    const issue = await client.execute("issues.get", { id: issueId }) as any;
    return {
      stateId: String(issue?.state?.id ?? ""),
      stateType: String(issue?.state?.type ?? ""),
      completedAt: String(issue?.completedAt ?? ""),
      trashed: issue?.trashed === true,
      configuredCompletedStateId: String(
        plugin.settings?.linearCompletedStateId ?? "",
      ),
    };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, issueId });
}

/**
 * Re-read the exact comment resource named by the finalizer receipt. This
 * avoids treating a connection-filter result as authority for a concrete,
 * independently verified mutation target.
 */
async function readLinearCommentProof(
  page: Page,
  commentId: string,
): Promise<{
  id: string;
  body: string;
  issueId: string;
  archivedAt: string;
}> {
  return page.evaluate(async ({ pluginId, commentId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    const client = plugin?.createSecretBackedLinearClient?.();
    if (!plugin || !client) {
      throw new Error("Production Linear comment readback client is unavailable.");
    }
    const comment = await client.execute("comments.get", { id: commentId }) as any;
    return {
      id: String(comment?.id ?? ""),
      body: String(comment?.body ?? ""),
      issueId: String(comment?.issue?.id ?? ""),
      archivedAt: String(comment?.archivedAt ?? ""),
    };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, commentId });
}

async function cleanupLinearIssue(page: Page, issueId: string): Promise<void> {
  await page.evaluate(async ({ pluginId, issueId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[pluginId];
    const registry = plugin?.createToolRegistry?.();
    const client = plugin?.createSecretBackedLinearClient?.();
    if (!plugin || !registry?.prepare || !registry?.executePrepared || !client) {
      throw new Error("Production Linear cleanup surfaces are unavailable.");
    }
    const read = async (): Promise<"active" | "absent" | "trashed"> => {
      try {
        const record = await client.execute("issues.get", { id: issueId }) as any;
        return record?.trashed === true || record?.attributes?.trashed === true ? "trashed" : "active";
      } catch (error) {
        if ((error as any)?.code === "linear_not_found") return "absent";
        throw error;
      }
    };
    if (await read() === "active") {
      const context = {
        ...plugin.createToolExecutionContext("Clean up the exact disposable Flow real issue."),
        runId: `flow-real-cleanup-${issueId}`,
        operationId: `linear-trash-issue-cleanup-${issueId}`,
        deadlineAt: Date.now() + 60_000,
      };
      const prepared = await registry.prepare(
        { id: context.operationId, name: "linear_trash_issue", arguments: { id: issueId } },
        context,
      );
      if (!prepared?.ok) throw new Error(`Linear cleanup prepare failed: ${String(prepared?.error?.code ?? "unknown")}.`);
      const authorization = {
        preparedActionId: prepared.action.id,
        payloadFingerprint: prepared.action.payloadFingerprint,
        grantId: `flow-real-cleanup-${issueId}`,
      };
      const executed = await registry.executePrepared(
        prepared.action,
        { ...context, authorizedAction: authorization },
        authorization,
      );
      if (!executed?.ok || executed.receipt?.readback?.status !== "verified") {
        throw new Error(`Linear cleanup lacked verified provider readback: ${String(executed?.error?.code ?? "unknown")}.`);
      }
    }
    if (await read() === "active") throw new Error("disposable Linear issue remained active after cleanup.");
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, issueId });
}

async function resolveWorkspaceCleanupBinding(
  page: Page,
  workspaceId: string,
): Promise<{ workspaceRoot: string; workspaceBranch: string } | null> {
  return page.evaluate(async ({ corePluginId, codePluginId, workspaceId }) => {
    const app = (window as typeof window & { app?: any }).app;
    const code = app?.plugins?.plugins?.[corePluginId]?.getBundledCapability?.(codePluginId);
    const manager = code?.workspaceManager ?? code?.runtime?.workspaceManager;
    if (!manager?.loadManifest) return null;
    try {
      const manifest = await manager.loadManifest(workspaceId);
      const workspaceRoot = String(manifest?.canonicalRoot ?? "").trim();
      const workspaceBranch = String(manifest?.repositoryBinding?.branch ?? "").trim();
      return workspaceRoot && workspaceBranch ? { workspaceRoot, workspaceBranch } : null;
    } catch (error) {
      if (String((error as any)?.code ?? "") === "workspace_not_found") return null;
      throw error;
    }
  }, { corePluginId: NATIVE_CORE_PLUGIN_ID, codePluginId: PHASE4_CODE_PLUGIN_ID, workspaceId });
}

/**
 * Soft code-depth probe for continuous COMPOUND-REAL.
 * Never throws for missing workspace/file/commit — callers log `codeDepth=`.
 *
 * Depth ladder: workspace_missing → file_missing → marker_missing → marker_ok
 * → committed (hard-required on COMPOUND-REAL; Soft-union pays code only after verified commit).
 *
 * Commit proof comes from the durable publication handoff (commitSha), not from
 * repositoryBinding — that binding has no headSha field.
 */
async function softProbeCodeDepth(
  page: Page,
  workspaceId: string,
  relativePath: string,
  marker: string,
  profileKey: string,
): Promise<{ depth: string; detail?: string }> {
  try {
    return await page.evaluate(
      async ({
        corePluginId,
        codePluginId,
        workspaceId,
        relativePath,
        marker,
        profileKey,
      }) => {
        const app = (window as typeof window & { app?: any }).app;
        const code = app?.plugins?.plugins?.[corePluginId]?.getBundledCapability?.(
          codePluginId,
        );
        const manager = code?.workspaceManager ?? code?.runtime?.workspaceManager;
        if (!manager?.loadManifest && !manager?.read) {
          return { depth: "unreadable", detail: "workspace_manager_unavailable" };
        }
        try {
          if (typeof manager.loadManifest === "function") {
            await manager.loadManifest(workspaceId);
          }
        } catch (error) {
          const codeName = String((error as { code?: string })?.code ?? "");
          const message = String((error as Error)?.message ?? error ?? "");
          if (
            codeName === "workspace_not_found" ||
            /does not exist|workspace_not_found/iu.test(message)
          ) {
            return { depth: "workspace_missing", detail: codeName || "not_found" };
          }
          return {
            depth: "unreadable",
            detail: (codeName || message).slice(0, 160),
          };
        }

        let fileText = "";
        try {
          if (typeof manager.read === "function") {
            const raw = await manager.read(workspaceId, relativePath);
            fileText = String(
              (raw as { content?: string })?.content ??
                (raw as { text?: string })?.text ??
                (typeof raw === "string" ? raw : JSON.stringify(raw ?? "")),
            );
          } else {
            return { depth: "file_missing", detail: "read_api_unavailable" };
          }
        } catch (error) {
          const message = String((error as Error)?.message ?? error ?? "");
          if (/not found|does not exist|ENOENT/iu.test(message)) {
            return { depth: "file_missing", detail: message.slice(0, 160) };
          }
          return { depth: "unreadable", detail: message.slice(0, 160) };
        }

        if (!fileText.includes(marker)) {
          return {
            depth: "marker_missing",
            detail: `bytes=${fileText.length}`,
          };
        }

        // Authoritative Soft-union signal: publication-eligible verified commit.
        try {
          const resolveHandoff =
            typeof code?.resolveVerifiedCodePublicationHandoff === "function"
              ? code.resolveVerifiedCodePublicationHandoff.bind(code)
              : typeof code?.resolveLatestVerifiedPublicationHandoff === "function"
                ? code.resolveLatestVerifiedPublicationHandoff.bind(code)
                : null;
          if (resolveHandoff) {
            const handoff = await resolveHandoff(profileKey);
            const commitSha = String(handoff?.commitSha ?? "").trim();
            const handoffWorkspace = String(handoff?.workspaceId ?? "").trim();
            if (
              /^[0-9a-f]{7,64}$/iu.test(commitSha) &&
              (!handoffWorkspace || handoffWorkspace === workspaceId)
            ) {
              return { depth: "committed", detail: "handoff_commit_sha" };
            }
          }
        } catch (error) {
          return {
            depth: "marker_ok",
            detail: `handoff_error:${String((error as Error)?.message ?? error).slice(0, 120)}`,
          };
        }

        // Fallback: worktree HEAD advanced past workspace baseSha.
        try {
          const manifest = await manager.loadManifest?.(workspaceId);
          const baseSha = String(manifest?.baseSha ?? "").trim().toLowerCase();
          const worktreeRoot = String(
            manifest?.repositoryBinding?.worktreeRoot ??
              manifest?.canonicalRoot ??
              "",
          ).trim();
          const inspect =
            typeof code?.inspectWorktree === "function"
              ? await code.inspectWorktree(worktreeRoot)
              : typeof manager?.inspectWorktree === "function"
                ? await manager.inspectWorktree(worktreeRoot)
                : null;
          const head = String(
            inspect?.head ?? inspect?.headSha ?? inspect?.commitSha ?? "",
          )
            .trim()
            .toLowerCase();
          if (
            /^[0-9a-f]{7,64}$/iu.test(head) &&
            (!baseSha || head !== baseSha)
          ) {
            return { depth: "committed", detail: "worktree_head_advanced" };
          }
        } catch {
          // fall through to marker_ok
        }

        return { depth: "marker_ok", detail: "no_commit_sha" };
      },
      {
        corePluginId: NATIVE_CORE_PLUGIN_ID,
        codePluginId: PHASE4_CODE_PLUGIN_ID,
        workspaceId,
        relativePath,
        marker,
        profileKey,
      },
    );
  } catch (error) {
    return {
      depth: "unreadable",
      detail: String((error as Error)?.message ?? error).slice(0, 160),
    };
  }
}

async function expectTrustedRepositoryProfile(
  page: Page,
  profileKey: string,
  repositoryRoot: string,
): Promise<void> {
  const observed = await page.evaluate(
    async ({ corePluginId, codePluginId, expectedKey }) => {
      const app = (window as typeof window & { app?: any }).app;
      const code = app?.plugins?.plugins?.[corePluginId]
        ?.getBundledCapability?.(codePluginId);
      const profile = await code?.resolveTrustedRepositoryProfile?.(expectedKey);
      return profile
        ? {
            key: profile.key,
            repositoryRoot: profile.repositoryRoot,
          }
        : null;
    },
    {
      corePluginId: NATIVE_CORE_PLUGIN_ID,
      codePluginId: PHASE4_CODE_PLUGIN_ID,
      expectedKey: profileKey,
    },
  );
  expect(observed).toEqual({ key: profileKey, repositoryRoot });
}

async function prepareAgentChatSurface(
  page: Page,
  teamId: string,
): Promise<void> {
  await page.getByRole("tab", { name: "Chat" }).click();
  for (let i = 0; i < 3; i += 1) {
    const dismiss = page.getByRole("button", { name: "Dismiss" });
    if (!(await dismiss.isVisible().catch(() => false))) break;
    await dismiss.click().catch(() => undefined);
    await page.waitForTimeout(200);
  }
  // The shared e2e team decays to zero projects (other lanes create then
  // trash their own), and configureRecommendedLinearQueue only selects
  // existing projects. Provision the durable queue project first so the
  // readiness gate below stops failing closed on an empty team.
  const durableQueue = await ensureDurableLinearQueueProject(page, {
    pluginId: NATIVE_CORE_PLUGIN_ID,
    teamId,
  });
  if (!durableQueue.ok) {
    throw new Error(
      `Durable Linear queue provisioning failed before COMPOUND-REAL: ${durableQueue.message}`,
    );
  }
  const linearReady = await page.evaluate(async ({ pluginId, teamId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[pluginId];
    if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
    plugin.settings.linearEnabled = true;
    plugin.settings.linearDefaultTeamId = teamId;
    plugin.settings.workingMode = "automatic";
    plugin.settings.autonomyProfile = "automatic";
    plugin.settings.autoContinueLongRuns = true;
    plugin.settings.completionDrivenLoops = true;
    await plugin.saveSettings?.();
    const connection = await plugin.testLinearConnection();
    if (!connection?.ok) {
      return {
        ok: false as const,
        message: String(connection?.message ?? connection?.error ?? "unknown").slice(0, 400),
      };
    }
    const oauth = plugin.getLinearOAuthStatus?.();
    const credential = plugin.getLinearCredentialStatus?.();
    if (
      oauth?.connected !== true &&
      (credential?.configured !== true || credential?.secure !== true)
    ) {
      return { ok: false as const, message: "Linear credential missing after discovery." };
    }
    // publish_research_to_linear needs a queue project and the host
    // finalizeLinearCompletion step needs the configured completed state.
    // testLinearConnection reconciles both; fall back to the recommended
    // queue setup once before failing closed.
    if (
      !plugin.settings.linearQueueProjectId ||
      !plugin.settings.linearCompletedStateId
    ) {
      await plugin.configureRecommendedLinearQueue?.();
    }
    if (!plugin.settings.linearQueueProjectId) {
      return {
        ok: false as const,
        message: "Linear queue project is unresolved; publish_research_to_linear has no destination.",
      };
    }
    if (!plugin.settings.linearCompletedStateId) {
      return {
        ok: false as const,
        message: "Linear completed state is unresolved; finalizeLinearCompletion would fail.",
      };
    }
    return { ok: true as const, message: "ready" };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, teamId });
  if (!linearReady.ok) {
    throw new Error(`Linear must be ready before COMPOUND-REAL: ${linearReady.message}`);
  }
  await page.getByRole("tab", { name: "Chat" }).click();
  const dismissAgain = page.getByRole("button", { name: "Dismiss" });
  if (await dismissAgain.isVisible().catch(() => false)) {
    await dismissAgain.click().catch(() => undefined);
  }
  const runReady = await page.locator("button.agentic-researcher-run").isEnabled().catch(() => false);
  if (!runReady) {
    throw new Error("Run Mission stayed disabled after clearing Chat readiness chrome.");
  }
}

async function collectHarnessGitHubTokenCandidates(
  preferredToken: string | null,
): Promise<string[]> {
  const candidates: string[] = [];
  const preferred = preferredToken?.trim() || "";
  if (
    /^github_pat_[A-Za-z0-9_-]{20,500}$/u.test(preferred) ||
    /^gh[pousr]_[A-Za-z0-9]{20,500}$/u.test(preferred)
  ) {
    candidates.push(preferred);
  }
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      windowsHide: true,
      timeout: 30_000,
    });
    const ghToken = String(stdout ?? "").trim();
    if (
      (/^github_pat_[A-Za-z0-9_-]{20,500}$/u.test(ghToken) ||
        /^gh[pousr]_[A-Za-z0-9]{20,500}$/u.test(ghToken)) &&
      !candidates.includes(ghToken)
    ) {
      candidates.push(ghToken);
    }
  } catch {
    // gh may be unavailable; preferred token may still work after reinstall.
  }
  return orderGitHubHarnessTokensForPush(candidates);
}

async function ensureGitHubCreateCapableCredential(input: {
  page: Page;
  client: GitHubRestClient;
  owner: string;
  preferredToken: string | null;
}): Promise<GitHubRestClient> {
  let vaultCreateOk = false;
  try {
    await proveRestCreateAndDeleteProbe(input.client, input.owner);
    vaultCreateOk = true;
    console.log("FLOW-REAL GitHub create authority via=vault_or_e2e_rest");
  } catch (initialError) {
    console.log(
      `FLOW-REAL vault/E2E create probe failed: ${safeExternalCleanupError(initialError)}`,
    );
  }

  const candidates = await collectHarnessGitHubTokenCandidates(
    input.preferredToken,
  );
  // Vault fine-grained PATs often create private repos (Administration:write)
  // but fail git push Contents on newly created repos. Prefer installing a
  // classic/gh harness token for push even when vault create already works.
  if (vaultCreateOk && candidates.length > 0) {
    for (const installToken of candidates) {
      const installed = await input.page.evaluate(
        async ({ pluginId, token }) => {
          const plugin = (window as typeof window & { app?: any }).app?.plugins
            ?.plugins?.[pluginId];
          if (!plugin?.setGitHubHarnessAccessToken) {
            return { ok: false, message: "Harness GitHub credential API unavailable." };
          }
          return plugin.setGitHubHarnessAccessToken(token);
        },
        { pluginId: NATIVE_CORE_PLUGIN_ID, token: installToken },
      );
      if (!installed?.ok) continue;
      const vaultGithub = await readGitHubIdentity(input.page);
      if (vaultGithub.login.toLowerCase() !== input.owner.toLowerCase()) {
        continue;
      }
      console.log(
        "FLOW-REAL GitHub push authority via=harness_access_token (vault create kept)",
      );
      return new GitHubRestClient({
        transport: fetchTransport,
        token: vaultGithub.token,
        timeoutMs: 60_000,
      });
    }
    console.log(
      "FLOW-REAL harness push install skipped/failed; continuing with vault create credential",
    );
    return input.client;
  }

  if (vaultCreateOk) {
    return input.client;
  }

  if (candidates.length === 0) {
    throw new Error(
      "Agentic GitHub create is blocked: vault/E2E credential cannot create private repositories, and no github_pat_/gh[pousr]_ harness token is available. Set E2E_GITHUB_TOKEN with Administration:write plus Contents:write (All repositories), or run gh auth login with repo+delete_repo.",
    );
  }

  let lastInstallError = "unknown";
  for (const installToken of candidates) {
    const installed = await input.page.evaluate(
      async ({ pluginId, token }) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        if (!plugin?.setGitHubHarnessAccessToken) {
          throw new Error("Harness GitHub credential API is unavailable.");
        }
        return plugin.setGitHubHarnessAccessToken(token);
      },
      { pluginId: NATIVE_CORE_PLUGIN_ID, token: installToken },
    );
    if (!installed?.ok) {
      lastInstallError = String(installed?.message ?? "unknown").slice(0, 400);
      continue;
    }

    const vaultGithub = await readGitHubIdentity(input.page);
    if (vaultGithub.login.toLowerCase() !== input.owner.toLowerCase()) {
      lastInstallError = `login drifted: expected ${input.owner}, got ${vaultGithub.login}`;
      continue;
    }
    const client = new GitHubRestClient({
      transport: fetchTransport,
      token: vaultGithub.token,
      timeoutMs: 60_000,
    });
    try {
      await proveRestCreateAndDeleteProbe(client, vaultGithub.login);
      console.log("FLOW-REAL GitHub create authority via=harness_access_token");
      return client;
    } catch (error) {
      lastInstallError = safeExternalCleanupError(error);
    }
  }

  throw new Error(
    [
      "Agentic GitHub create is blocked after harness credential install: REST create+delete probe still failed.",
      lastInstallError,
      "Fix: set E2E_GITHUB_TOKEN to a fine-grained PAT with Administration:write plus Contents:write (All repositories), or refresh gh auth with repo scope.",
    ].join(" "),
  );
}

async function bindGitHubRepositoryDestination(
  page: Page,
  profileKey: string,
  githubRepository: string,
): Promise<void> {
  await page.evaluate(
    async ({ pluginId, profileKey, githubRepository }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
      const registry = plugin.repositoryProfileRegistry;
      const profile = registry?.profiles?.[profileKey];
      if (!profile?.promotionPolicy) {
        throw new Error(
          `Repository profile ${profileKey} is missing for GitHub destination bind.`,
        );
      }
      profile.promotionPolicy.githubRepository = githubRepository;
      if (plugin.settings?.repositoryProfileRegistry?.profiles?.[profileKey]) {
        plugin.settings.repositoryProfileRegistry.profiles[
          profileKey
        ].promotionPolicy.githubRepository = githubRepository;
      }
      await plugin.saveSettings?.();
      const bound =
        plugin.repositoryProfileRegistry?.profiles?.[profileKey]
          ?.promotionPolicy?.githubRepository;
      if (bound !== githubRepository) {
        throw new Error(
          `GitHub destination bind failed: expected ${githubRepository}, got ${String(bound)}.`,
        );
      }
    },
    {
      pluginId: NATIVE_CORE_PLUGIN_ID,
      profileKey,
      githubRepository,
    },
  );
}

async function ensureGitHubConnected(
  page: Page,
  githubToken: string | null,
): Promise<void> {
  const leaseOk = await page.evaluate(async ({ pluginId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
    const github = plugin.getGitHubCredentialStatus?.();
    if (github?.connected !== true) return false;
    try {
      await plugin.withGitHubCredentialToken(
        (_token: string, account: { id: number; login: string }) => ({
          account: { ...account },
        }),
      );
      return true;
    } catch {
      return false;
    }
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
  if (leaseOk) return;

  const candidates: string[] = [];
  const preferred = typeof githubToken === "string" ? githubToken.trim() : "";
  if (
    /^github_pat_[A-Za-z0-9_-]{20,500}$/u.test(preferred) ||
    /^gh[pousr]_[A-Za-z0-9]{20,500}$/u.test(preferred)
  ) {
    candidates.push(preferred);
  }
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      windowsHide: true,
      timeout: 30_000,
    });
    const ghToken = String(stdout ?? "").trim();
    if (
      (/^github_pat_[A-Za-z0-9_-]{20,500}$/u.test(ghToken) ||
        /^gh[pousr]_[A-Za-z0-9]{20,500}$/u.test(ghToken)) &&
      !candidates.includes(ghToken)
    ) {
      candidates.push(ghToken);
    }
  } catch {
    // Optional fallback when gh is unavailable.
  }
  if (candidates.length === 0) {
    throw new Error(
      "Vault GitHub lease failed and no github_pat_/gh[pousr]_ token is available via E2E_GITHUB_TOKEN or gh auth token.",
    );
  }

  let lastError = "unknown";
  for (const token of candidates) {
    const saved = await page.evaluate(
      async ({ pluginId, token }) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
        if (plugin.setGitHubHarnessAccessToken) {
          return plugin.setGitHubHarnessAccessToken(token);
        }
        if (/^github_pat_[A-Za-z0-9_-]{20,500}$/u.test(token)) {
          return plugin.setGitHubFineGrainedPat(token);
        }
        return {
          ok: false,
          message: "Harness GitHub credential API is unavailable for classic/OAuth tokens.",
        };
      },
      { pluginId: NATIVE_CORE_PLUGIN_ID, token },
    );
    if (saved?.ok) return;
    lastError = String(saved?.message ?? "unknown").slice(0, 400);
  }
  throw new Error(`GitHub secure credential setup failed: ${lastError}`);
}

async function readGitHubIdentity(
  page: Page,
): Promise<{ login: string; token: string }> {
  return page.evaluate(async ({ pluginId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    if (!plugin?.withGitHubCredentialToken) {
      throw new Error("GitHub credential lease API is unavailable.");
    }
    return plugin.withGitHubCredentialToken(
      (token: string, account: { id: number; login: string }) => {
        if (!account?.login?.trim()) {
          throw new Error("GitHub vault lease returned no login.");
        }
        if (!token?.trim()) {
          throw new Error("GitHub vault lease returned no token.");
        }
        return { login: account.login.trim(), token: token.trim() };
      },
    );
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

function safeDisposableRepositoryName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 80);
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
    json,
  };
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `compound-flow-real-live is missing required environment ${name}. ` +
        "It mutates a real Linear workspace, so the target team must be named explicitly.",
    );
  }
  return value;
}
