import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProgressiveDu06Observations,
  createDu06RetainedLinearEvidenceProof,
  type DailyUseDu06ProgressInput,
  type DailyUseDu06SafeLifecycleState,
} from "../e2e/fixtures/dailyUseDu06Progress";

const fp = (character: string) => `sha256:${character.repeat(64)}`;
const commitSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const expected: DailyUseDu06ProgressInput["expected"] = {
  notePath: "E2E Agent Tests/DU06-current.md",
  repositoryProfileKey: "du06-checkers-project",
  baseSha,
  githubOwner: "fixture-owner",
  githubRepository: "fixture-repository",
};

test("DU-06 progressive proof uses one exact lineage and strong stage bindings", () => {
  const observations = buildProgressiveDu06Observations({
    state: validState(),
    expected,
    researchNotebookVerified: true,
    cleanup: {
      linearOwnedResourceCount: 5,
      linearAbsenceVerified: true,
      githubOwnedResourceObserved: true,
      githubAbsenceVerified: true,
      localOwnedResourceObserved: true,
      localAbsenceVerified: true,
      independentVerified: true,
    },
  });

  assert.ok(observations.artifacts.includes("vault:checkers_rules_notebook"));
  assert.ok(observations.artifacts.includes("linear:initiative"));
  assert.ok(observations.artifacts.includes("code:python_checkers"));
  assert.ok(observations.artifacts.includes("github:private_repository"));
  assert.ok(observations.bindings.includes("binding:project_lineage"));
  assert.deepEqual(observations.cleanup, [
    "cleanup:github_fixture",
    "cleanup:independent_readback",
    "cleanup:linear_fixture",
  ]);
  assert.equal(observations.proofs.includes("graph:authoritative"), false);
  assert.equal(observations.proofs.includes("linear:issue_read_before_code"), false);
});

test("DU-06 progressive proof rejects stale or ambiguous persisted lineage", () => {
  const stale = validState();
  stale.lineages[0].commits[0].proof.notePath = "E2E Agent Tests/old.md";
  const staleObserved = observe(stale);
  assert.deepEqual(staleObserved.artifacts, []);
  assert.deepEqual(staleObserved.proofs, []);

  const ambiguous = validState();
  ambiguous.lineages.push(structuredClone(ambiguous.lineages[0]));
  const ambiguousObserved = observe(ambiguous);
  assert.deepEqual(ambiguousObserved.artifacts, []);
  assert.deepEqual(ambiguousObserved.bindings, []);
});

test("DU-06 progressive proof rejects empty or weak Linear hierarchy", () => {
  const empty = validState();
  empty.linearHierarchies[0].items = [];
  const emptyObserved = observe(empty);
  assert.ok(emptyObserved.artifacts.includes("vault:research_note"));
  assert.equal(emptyObserved.artifacts.includes("linear:initiative"), false);
  assert.equal(emptyObserved.artifacts.includes("code:python_checkers"), false);

  const weak = validState();
  weak.linearHierarchies[0].items[0].readbackFingerprint = null;
  const weakObserved = observe(weak);
  assert.equal(weakObserved.artifacts.includes("linear:initiative"), false);
});

test("DU-06 progressive proof rejects duplicate validation receipts and mismatched GitHub binding", () => {
  const duplicateReceipts = validState();
  duplicateReceipts.codeHandoff.fullValidationReceiptId =
    duplicateReceipts.codeHandoff.targetedValidationReceiptId;
  const duplicateObserved = observe(duplicateReceipts);
  assert.equal(duplicateObserved.artifacts.includes("code:python_checkers"), false);
  assert.equal(duplicateObserved.artifacts.includes("github:private_repository"), false);

  const mismatchedGitHub = validState();
  mismatchedGitHub.privateRepositories[0].owner = "different-owner";
  const githubObserved = observe(mismatchedGitHub);
  assert.ok(githubObserved.artifacts.includes("code:python_checkers"));
  assert.equal(githubObserved.artifacts.includes("github:private_repository"), false);
});

test("DU-06 progressive cleanup never credits vacuous absence", () => {
  const observed = buildProgressiveDu06Observations({
    state: null,
    expected,
    researchNotebookVerified: false,
    cleanup: {
      linearOwnedResourceCount: 0,
      linearAbsenceVerified: true,
      githubOwnedResourceObserved: false,
      githubAbsenceVerified: true,
      localOwnedResourceObserved: false,
      localAbsenceVerified: true,
      independentVerified: true,
    },
  });
  assert.deepEqual(observed.cleanup, []);
});

test("DU-06 retained Linear evidence fingerprints only the opaque provider ID", () => {
  const providerIssueId = "550e8400-e29b-41d4-a716-446655440000";
  const proof = createDu06RetainedLinearEvidenceProof({
    releaseSha: commitSha,
    providerIssueId,
  });
  assert.deepEqual(
    {
      version: proof.version,
      scenarioId: proof.scenarioId,
      releaseSha: proof.releaseSha,
      providerReadbackVerified: proof.providerReadbackVerified,
    },
    {
      version: 1,
      scenarioId: "DU-06",
      releaseSha: commitSha,
      providerReadbackVerified: true,
    },
  );
  assert.match(proof.providerIssueFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(proof), new RegExp(providerIssueId, "u"));
  assert.throws(
    () => createDu06RetainedLinearEvidenceProof({
      releaseSha: commitSha,
      providerIssueId: "APP-42",
    }),
    /opaque provider issue ID/u,
  );
});

