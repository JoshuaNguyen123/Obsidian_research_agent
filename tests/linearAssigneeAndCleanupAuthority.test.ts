import test from "node:test";
import assert from "node:assert/strict";

import {
  githubCleanupAuthorityFromScopesV1,
  githubCleanupAuthorityReasonV1,
} from "../src/agent/capabilityReadiness";
import { evaluateMissionReadinessPreflightV1 } from "../src/agent/missionReadinessPreflight";
import { ResearchTicketPublisher } from "../src/integrations/linear/ResearchTicketPublisher";

const VIEWER_ID = "e59df97b-9cd6-42af-8d92-753b301a469f";
const TEAM_ID = "11111111-2222-4333-8444-555555555555";

function publisherWith(
  resolveDefaultAssigneeId: (() => string | null | undefined) | undefined,
  prepared: { arguments?: Record<string, unknown> },
): ResearchTicketPublisher {
  return new ResearchTicketPublisher({
    readClient: {} as never,
    actionExecutor: {
      prepare: async (input: any) => {
        prepared.arguments = input.arguments;
        throw new Error("stop-after-prepare");
      },
      executePrepared: async () => {
        throw new Error("not reached");
      },
    } as never,
    queueTeamId: TEAM_ID,
    resolveDefaultAssigneeId,
  });
}

test("the publisher passes the resolved viewer as assigneeId", async () => {
  const prepared: { arguments?: Record<string, unknown> } = {};
  const publisher = publisherWith(() => VIEWER_ID, prepared);
  const resolved = (publisher as unknown as {
    resolveDefaultAssigneeId(): string | null;
  }).resolveDefaultAssigneeId();
  assert.equal(resolved, VIEWER_ID);
});

test("an absent or blank viewer leaves the issue unassigned", () => {
  for (const resolver of [
    undefined,
    () => null,
    () => undefined,
    () => "   ",
  ]) {
    const publisher = publisherWith(resolver as never, {});
    const resolved = (publisher as unknown as {
      resolveDefaultAssigneeId(): string | null;
    }).resolveDefaultAssigneeId();
    assert.equal(resolved, null);
  }
});

test("a throwing assignee resolver never blocks publishing", () => {
  const publisher = publisherWith(() => {
    throw new Error("snapshot unavailable");
  }, {});
  const resolved = (publisher as unknown as {
    resolveDefaultAssigneeId(): string | null;
  }).resolveDefaultAssigneeId();
  assert.equal(resolved, null, "publishing accepted research outranks assignment");
});

test("a fine-grained PAT reports unknown cleanup authority, not absent", () => {
  // GitHub only returns X-OAuth-Scopes for classic tokens, so a fine-grained
  // PAT always reports no scopes. Reading that as "not authorized" declared
  // every such credential incapable of cleanup.
  assert.equal(githubCleanupAuthorityFromScopesV1(null, "fine_grained_pat"), null);
  assert.equal(githubCleanupAuthorityFromScopesV1([], "fine_grained_pat"), null);
  // Classic behaviour is unchanged.
  assert.equal(githubCleanupAuthorityFromScopesV1(["repo", "delete_repo"]), true);
  assert.equal(githubCleanupAuthorityFromScopesV1(["gist"]), false);
  assert.equal(githubCleanupAuthorityFromScopesV1(null), null);
});

test("the cleanup reason names the fine-grained limitation instead of a missing scope", () => {
  const reason = githubCleanupAuthorityReasonV1({
    authorized: null,
    credentialKind: "fine_grained_pat",
  });
  assert.match(reason, /does not report its permissions/u);
  assert.match(reason, /Administration: write/u);
  assert.doesNotMatch(
    reason,
    /lacks delete_repo/u,
    "sending the user to re-grant a scope their token type has no concept of is wrong",
  );
});

function readiness(): any[] {
  return [
    { version: 2, id: "github", name: "GitHub", status: "Ready", reason: "", evidenceAt: null, nextAction: "", setupTarget: "github" },
    { version: 2, id: "linear", name: "Linear", status: "Ready", reason: "", evidenceAt: null, nextAction: "", setupTarget: "linear" },
    { version: 2, id: "code", name: "Code", status: "Ready", reason: "", evidenceAt: null, nextAction: "", setupTarget: "code" },
    { version: 2, id: "notes", name: "Notes", status: "Ready", reason: "", evidenceAt: null, nextAction: "", setupTarget: "notes_research" },
  ];
}

const CLEANUP_PROMPT =
  "Run the full pipeline: research the topic, publish a Linear issue, create a repository workspace, publish to a private GitHub repository, write a note reflection, then delete the disposable repository and clean up.";

test("a fine-grained PAT no longer blocks a cleanup-stage mission at submit", () => {
  const result = evaluateMissionReadinessPreflightV1({
    prompt: CLEANUP_PROMPT,
    readiness: readiness(),
    activeNote: { hasActiveMarkdown: true, path: "note.md" },
    cleanupAuthority: {
      deleteRepoAuthorized: null,
      credentialKind: "fine_grained_pat",
    },
    gitIdentityPinnedReady: true,
  });
  const cleanup = result.checks.find((check) => check.id === "cleanup_authority");
  assert.equal(cleanup?.required, true, "the prompt does request cleanup");
  assert.equal(cleanup?.ok, true, "unknown-for-this-token-kind is not 'unauthorized'");
});

test("a classic token that genuinely lacks delete authority still blocks", () => {
  const result = evaluateMissionReadinessPreflightV1({
    prompt: CLEANUP_PROMPT,
    readiness: readiness(),
    activeNote: { hasActiveMarkdown: true, path: "note.md" },
    cleanupAuthority: {
      deleteRepoAuthorized: false,
      credentialKind: "oauth_device",
    },
    gitIdentityPinnedReady: true,
  });
  const cleanup = result.checks.find((check) => check.id === "cleanup_authority");
  assert.equal(cleanup?.ok, false, "fail-closed must survive for observable scopes");
  assert.match(cleanup?.reason ?? "", /lacks delete_repo/u);
});
