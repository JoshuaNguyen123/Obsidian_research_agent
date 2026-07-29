/**
 * Read-only post-run verification for the disposable BYOK autonomous journey.
 *
 * The Playwright lane proves provider readbacks and cleanup before it can pass.
 * This verifier independently checks that the machine-readable report really
 * contains that passing lane, that its scorecard and evidence annotation are
 * coherent, that exact run-owned vault backups were removed, that the one
 * retained Desktop export is bounded and runnable, and that the disposable
 * GitHub repository no longer exists.
 */

import { execFile } from "node:child_process";
import {
  lstat,
  readFile,
  realpath,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const reportPath = path.join(
  repoRoot,
  "test-results",
  "playwright-execution-report.json",
);
const lane = "byok-autonomous-journey";
const expectedFiles = [
  ".gitignore",
  "README.md",
  "crdt_sync.py",
  "scripts/verify_project.py",
  "tests/test_crdt_contract.py",
];
const expectedObserved = {
  artifacts: [
    "vault:accepted_research_note",
    "linear:implementation_issue",
    "code:ide_readable_export",
    "git:verified_commit",
    "github:private_repository",
    "github:draft_pull_request",
    "vault:completion_reflection",
  ],
  proofs: [
    "research:four_distinct_sources",
    "research:accepted_lineage",
    "linear:provider_readback",
    "linear:independent_phase_b_read",
    "sandbox:production_boundary",
    "code:protected_contract",
    "validation:targeted",
    "validation:fresh_full",
    "git:neutral_identity",
    "github:private_visibility_readback",
    "github:remote_sha_readback",
    "github:single_open_draft_readback",
    "reflection:human_35_100_words",
    "graph:authoritative",
    "idempotency:no_duplicates",
    "authority:no_unapproved_mutations",
  ],
  approvals: [
    "approval:linear_issue_create",
    "authorization:sandbox_execution",
    "approval:github_private_repository_create",
    "approval:github_publish",
  ],
  bindings: [
    "binding:note_linear_issue",
    "binding:linear_commit",
    "binding:commit_pr",
    "binding:note_pr",
    "binding:desktop_commit_tree",
    "binding:durable_workspace_identity",
  ],
  cleanup: [
    "cleanup:linear_fixture",
    "cleanup:github_fixture",
    "cleanup:vault_fixture",
    "cleanup:workspace_fixture",
    "cleanup:source_fixture",
    "cleanup:independent_readback",
    "cleanup:retained_export_verified",
  ],
};

const report = JSON.parse(await readFile(reportPath, "utf8"));
const matchingTests = collectTests(report.suites).filter(
  (entry) => entry.projectName === lane,
);
requireCondition(
  matchingTests.length === 1,
  `Expected exactly one ${lane} result, found ${matchingTests.length}.`,
);
const entry = matchingTests[0];
const passedResult = [...entry.results]
  .reverse()
  .find((result) => result?.status === "passed");
requireCondition(
  entry.status === "expected" && passedResult,
  `${lane} did not finish with one expected passing result.`,
);

const annotationValues = new Map();
for (const annotation of [
  ...(entry.annotations ?? []),
  ...(passedResult.annotations ?? []),
]) {
  if (
    typeof annotation?.type !== "string" ||
    typeof annotation?.description !== "string"
  ) {
    continue;
  }
  const values = annotationValues.get(annotation.type) ?? new Set();
  values.add(annotation.description);
  annotationValues.set(annotation.type, values);
}
for (const [type, values] of annotationValues) {
  requireCondition(
    values.size === 1,
    `Conflicting ${type} annotations were reported for the BYOK lane.`,
  );
}
const annotations = new Map(
  [...annotationValues].map(([type, values]) => [type, [...values][0]]),
);
const scorecard = JSON.parse(
  requireAnnotation(annotations, "daily-use-scorecard-v1"),
);
requireCondition(
  scorecard?.version === 1 &&
    scorecard.acceptancePassed === true,
  "The BYOK daily-use scorecard did not pass production acceptance.",
);
const phaseAScorecard = parsePhaseScorecard(
  requireAnnotation(
    annotations,
    "byok-phase-a-production-scorecard-v1",
  ),
  "A",
  "accepted_research_to_linear",
);
const phaseBScorecard = parsePhaseScorecard(
  requireAnnotation(
    annotations,
    "byok-phase-b-production-scorecard-v1",
  ),
  "B",
  "linear_to_tested_code_github_and_reflection",
);
requireCondition(
  phaseAScorecard.runId !== phaseBScorecard.runId,
  "Phase A and Phase B scorecards came from the same runtime-ledger run.",
);
requireCondition(
  phaseAScorecard.providerUsage.terminalUsageScopeId !==
    phaseBScorecard.providerUsage.terminalUsageScopeId,
  "Phase A and Phase B reused one coordinator provider-usage scope.",
);
requireCondition(
  JSON.stringify(scorecard) === JSON.stringify(phaseBScorecard.scorecard),
  "The daily-use scorecard is not the exact Phase B production scorecard.",
);

const metrics = JSON.parse(
  requireAnnotation(annotations, "daily-use-metrics-v1"),
);
requireCondition(
  metrics?.version === 1 &&
    metrics.scenarioId === "BYOK-01" &&
    metrics.acceptanceStatus === "pass" &&
    Array.isArray(metrics.missingAcceptanceCriteria) &&
    metrics.missingAcceptanceCriteria.length === 0,
  "The BYOK daily-use metrics do not represent complete runtime acceptance.",
);
requireCondition(
  metrics.approvalBoundaryProofCount === 4,
  `Expected four fingerprint-bound approval or host-authorization proofs, observed ${String(
    metrics.approvalBoundaryProofCount,
  )}.`,
);
requireCondition(
  metrics.modelCalls ===
    phaseAScorecard.providerUsage.modelCallCount +
      phaseBScorecard.providerUsage.modelCallCount,
  "The daily-use model-call total does not reconcile to both phase scope manifests.",
);
const observed = JSON.parse(
  requireAnnotation(annotations, "daily-use-observed-v1"),
);
for (const [category, expectedTokens] of Object.entries(expectedObserved)) {
  requireCondition(
    sameStringSet(observed?.[category], expectedTokens),
    `The BYOK runtime ${category} observations are incomplete or overclaimed.`,
  );
}
const githubAuthority = JSON.parse(
  requireAnnotation(annotations, "byok-github-cleanup-authority-v1"),
);
requireCondition(
  githubAuthority?.version === 1 &&
    Number.isSafeInteger(githubAuthority.actorId) &&
    githubAuthority.actorId > 0 &&
    typeof githubAuthority.actorLogin === "string" &&
    githubAuthority.actorLogin.trim().length > 0 &&
    Number.isSafeInteger(githubAuthority.repositoryId) &&
    githubAuthority.repositoryId > 0 &&
    typeof githubAuthority.repository === "string" &&
    githubAuthority.private === true &&
    githubAuthority.admin === true,
  "The pre-delete GitHub authority attestation is invalid.",
);
const githubCleanup = JSON.parse(
  requireAnnotation(annotations, "byok-github-cleanup-v1"),
);
requireCondition(
  githubCleanup?.version === 1 &&
    githubCleanup.actorId === githubAuthority.actorId &&
    String(githubCleanup.actorLogin).toLowerCase() ===
      githubAuthority.actorLogin.toLowerCase() &&
    githubCleanup.repositoryId === githubAuthority.repositoryId &&
    String(githubCleanup.repository).toLowerCase() ===
      githubAuthority.repository.toLowerCase() &&
    githubCleanup.state === "absent" &&
    Array.isArray(githubCleanup.repositories) &&
    githubCleanup.repositories.length > 0 &&
    new Set(githubCleanup.repositories).size ===
      githubCleanup.repositories.length,
  "The post-delete GitHub cleanup manifest is invalid or drifted.",
);
const vaultBackupCleanup = JSON.parse(
  requireAnnotation(annotations, "byok-vault-backup-cleanup-v1"),
);
requireCondition(
  vaultBackupCleanup?.version === 1 &&
    /^E2E Agent Tests\/BYOK-AUTONOMOUS-[a-f0-9]{12}\.md$/u.test(
      vaultBackupCleanup.notePath,
    ) &&
    Number.isSafeInteger(vaultBackupCleanup.baselineCount) &&
    vaultBackupCleanup.baselineCount >= 0 &&
    vaultBackupCleanup.baselineCount <= 10_000 &&
    Array.isArray(vaultBackupCleanup.selectedPaths) &&
    vaultBackupCleanup.selectedPaths.length > 0 &&
    vaultBackupCleanup.selectedPaths.length <= 64 &&
    new Set(vaultBackupCleanup.selectedPaths).size ===
      vaultBackupCleanup.selectedPaths.length &&
    vaultBackupCleanup.removed === vaultBackupCleanup.selectedPaths.length &&
    Array.isArray(vaultBackupCleanup.survivors) &&
    vaultBackupCleanup.survivors.length === 0 &&
    vaultBackupCleanup.absenceVerified === true,
  "The exact post-baseline vault backup cleanup proof is invalid.",
);
const workspaceMetadataCleanup = JSON.parse(
  requireAnnotation(annotations, "byok-workspace-metadata-cleanup-v1"),
);
requireCondition(
  workspaceMetadataCleanup?.version === 1 &&
    workspaceMetadataCleanup.repositoryRootAbsent === true &&
    Array.isArray(workspaceMetadataCleanup.selectedWorkspaceIds) &&
    workspaceMetadataCleanup.selectedWorkspaceIds.length === 1 &&
    /^run-/u.test(workspaceMetadataCleanup.selectedWorkspaceIds[0]) &&
    Array.isArray(workspaceMetadataCleanup.removedMetadataContainers) &&
    workspaceMetadataCleanup.removedMetadataContainers.length === 1 &&
    Array.isArray(workspaceMetadataCleanup.worktreeAbsence) &&
    workspaceMetadataCleanup.worktreeAbsence.length === 1 &&
    workspaceMetadataCleanup.worktreeAbsence[0]?.absent === true &&
    Array.isArray(workspaceMetadataCleanup.survivingWorkspaceIds) &&
    workspaceMetadataCleanup.survivingWorkspaceIds.length === 0 &&
    workspaceMetadataCleanup.selectedSurvivorCount === 0 &&
    workspaceMetadataCleanup.absenceVerified === true,
  "The exact disposable workspace metadata cleanup proof is invalid.",
);

const evidence = parseJourneyEvidence(
  requireAnnotation(annotations, "byok-autonomous-journey"),
);
requireCondition(
  evidence.sources >= 4,
  `Deep research recorded only ${evidence.sources} distinct sources.`,
);
requireCondition(
  evidence.researchVia === "owned-fixture",
  "Research did not use the lane's owned source fixture.",
);
requireCondition(
  evidence.reflectionWords >= 35 && evidence.reflectionWords <= 100,
  `Reflection length ${evidence.reflectionWords} is outside 35-100 words.`,
);
requireCondition(
  evidence.pullRequest.startsWith(`${evidence.repository}/pull/`),
  "The pull request is not bound to the reported disposable repository.",
);
const evidenceRepositoryName = new URL(evidence.repository).pathname
  .split("/")
  .filter(Boolean)
  .join("/");
requireCondition(
  evidenceRepositoryName.toLowerCase() ===
    githubAuthority.repository.toLowerCase(),
  "Journey evidence drifted from the pre-delete repository attestation.",
);

const exportAnnotation = requireAnnotation(
  annotations,
  "retained-desktop-export",
);
requireCondition(
  path.resolve(exportAnnotation) === path.resolve(evidence.exportPath),
  "The retained export annotation drifted from the journey evidence.",
);
const rawExportInfo = await lstat(evidence.exportPath);
requireCondition(
  rawExportInfo.isDirectory() && !rawExportInfo.isSymbolicLink(),
  "The retained export path is not a normal directory.",
);
const canonicalExport = await realpath(evidence.exportPath);
requireCondition(
  (await lstat(canonicalExport)).isDirectory(),
  "The retained export is not a directory.",
);
const desktopRoots = await existingDesktopRoots();
requireCondition(
  desktopRoots.some((root) => isStrictDescendant(root, canonicalExport)),
  `The retained export escaped the user's Desktop roots: ${canonicalExport}`,
);
requireCondition(
  /^merge-requested-python-library-[a-z0-9]{1,12}$/u.test(
    path.basename(canonicalExport),
  ),
  "The retained export name is not bound to the BYOK host export convention.",
);

const exportedFiles = await listRelativeFiles(canonicalExport);
requireCondition(
  JSON.stringify(exportedFiles) === JSON.stringify(expectedFiles),
  `Retained export file set drifted: ${exportedFiles.join(", ")}`,
);
const repositorySuffix = new URL(evidence.repository).pathname
  .split("/")
  .filter(Boolean)
  .at(-1)
  ?.match(/^e2e-byok-autonomous-([a-f0-9]{12})$/u)?.[1];
requireCondition(
  typeof repositorySuffix === "string",
  "The disposable repository name does not carry the bounded journey suffix.",
);
const marker = `BYOK_AUTONOMOUS_${repositorySuffix}`;
const expectedNotePath =
  `E2E Agent Tests/BYOK-AUTONOMOUS-${repositorySuffix}.md`;
requireCondition(
  vaultBackupCleanup.notePath === expectedNotePath,
  "The vault backup cleanup note drifted from the retained journey suffix.",
);
const expectedBackupPrefix =
  `.agent-backups/BYOK-AUTONOMOUS-${repositorySuffix}.`;
for (const backupPath of vaultBackupCleanup.selectedPaths) {
  requireCondition(
    backupPath.startsWith(expectedBackupPrefix) &&
      new RegExp(
        `^${escapeRegExp(expectedBackupPrefix)}` +
          String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.[a-f0-9]{12}(?:\.[1-9]\d*)?\.backup\.md$`,
        "u",
      ).test(backupPath),
    `The vault backup cleanup manifest contains an unscoped path: ${backupPath}.`,
  );
}
for (const relativePath of [
  "README.md",
  "crdt_sync.py",
  "tests/test_crdt_contract.py",
]) {
  const content = await readFile(path.join(canonicalExport, relativePath), "utf8");
  requireCondition(
    content.includes(marker),
    `${relativePath} does not carry the exact journey marker.`,
  );
}

const verification = await execFileAsync(
  "python",
  ["scripts/verify_project.py"],
  {
    cwd: canonicalExport,
    windowsHide: true,
    timeout: 120_000,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  },
);
requireCondition(
  /\bOK\b/u.test(`${verification.stdout}\n${verification.stderr}`),
  "Retained project verification exited without the unittest success marker.",
);

const { stdout: ghActorJson } = await execFileAsync("gh", ["api", "user"], {
  windowsHide: true,
  timeout: 60_000,
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});
const ghActor = JSON.parse(ghActorJson);
requireCondition(
  Number(ghActor?.id) === githubAuthority.actorId &&
    String(ghActor?.login ?? "").toLowerCase() ===
      githubAuthority.actorLogin.toLowerCase(),
  "The active gh identity drifted from the actor that attested the private repository.",
);
const [owner, mainRepository] = githubAuthority.repository.split("/");
requireCondition(
  Boolean(owner) &&
    Boolean(mainRepository) &&
    owner.toLowerCase() === githubAuthority.actorLogin.toLowerCase() &&
    githubCleanup.repositories.includes(mainRepository),
  "The cleanup manifest omitted the exact attested repository.",
);
for (const repository of githubCleanup.repositories) {
  requireCondition(
    repository === mainRepository
      ? /^e2e-byok-autonomous-[a-f0-9]{12}$/u.test(repository)
      : /^e2e-delete-probe-[a-f0-9]{12}$/u.test(repository),
    `The cleanup manifest contains an unscoped repository: ${repository}.`,
  );
  let repositoryCleanupVerified = false;
  try {
    await execFileAsync("gh", ["api", `repos/${owner}/${repository}`], {
      windowsHide: true,
      timeout: 60_000,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const output = [
      error?.message,
      error?.stdout,
      error?.stderr,
    ].filter(Boolean).join("\n");
    repositoryCleanupVerified = /\bHTTP 404\b|\b404 Not Found\b/iu.test(output);
  }
  requireCondition(
    repositoryCleanupVerified,
    `Disposable GitHub repository ${owner}/${repository} still exists or was not proven absent under the attested actor.`,
  );
}

console.log(
  [
    `Verified ${lane}.`,
    `model=${evidence.model}`,
    `commit=${evidence.commit}`,
    `sources=${evidence.sources}`,
    `reflectionWords=${evidence.reflectionWords}`,
    `export=${canonicalExport}`,
    "githubCleanup=verified",
    "vaultBackupCleanup=verified",
    "workspaceMetadataCleanup=verified",
    "retainedProjectTests=passed",
  ].join(" "),
);

function collectTests(suites = []) {
  const collected = [];
  const visit = (suite) => {
    for (const spec of suite?.specs ?? []) {
      for (const test of spec?.tests ?? []) {
        collected.push({
          ...test,
          annotations: test.annotations ?? [],
          results: test.results ?? [],
        });
      }
    }
    for (const child of suite?.suites ?? []) visit(child);
  };
  for (const suite of suites ?? []) visit(suite);
  return collected;
}

function requireAnnotation(annotations, type) {
  const value = annotations.get(type);
  requireCondition(
    typeof value === "string" && value.trim().length > 0,
    `Missing ${type} annotation.`,
  );
  return value.trim();
}

function parseJourneyEvidence(value) {
  const match = value.match(
    /^model=(\S+) linear=(\S+) repository=(\S+) pullRequest=(\S+) commit=([a-f0-9]{40}) export=(.+?) sources=(\d+) researchVia=(\S+) reflectionWords=(\d+)$/u,
  );
  requireCondition(Boolean(match), "The BYOK journey evidence annotation is invalid.");
  return {
    model: match[1],
    linear: match[2],
    repository: match[3],
    pullRequest: match[4],
    commit: match[5],
    exportPath: match[6],
    sources: Number.parseInt(match[7], 10),
    researchVia: match[8],
    reflectionWords: Number.parseInt(match[9], 10),
  };
}

function parsePhaseScorecard(value, expectedPhase, expectedScope) {
  const parsed = JSON.parse(value);
  requireCondition(
    parsed?.version === 1 &&
      parsed.phase === expectedPhase &&
      parsed.scope === expectedScope &&
      typeof parsed.runId === "string" &&
      parsed.runId.trim().length > 0 &&
      parsed.scorecard?.version === 1 &&
      parsed.scorecard.acceptancePassed === true,
    `Phase ${expectedPhase} production scorecard annotation is invalid.`,
  );
  validatePhaseProviderUsage(parsed.providerUsage, expectedPhase);
  return parsed;
}

function validatePhaseProviderUsage(value, expectedPhase) {
  const scopes = value?.usageScopes;
  requireCondition(
    value?.version === 1 &&
      Number.isSafeInteger(value.modelCallCount) &&
      value.modelCallCount > 0 &&
      Array.isArray(scopes) &&
      scopes.length > 0 &&
      typeof value.terminalUsageScopeId === "string" &&
      value.terminalUsageScopeId.trim().length > 0 &&
      Number.isSafeInteger(value.terminalCoordinatorModelCalls) &&
      value.terminalCoordinatorModelCalls > 0 &&
      Number.isSafeInteger(value.finalSegmentModelCalls) &&
      value.finalSegmentModelCalls > 0,
    `Phase ${expectedPhase} provider-usage proof is invalid.`,
  );
  const scopeIds = scopes.map((scope) => scope?.usageScopeId);
  requireCondition(
    scopes.every(
      (scope) =>
        typeof scope?.usageScopeId === "string" &&
        scope.usageScopeId.trim().length > 0 &&
        Number.isSafeInteger(scope.modelCalls) &&
        scope.modelCalls > 0,
    ) && new Set(scopeIds).size === scopeIds.length,
    `Phase ${expectedPhase} provider-usage scopes are invalid or duplicated.`,
  );
  requireCondition(
    scopes.reduce((total, scope) => total + scope.modelCalls, 0) ===
      value.modelCallCount,
    `Phase ${expectedPhase} provider-usage scopes do not sum to the phase total.`,
  );
  const terminalScope = scopes.find(
    (scope) => scope.usageScopeId === value.terminalUsageScopeId,
  );
  requireCondition(
    terminalScope?.modelCalls === value.terminalCoordinatorModelCalls,
    `Phase ${expectedPhase} terminal coordinator usage does not match its scope.`,
  );
  requireCondition(
    value.finalSegmentModelCalls <= value.terminalCoordinatorModelCalls,
    `Phase ${expectedPhase} final Lead segment exceeds its coordinator usage.`,
  );
}

function sameStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.every((value) => typeof value === "string") &&
    JSON.stringify([...new Set(actual)].sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function existingDesktopRoots() {
  const candidates = [
    process.env.OneDrive?.trim()
      ? path.join(process.env.OneDrive.trim(), "Desktop")
      : null,
    path.join(os.homedir(), "OneDrive", "Desktop"),
    path.join(os.homedir(), "Desktop"),
  ].filter(Boolean);
  const roots = [];
  for (const candidate of new Set(candidates)) {
    try {
      roots.push(await realpath(candidate));
    } catch {
      // A workstation commonly has only one of the candidate Desktop roots.
    }
  }
  return roots;
}

function isStrictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function listRelativeFiles(root) {
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolute).replace(/\\/gu, "/"));
      } else {
        throw new Error(`Unexpected retained export entry: ${absolute}`);
      }
    }
  };
  await visit(root);
  return files.sort();
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