function observe(state: DailyUseDu06SafeLifecycleState) {
  return buildProgressiveDu06Observations({
    state,
    expected,
    researchNotebookVerified: true,
    cleanup: {
      linearOwnedResourceCount: 0,
      linearAbsenceVerified: false,
      githubOwnedResourceObserved: false,
      githubAbsenceVerified: false,
      localOwnedResourceObserved: false,
      localAbsenceVerified: false,
      independentVerified: false,
    },
  });
}

function validState(): DailyUseDu06SafeLifecycleState {
  const artifactFingerprint = fp("a");
  const planFingerprint = fp("b");
  const repositoryProfileFingerprint = fp("c");
  const targetedValidationFingerprint = fp("d");
  const fullValidationFingerprint = fp("e");
  const bindingFingerprint = fp("f");
  const repositoryReadbackFingerprint = fp("1");
  const pullRequestReadbackFingerprint = fp("2");
  const handoffFingerprint = fp("3");
  const readbacks = [fp("4"), fp("5"), fp("6"), fp("7")];
  return {
    lineages: [{
      fingerprint: fp("8"),
      commits: [
        {
          stage: "accepted_research",
          proofFingerprint: fp("9"),
          proof: {
            stage: "accepted_research",
            artifactFingerprint,
            notePath: expected.notePath,
            noteSha256: fp("a"),
          },
        },
        {
          stage: "linear_hierarchy",
          proofFingerprint: fp("b"),
          proof: {
            stage: "linear_hierarchy",
            planFingerprint,
            initiativeId: "initiative-1",
            projectId: "project-1",
            issueIds: ["issue-1"],
            providerReadbackFingerprints: readbacks,
          },
        },
        {
          stage: "code_execution",
          proofFingerprint: fp("c"),
          proof: {
            stage: "code_execution",
            repositoryProfileKey: expected.repositoryProfileKey,
            repositoryProfileFingerprint,
            workspaceId: "workspace-1",
            validationReceiptFingerprints: [
              targetedValidationFingerprint,
              fullValidationFingerprint,
            ],
            targetedValidationPassed: true,
            freshFullValidationPassed: true,
            commitSha,
            commitReadbackFingerprint: fp("d"),
          },
        },
        {
          stage: "private_github_publication",
          proofFingerprint: fp("e"),
          proof: {
            stage: "private_github_publication",
            trustedBindingFingerprint: bindingFingerprint,
            owner: expected.githubOwner,
            repository: expected.githubRepository,
            verifiedPrivate: true,
            branch: "codex/du06",
            pullRequestNumber: 17,
            draft: true,
            remoteSha: commitSha,
            repositoryReadbackFingerprint,
            pullRequestReadbackFingerprint,
          },
        },
      ],
    }],
    researchPublications: [{
      status: "complete",
      artifactFingerprint,
      notePath: expected.notePath,
      issueId: "research-issue-1",
      backlinkVerified: true,
    }],
    linearHierarchies: [{
      status: "complete",
      planFingerprint,
      approvalId: "approval-1",
      grantId: "grant-1",
      items: [
        hierarchyItem("initiative", "initiative-1", readbacks[0]!),
        hierarchyItem("project", "project-1", readbacks[1]!),
        hierarchyItem("initiative_project_link", "link-1", readbacks[2]!),
        hierarchyItem("issue", "issue-1", readbacks[3]!),
      ],
    }],
    codeHandoff: {
      status: "verified",
      repositoryProfileKey: expected.repositoryProfileKey,
      repositoryProfileFingerprint,
      workspaceId: "workspace-1",
      baseSha,
      commitSha,
      targetedValidationReceiptId: "targeted-receipt",
      fullValidationReceiptId: "full-receipt",
      targetedValidationFingerprint,
      fullValidationFingerprint,
      fingerprint: handoffFingerprint,
    },
    privateRepositories: [{
      status: "verified",
      profileKey: expected.repositoryProfileKey,
      owner: expected.githubOwner,
      repository: expected.githubRepository,
      approvalId: "approval-private",
      receiptId: "receipt-private",
      binding: {
        owner: expected.githubOwner,
        repository: expected.githubRepository,
        verifiedPrivate: true,
        fingerprint: bindingFingerprint,
        repositoryProfileKey: expected.repositoryProfileKey,
        repositoryReadbackFingerprint,
      },
    }],
    githubPublications: [{
      status: "finalized",
      handoffFingerprint,
      bindingFingerprint,
      publishApprovalFingerprint: fp("f"),
      branch: "codex/du06",
      remoteSha: commitSha,
      pullRequest: {
        number: 17,
        draft: true,
        state: "open",
        merged: false,
        head: { ref: "codex/du06", sha: commitSha },
      },
      proofSnapshotFingerprint: pullRequestReadbackFingerprint,
      linearLinkReceiptId: "linear-link-receipt",
      obsidianReceiptId: "obsidian-receipt",
    }],
    repositoryCleanups: [],
    privateBindings: [],
  };
}

function hierarchyItem(kind: string, resourceId: string, readbackFingerprint: string) {
  return {
    kind,
    status: "committed",
    resourceId,
    readbackFingerprint,
  };
}
