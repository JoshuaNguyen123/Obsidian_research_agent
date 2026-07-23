import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityReadinessV2 } from "../src/agent/capabilityReadiness";
import {
  evaluatePinnedGitIdentityReadinessV1,
  githubCleanupAuthorityFromScopesV1,
} from "../src/agent/capabilityReadiness";
import { evaluateMissionReadinessPreflightV1 } from "../src/agent/missionReadinessPreflight";
import {
  buildMissionReadinessCardModelV1,
  missionReadinessCardActionLabel,
  missionReadinessCardTitle,
} from "../src/ui/MissionReadinessCard";

function row(
  id: CapabilityReadinessV2["id"],
  status: CapabilityReadinessV2["status"],
  setupTarget: CapabilityReadinessV2["setupTarget"] = id === "notes"
    ? "notes_research"
    : (id as CapabilityReadinessV2["setupTarget"]),
  nextAction = `Fix ${id}`,
): CapabilityReadinessV2 {
  return {
    version: 2,
    id,
    name: id,
    status,
    reason: `${id} is ${status}`,
    evidenceAt: null,
    nextAction,
    setupTarget,
  };
}

function readyBundle(): CapabilityReadinessV2[] {
  return [
    row("model", "Ready", "model"),
    row("notes", "Ready"),
    row("code", "Ready", "code"),
    row("linear", "Ready", "linear"),
    row("github", "Ready", "github"),
    row("browser", "Available", "browser_web"),
    row("background", "Ready", "background"),
  ];
}

const END_TO_END_PROMPT =
  "I want to create the game of checkers in Python end to end following the full workflow";

test("non-compound prompts skip the consolidated preflight", () => {
  const result = evaluateMissionReadinessPreflightV1({
    prompt: "Summarize this note",
    readiness: [row("linear", "Setup needed", "linear")],
    activeNote: { hasActiveMarkdown: false },
    cleanupAuthority: { deleteRepoAuthorized: false },
    gitIdentityPinnedReady: false,
  });
  assert.equal(result.compound, false);
  assert.equal(result.ok, true);
  assert.equal(result.missing.length, 0);
  assert.equal(buildMissionReadinessCardModelV1(result), null);
});

test("compound preflight is ready when all six checks pass", () => {
  const result = evaluateMissionReadinessPreflightV1({
    prompt: END_TO_END_PROMPT,
    readiness: readyBundle(),
    activeNote: { hasActiveMarkdown: true, path: "Projects/checkers.md" },
    cleanupAuthority: { deleteRepoAuthorized: true },
    gitIdentityPinnedReady: true,
  });
  assert.equal(result.compound, true);
  assert.equal(result.ok, true);
  assert.equal(result.missing.length, 0);
  assert.ok(result.checks.every((check) => !check.required || check.ok));
});

test("compound preflight lists Linear, Sandbox, and GitHub before later checks", () => {
  const readiness = readyBundle().map((item) => {
    if (item.id === "linear") {
      return row("linear", "Setup needed", "linear", "Connect Linear");
    }
    if (item.id === "code") {
      return row("code", "Available", "code", "Bind a repository");
    }
    if (item.id === "github") {
      return row("github", "Setup needed", "github", "Connect GitHub");
    }
    return item;
  });
  const result = evaluateMissionReadinessPreflightV1({
    prompt: END_TO_END_PROMPT,
    readiness,
    activeNote: { hasActiveMarkdown: false },
    cleanupAuthority: { deleteRepoAuthorized: null },
    gitIdentityPinnedReady: true,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.missing.map((item) => item.id),
    ["linear", "sandbox", "github", "cleanup_authority", "active_note"],
  );
  assert.equal(result.primary?.id, "linear");
  assert.equal(result.primary?.nextAction, "Connect Linear");

  const card = buildMissionReadinessCardModelV1(result);
  assert.ok(card);
  assert.equal(card?.title, missionReadinessCardTitle());
  assert.equal(card?.actionLabel, missionReadinessCardActionLabel());
  assert.match(card?.what ?? "", /Linear/);
  assert.match(card?.what ?? "", /Sandbox/);
  assert.match(card?.chatLine ?? "", /Connect Linear/);
});

test("git identity and cleanup authority are required for code/publish/cleanup stages", () => {
  const result = evaluateMissionReadinessPreflightV1({
    prompt: END_TO_END_PROMPT,
    readiness: readyBundle(),
    activeNote: { hasActiveMarkdown: true },
    cleanupAuthority: { deleteRepoAuthorized: false },
    gitIdentityPinnedReady: false,
  });
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((item) => item.id === "git_identity"));
  assert.ok(result.missing.some((item) => item.id === "cleanup_authority"));
  assert.equal(result.primary?.id, "git_identity");
});

test("active note is required when accepted research is in the compound plan", () => {
  const result = evaluateMissionReadinessPreflightV1({
    prompt: END_TO_END_PROMPT,
    readiness: readyBundle(),
    activeNote: { hasActiveMarkdown: false },
    cleanupAuthority: { deleteRepoAuthorized: true },
    gitIdentityPinnedReady: true,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.missing.map((item) => item.id),
    ["active_note"],
  );
  assert.equal(result.primary?.nextAction, "Open a markdown note");
  assert.equal(result.primary?.setupTarget, "notes_research");
});

test("pinned git identity helper matches host contract", () => {
  assert.equal(evaluatePinnedGitIdentityReadinessV1(), true);
});

test("cleanup authority recognizes repo and delete_repo scopes", () => {
  assert.equal(githubCleanupAuthorityFromScopesV1(["repo", "read:user"]), true);
  assert.equal(githubCleanupAuthorityFromScopesV1(["delete_repo"]), true);
  assert.equal(githubCleanupAuthorityFromScopesV1(["read:user"]), false);
  assert.equal(githubCleanupAuthorityFromScopesV1(null), null);
  assert.equal(githubCleanupAuthorityFromScopesV1([]), null);
});
