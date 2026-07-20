import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireE2eLock } from "./run-e2e-exclusive.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playwrightCli = path.join(
  repoRoot,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);
const testResultsRoot = path.join(repoRoot, "test-results");
const proofBase = path.join(repoRoot, ".agentic-proof");
const summaryPath = path.join(testResultsRoot, "daily-use-run-summary.json");
const MAX_PROOF_ARTIFACT_BYTES = 256 * 1024;
const allowlistedProofArtifactNames = Object.freeze([
  "daily-use-du03-checkers-fast-validation-diagnostic.json",
  "daily-use-du06-fast-validation-diagnostic.json",
  "daily-use-du06-stage-entry-proof.json",
  "daily-use-du06-cleanup-proof.json",
  "daily-use-du06-retained-linear-evidence.json",
]);

const laneDefinitions = Object.freeze({
  deterministic: {
    aiMode: "mock",
    projects: [
      "daily-use-connections",
      "daily-use-note",
      "daily-use-memory-reflex",
      "daily-use-code",
      "daily-use-linear",
      "daily-use-github",
    ],
    files: [
      "e2e/daily-use-connections.spec.ts",
      "e2e/daily-use-note.spec.ts",
      "e2e/daily-use-memory-reflex.spec.ts",
      "e2e/daily-use-code.spec.ts",
      "e2e/daily-use-linear.spec.ts",
      "e2e/daily-use-github.spec.ts",
    ],
    allowedRecordFiles: [
      "e2e/daily-use-connections.spec.ts",
      "e2e/daily-use-note.spec.ts",
      "e2e/daily-use-memory-reflex.spec.ts",
      "e2e/daily-use-code.spec.ts",
      "e2e/daily-use-linear.spec.ts",
      "e2e/daily-use-github.spec.ts",
    ],
    expectedRecords: 24,
  },
  research: {
    aiMode: "real",
    projects: ["daily-use-research"],
    files: ["e2e/daily-use-research.spec.ts"],
    grep:
      "(?:DU-02 proof-gated sourced writeback|bounded recovery changes action after a retryable owned-source failure)",
    expectedRecords: 2,
  },
  code: {
    aiMode: "real",
    projects: ["daily-use-code-live"],
    files: ["e2e/daily-use-code.spec.ts"],
    grep:
      "DU-03 protected real-model TypeScript project creation, validation, README, commit, and readback",
    expectedRecords: 1,
  },
  compound: {
    aiMode: "real",
    projects: ["daily-use-compound"],
    files: ["e2e/daily-use-compound.spec.ts"],
    grep:
      "DU-06 checkers exact-SHA lifecycle restarts, cleans disposable providers, and retains redacted Linear proof",
    expectedRecords: 1,
  },
});

const externalCredentialNames = Object.freeze([
  "E2E_LINEAR_API_KEY",
  "E2E_GITHUB_TOKEN",
  "LINEAR_LIVE_TEST_TOKEN",
  "GITHUB_LIVE_TEST_TOKEN",
]);
const modelCredentialNames = Object.freeze([
  "E2E_OLLAMA_API_KEY",
  "E2E_OPENAI_COMPATIBLE_API_KEY",
]);
const sandboxConfigurationNames = Object.freeze([
  "AGENTIC_SANDBOX_CI_LIVE",
  "AGENTIC_SANDBOX_CI_EXECUTABLE",
  "AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE",
  "AGENTIC_SANDBOX_CI_RUNTIME_DIGEST",
  "AGENTIC_SANDBOX_CI_WSL_DISTRIBUTION",
  "AGENTIC_SANDBOX_CI_RUNTIME_ROOT",
]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await verifyExactCleanSha(options.sha);
  const proofRoot = proofDirectoryForSha(options.sha);
  await prepareProofRootForLanes(proofRoot, options.lanes);

  let lock = null;
  try {
    lock = await acquireE2eLock({
      playwrightArgs: options.lanes.flatMap((lane) =>
        buildPlaywrightArgs(laneDefinitions[lane]),
      ),
    });
    console.log(
      process.env.CI
        ? "Acquired one exclusive Obsidian lock for targeted protected proof."
        : `Acquired one exclusive Obsidian lock for targeted protected proof: ${lock.lockPath}`,
    );

    const credentialFreeEnvironment = buildCredentialFreeEnvironment();
    await runNpmScript("build", credentialFreeEnvironment);
    await runNpmScript("sync:test-vault", credentialFreeEnvironment);
    await runNpmScript("e2e:preflight", credentialFreeEnvironment);
    await verifyExactCleanSha(options.sha);

    for (const lane of options.lanes) {
      await verifyExactCleanSha(options.sha);
      const definition = laneDefinitions[lane];
      console.log(`Running exact protected lane: ${lane}`);
      await resetOwnedDirectory(testResultsRoot, testResultsRoot);
      let runError = null;
      let proofError = null;
      let proofResult = null;
      try {
        await runCommand(
          process.execPath,
          [playwrightCli, "test", ...buildPlaywrightArgs(definition)],
          buildLaneEnvironment(lane, definition, options.sha),
        );
      } catch (error) {
        runError = error;
      } finally {
        try {
          proofResult = await preserveLaneProof({
            lane,
            definition,
            sha: options.sha,
            proofRoot,
          });
        } catch (error) {
          proofError = error;
        }
      }
      if (runError && proofError) {
        throw new AggregateError(
          [runError, proofError],
          `Protected lane ${lane} failed and its proof could not be preserved safely.`,
        );
      }
      if (runError) throw runError;
      if (proofError) throw proofError;
      if (!proofResult?.summaryCaptured) {
        throw new Error(
          `Protected lane ${lane} passed without a current lane-owned daily-use summary.`,
        );
      }
      await verifyExactCleanSha(options.sha);
    }
  } finally {
    await lock?.release();
  }
}

function parseArgs(args) {
  let sha = "";
  let requestedLanes = "deterministic,research,code,compound";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--sha") {
      sha = args[++index] ?? "";
      continue;
    }
    if (argument.startsWith("--sha=")) {
      sha = argument.slice("--sha=".length);
      continue;
    }
    if (argument === "--lanes") {
      requestedLanes = args[++index] ?? "";
      continue;
    }
    if (argument.startsWith("--lanes=")) {
      requestedLanes = argument.slice("--lanes=".length);
      continue;
    }
    throw new Error(`Unknown protected-runner argument: ${argument}`);
  }
  if (!/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error("--sha must be one full lowercase Git commit SHA.");
  }
  const lanes = [...new Set(requestedLanes.split(",").map((value) => value.trim()).filter(Boolean))];
  if (lanes.length === 0) throw new Error("--lanes must select at least one targeted lane.");
  for (const lane of lanes) {
    if (!(lane in laneDefinitions)) {
      throw new Error(
        `Unsupported lane ${lane}. Choose only: ${Object.keys(laneDefinitions).join(", ")}.`,
      );
    }
  }
  return { sha, lanes };
}

function buildPlaywrightArgs(definition) {
  return [
    ...definition.projects.map((project) => `--project=${project}`),
    ...(definition.grep ? [`--grep=${definition.grep}`] : []),
    ...definition.files,
  ];
}

function buildLaneEnvironment(lane, definition, sha) {
  const env = {
    ...process.env,
    E2E_PROTECTED_LOG_MODE: "1",
    E2E_AI_MODE: definition.aiMode,
    E2E_REAL_AI: definition.aiMode === "real" ? "1" : "0",
    E2E_PLAYWRIGHT_LANE: definition.projects.join(","),
    E2E_RELEASE_COMMIT_SHA: sha,
  };
  if (lane === "deterministic") {
    removeEnvironmentVariables(env, [
      ...externalCredentialNames,
      ...modelCredentialNames,
      ...sandboxConfigurationNames,
    ]);
  } else if (lane === "research") {
    removeEnvironmentVariables(env, [
      ...externalCredentialNames,
      ...sandboxConfigurationNames,
    ]);
  } else if (lane === "code") {
    removeEnvironmentVariables(env, externalCredentialNames);
  }
  return env;
}

function buildCredentialFreeEnvironment() {
  const env = {
    ...process.env,
    E2E_PROTECTED_LOG_MODE: "1",
  };
  removeEnvironmentVariables(env, [
    ...externalCredentialNames,
    ...modelCredentialNames,
  ]);
  return env;
}

function removeEnvironmentVariables(env, names) {
  for (const name of names) delete env[name];
}

async function verifyExactCleanSha(expectedSha) {
  const actualSha = (await capture("git", ["rev-parse", "HEAD"])).trim().toLowerCase();
  if (actualSha !== expectedSha) {
    throw new Error(`Checked out ${actualSha} instead of requested SHA ${expectedSha}.`);
  }
  const status = (await capture("git", ["status", "--porcelain"])).trim();
  if (status) {
    throw new Error("Protected exact-SHA proof requires a clean checkout.");
  }
}

export function proofDirectoryForSha(sha) {
  if (!/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error("Proof directory requires one full lowercase Git commit SHA.");
  }
  return path.join(proofBase, sha);
}

export function proofArtifactNamesForLane(lane) {
  if (!(lane in laneDefinitions)) {
    throw new Error(`Unknown protected proof lane: ${lane}.`);
  }
  return [
    `${lane}.json`,
    `${lane}-summary-unavailable.json`,
    ...allowlistedProofArtifactNames.map((name) => `${lane}--${name}`),
  ];
}

async function prepareProofRootForLanes(proofRoot, lanes) {
  await mkdir(proofBase, { recursive: true });
  try {
    const existing = await lstat(proofRoot);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("Protected proof root must be a regular directory.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(proofRoot, { recursive: true });
  }
  for (const lane of lanes) {
    for (const name of proofArtifactNamesForLane(lane)) {
      await rm(path.join(proofRoot, name), { force: true });
    }
  }
}

async function resetOwnedDirectory(target, allowedRoot) {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(allowedRoot);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Refusing to reset directory outside ${resolvedRoot}.`);
  }
  await rm(resolvedTarget, { recursive: true, force: true });
}

async function preserveLaneProof({ lane, definition, sha, proofRoot }) {
  const errors = [];
  let summaryCaptured = false;
  try {
    const raw = await readFile(summaryPath, "utf8");
    const payload = JSON.parse(raw);
    // Preserve a lane-owned failure summary before enforcing the pass gate so
    // a red run still leaves bounded counters and explicit proof debt. The
    // protected command remains failed below; preservation is not acceptance.
    validateDailyUseSummaryForLane(payload, lane, definition, {
      requirePassed: false,
    });
    const publicPayload = projectDailyUseSummaryForPublicProof(payload);
    await writeProofEnvelope(
      path.join(proofRoot, `${lane}.json`),
      {
        version: 1,
        kind: "daily_use_summary",
        releaseSha: sha,
        lane,
        capturedAt: new Date().toISOString(),
        payload: publicPayload,
      },
    );
    summaryCaptured = true;
    validateDailyUseSummaryForLane(payload, lane, definition);
  } catch (error) {
    if (summaryCaptured) {
      errors.push(error);
    } else {
      const reasonCode = error?.code === "ENOENT"
        ? "summary_missing"
        : "summary_invalid_or_unsafe";
      await writeProofEnvelope(
        path.join(proofRoot, `${lane}-summary-unavailable.json`),
        {
          version: 1,
          kind: "daily_use_summary_unavailable",
          releaseSha: sha,
          lane,
          capturedAt: new Date().toISOString(),
          reasonCode,
        },
      );
      if (error?.code !== "ENOENT") errors.push(error);
    }
  }

  for (const artifactName of allowlistedProofArtifactNames) {
    try {
      const matches = await findFilesNamed(testResultsRoot, artifactName);
      if (matches.length === 0) continue;
      if (matches.length !== 1) {
        throw new Error(
          `Expected at most one current ${artifactName}; found ${matches.length}.`,
        );
      }
      const sourcePath = matches[0];
      const sourceStat = await lstat(sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(`${artifactName} is not a regular non-symlink file.`);
      }
      if (sourceStat.size <= 0 || sourceStat.size > MAX_PROOF_ARTIFACT_BYTES) {
        throw new Error(
          `${artifactName} is outside the protected proof size boundary.`,
        );
      }
      const raw = await readFile(sourcePath, "utf8");
      if (containsSensitiveProofText(raw)) {
        throw new Error(
          `${artifactName} contains a credential marker, private key, or local path.`,
        );
      }
      const payload = JSON.parse(raw);
      const publicPayload = projectAllowlistedProofArtifact(
        artifactName,
        payload,
      );
      await writeProofEnvelope(
        path.join(proofRoot, `${lane}--${artifactName}`),
        {
          version: 1,
          kind: "allowlisted_redacted_daily_use_artifact",
          releaseSha: sha,
          lane,
          artifactName,
          capturedAt: new Date().toISOString(),
          payload: publicPayload,
        },
      );
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Protected lane ${lane} produced unsafe or invalid proof artifacts.`,
    );
  }
  return { summaryCaptured };
}

export function validateDailyUseSummaryForLane(
  payload,
  lane,
  definition,
  options = {},
) {
  const requirePassed = options.requirePassed !== false;
  if (!payload || typeof payload !== "object" || payload.version !== 1) {
    throw new Error(`Protected lane ${lane} produced an invalid summary version.`);
  }
  if (!Array.isArray(payload.records) || payload.records.length === 0) {
    throw new Error(`Protected lane ${lane} produced no daily-use records.`);
  }
  if (requirePassed && payload.status !== "passed") {
    throw new Error(`Protected lane ${lane} summary did not pass.`);
  }
  if (typeof payload.status !== "string" || payload.status.length === 0) {
    throw new Error(`Protected lane ${lane} summary omitted its run status.`);
  }
  if (
    Number.isSafeInteger(definition.expectedRecords) &&
    payload.records.length !== definition.expectedRecords
  ) {
    throw new Error(
      `Protected lane ${lane} produced ${payload.records.length} records; expected ${definition.expectedRecords}.`,
    );
  }
  const allowedProjects = new Set(definition.projects);
  const allowedFiles = new Set(
    (definition.allowedRecordFiles ?? definition.files).map(normalizeProofPath),
  );
  const titlePattern = definition.grep ? new RegExp(definition.grep, "u") : null;
  const projectCounts = new Map(definition.projects.map((project) => [project, 0]));
  for (const record of payload.records) {
    if (!record || typeof record !== "object") {
      throw new Error(`Protected lane ${lane} produced a malformed record.`);
    }
    if (!allowedProjects.has(record.project)) {
      throw new Error(
        `Protected lane ${lane} summary includes project ${String(record.project)}.`,
      );
    }
    projectCounts.set(record.project, (projectCounts.get(record.project) ?? 0) + 1);
    if (!allowedFiles.has(normalizeProofPath(record.file))) {
      throw new Error(
        `Protected lane ${lane} summary includes file ${String(record.file)}.`,
      );
    }
    if (titlePattern && !titlePattern.test(String(record.title ?? ""))) {
      throw new Error(
        `Protected lane ${lane} summary includes an unselected test title.`,
      );
    }
    const recordPassed = record.status === "passed";
    const recordFailed = ["failed", "timedOut", "interrupted"].includes(
      record.status,
    );
    if ((requirePassed && !recordPassed) || (!recordPassed && !recordFailed)) {
      throw new Error(
        `Protected lane ${lane} summary includes a non-passed test record.`,
      );
    }
    if (requirePassed && record.scenarioId && (
      record.acceptanceStatus !== "pass" ||
      !Array.isArray(record.missingAcceptanceCriteria) ||
      record.missingAcceptanceCriteria.length > 0
    )) {
      throw new Error(
        `Protected lane ${lane} summary includes unmet daily-use acceptance criteria.`,
      );
    }
  }
  for (const [project, count] of projectCounts) {
    if (count === 0) {
      throw new Error(
        `Protected lane ${lane} selected zero records for project ${project}.`,
      );
    }
  }
  return true;
}

export function containsSensitiveProofText(value) {
  return (
    /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|lin_api_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu.test(value) ||
    /\b[A-Za-z]:[\\/][^\r\n"']+/u.test(value) ||
    /\\\\[^\s"']+/u.test(value) ||
    /([?&](?:token|key|secret|code|state)=)(?!\[REDACTED\])[^&\s]+/iu.test(value) ||
    /https:\/\/linear\.app\//iu.test(value) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value) ||
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu.test(value) ||
    /"(?:teamId|projectId|issueId|initiativeId|workspaceId|identifier|email)"\s*:\s*"(?!\[REDACTED\]|sha256:)[^"]+"/iu.test(value)
  );
}

export function projectAllowlistedProofArtifact(artifactName, payload) {
  const record = requireProofRecord(payload, artifactName);
  if (
    artifactName === "daily-use-du03-checkers-fast-validation-diagnostic.json" ||
    artifactName === "daily-use-du06-fast-validation-diagnostic.json"
  ) {
    const expectedScenario = artifactName.startsWith("daily-use-du03-")
      ? "DU-03"
      : "DU-06";
    requireProofLiteral(record.version, 1, "diagnostic version");
    requireProofLiteral(record.scenarioId, expectedScenario, "diagnostic scenario");
    const stdout = typeof record.stdout === "string" ? record.stdout : "";
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    return {
      version: 1,
      scenarioId: expectedScenario,
      status: record.status === "unavailable" ? "unavailable" : "captured",
      stdoutPresent: stdout.length > 0,
      stderrPresent: stderr.length > 0,
      stdoutChars: boundedProofCount(stdout.length, "diagnostic stdout length"),
      stderrChars: boundedProofCount(stderr.length, "diagnostic stderr length"),
      truncated: record.truncated === true,
      redactedLines: boundedProofCount(
        record.redactedLines ?? 0,
        "diagnostic redacted line count",
      ),
    };
  }
  if (artifactName === "daily-use-du06-stage-entry-proof.json") {
    requireProofLiteral(record.version, 1, "stage proof version");
    requireProofLiteral(record.scenarioId, "DU-06", "stage proof scenario");
    const stages = Array.isArray(record.stages) ? record.stages : [];
    if (stages.length > 5) {
      throw new Error("DU-06 stage proof exceeds the bounded stage count.");
    }
    return {
      version: 1,
      scenarioId: "DU-06",
      releaseSha: requiredProofFingerprint(record.releaseSha, "release SHA", false),
      replayDetected: record.replayDetected === true,
      complete: record.complete === true,
      stages: stages.map((stage, index) => {
        const item = requireProofRecord(stage, `stage ${index + 1}`);
        const stageName = boundedPublicString(item.stage, 80);
        if (![
          "accepted_research",
          "linear_hierarchy",
          "code_execution",
          "private_github_publication",
          "reconciliation_cleanup",
        ].includes(stageName)) {
          throw new Error("DU-06 stage proof contains an unknown stage.");
        }
        return {
          version: 1,
          stage: stageName,
          restartOrdinal: boundedProofCount(
            item.restartOrdinal,
            "stage restart ordinal",
          ),
          priorStagesReverified: boundedProofCount(
            item.priorStagesReverified,
            "prior stage readback count",
          ),
          proofFingerprint: requiredProofFingerprint(
            item.proofFingerprint,
            "stage proof fingerprint",
          ),
          durableResourceFingerprint: requiredProofFingerprint(
            item.durableResourceFingerprint,
            "stage resource fingerprint",
          ),
          durableCommitOccurrenceCount: boundedProofCount(
            item.durableCommitOccurrenceCount,
            "durable commit occurrence count",
          ),
          providerResourceCardinality: boundedProofCount(
            item.providerResourceCardinality,
            "provider resource cardinality",
          ),
        };
      }),
    };
  }
  if (artifactName === "daily-use-du06-cleanup-proof.json") {
    requireProofLiteral(record.version, 1, "cleanup proof version");
    requireProofLiteral(record.scenarioId, "DU-06", "cleanup proof scenario");
    const linear = requireProofRecord(record.linear, "cleanup Linear proof");
    const github = requireProofRecord(record.github, "cleanup GitHub proof");
    const local = requireProofRecord(record.local, "cleanup local proof");
    const credentials = requireProofRecord(
      record.credentials,
      "cleanup credential proof",
    );
    return {
      version: 1,
      scenarioId: "DU-06",
      releaseSha: requiredProofFingerprint(record.releaseSha, "release SHA", false),
      status: record.status === "verified" ? "verified" : "incomplete",
      linear: {
        disposableResourceCount: boundedProofCount(
          linear.disposableResourceCount,
          "Linear disposable resource count",
        ),
        independentAbsenceReadback: linear.independentAbsenceReadback === true,
        retainedEvidencePreserved: linear.retainedEvidencePreserved === true,
      },
      github: {
        privateRepositoryAbsenceReadback:
          github.privateRepositoryAbsenceReadback === true,
        branchAbsenceReadback: github.branchAbsenceReadback === true,
        pullRequestClosedUnmergedReadback:
          github.pullRequestClosedUnmergedReadback === true,
      },
      local: {
        worktreeCapturedAfterCreation: local.worktreeCapturedAfterCreation === true,
        worktreeAbsenceReadback: local.worktreeAbsenceReadback === true,
        vaultBackupsRemoved: boundedProofCount(
          local.vaultBackupsRemoved,
          "removed vault backup count",
        ),
        vaultBackupAbsenceReadback: local.vaultBackupAbsenceReadback === true,
        fixtureRemoved: local.fixtureRemoved === true,
      },
      credentials: {
        nativeSecureStateVerified: credentials.nativeSecureStateVerified === true,
      },
      errorCount: Array.isArray(record.errors)
        ? boundedProofCount(record.errors.length, "cleanup error count")
        : 0,
    };
  }
  if (artifactName === "daily-use-du06-retained-linear-evidence.json") {
    requireProofLiteral(record.version, 1, "retained evidence version");
    requireProofLiteral(record.scenarioId, "DU-06", "retained evidence scenario");
    return {
      version: 1,
      scenarioId: "DU-06",
      releaseSha: requiredProofFingerprint(record.releaseSha, "release SHA", false),
      providerIssueFingerprint: requiredProofFingerprint(
        record.providerIssueFingerprint,
        "retained provider issue fingerprint",
      ),
      providerReadbackVerified: record.providerReadbackVerified === true,
    };
  }
  throw new Error(`Unsupported protected proof artifact ${artifactName}.`);
}

function requireProofRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireProofLiteral(value, expected, label) {
  if (value !== expected) throw new Error(`${label} is invalid.`);
}

function boundedProofCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error(`${label} is outside the protected proof boundary.`);
  }
  return value;
}

function requiredProofFingerprint(value, label, prefixed = true) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  const pattern = prefixed ? /^sha256:[a-f0-9]{64}$/u : /^[a-f0-9]{40}$/u;
  if (!pattern.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

export function projectDailyUseSummaryForPublicProof(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.records)) {
    throw new Error("Daily-use proof projection requires validated records.");
  }
  return {
    version: 1,
    status: payload.status === "passed" ? "passed" : "failed",
    records: payload.records.map((record) => ({
      version: 1,
      scenarioId: typeof record.scenarioId === "string" ? record.scenarioId : null,
      taskFamily: boundedPublicString(record.taskFamily, 80),
      project: boundedPublicString(record.project, 120),
      file: normalizeProofPath(record.file),
      title: boundedPublicString(record.title, 240),
      status: record.status === "passed" ? "passed" : "failed",
      durationMs: boundedPublicInteger(record.durationMs),
      retry: boundedPublicInteger(record.retry),
      failureCategory: record.status === "passed"
        ? null
        : boundedPublicToken(record.failureCategory ?? "unknown", 80),
      modelCalls: boundedPublicInteger(record.modelCalls),
      toolCalls: boundedPublicInteger(record.toolCalls),
      continuations: boundedPublicInteger(record.continuations),
      approvals: boundedPublicInteger(record.approvals),
      artifactProofCount: boundedPublicInteger(record.artifactProofCount),
      cleanupProofCount: boundedPublicInteger(record.cleanupProofCount),
      missingAcceptanceCriteria:
        record.status === "passed"
          ? []
          : boundedPublicTokenArray(record.missingAcceptanceCriteria, 64, 120),
      acceptanceStatus:
        record.status === "passed" && record.scenarioId
          ? "pass"
          : "needs_more_work",
      fingerprint: requiredPublicFingerprint(record.fingerprint),
    })),
  };
}

function boundedPublicString(value, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error("Daily-use proof contains an invalid bounded public string.");
  }
  return value;
}

function boundedPublicInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundedPublicToken(value, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !/^[a-z0-9:_-]+$/u.test(value)
  ) {
    throw new Error("Daily-use proof contains an invalid public token.");
  }
  return value;
}

function boundedPublicTokenArray(value, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error("Daily-use proof contains an invalid public token list.");
  }
  return [...new Set(value.map((item) => boundedPublicToken(item, maxLength)))].sort();
}

function requiredPublicFingerprint(value) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(value ?? ""))) {
    throw new Error("Daily-use proof contains an invalid fingerprint.");
  }
  return value;
}

async function findFilesNamed(root, expectedName) {
  const matches = [];
  async function visit(folder) {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name === expectedName) matches.push(candidate);
    }
  }
  await visit(root);
  return matches.sort();
}

async function writeProofEnvelope(destination, value) {
  await mkdir(path.dirname(destination), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (containsSensitiveProofText(serialized)) {
    throw new Error("Protected proof envelope contains private or credential-bearing text.");
  }
  await writeFile(destination, serialized, {
    encoding: "utf8",
    flag: "wx",
  });
}

function normalizeProofPath(value) {
  return typeof value === "string" ? value.replace(/\\/gu, "/") : "";
}

function runNpmScript(scriptName, env) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return runCommand(process.execPath, [npmExecPath, "run", scriptName], env);
  }
  if (process.platform === "win32") {
    return runCommand(process.env.ComSpec || "cmd.exe", [
      "/d",
      "/s",
      "/c",
      "npm",
      "run",
      scriptName,
    ], env);
  }
  return runCommand("npm", ["run", scriptName], env);
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const protectedLogMode = env?.E2E_PROTECTED_LOG_MODE === "1";
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: protectedLogMode
        ? ["ignore", "pipe", "pipe"]
        : "inherit",
      windowsHide: true,
    });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    if (protectedLogMode) {
      child.stdout?.on("data", (chunk) => {
        stdoutBytes = boundedByteCount(stdoutBytes, chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderrBytes = boundedByteCount(stderrBytes, chunk);
      });
    }
    child.once("error", (error) => {
      reject(protectedLogMode
        ? new Error(`Protected command could not start (${error.code ?? "spawn_error"}).`)
        : error);
    });
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(protectedLogMode
          ? `Protected command was interrupted (${signal}); stdout_bytes=${stdoutBytes}; stderr_bytes=${stderrBytes}.`
          : `${command} was interrupted by ${signal}.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(protectedLogMode
          ? `Protected command exited with code ${code ?? 1}; stdout_bytes=${stdoutBytes}; stderr_bytes=${stderrBytes}.`
          : `${command} exited with code ${code ?? 1}.`));
        return;
      }
      if (protectedLogMode) {
        console.log(
          `Protected command completed; stdout_bytes=${stdoutBytes}; stderr_bytes=${stderrBytes}.`,
        );
      }
      resolve();
    });
  });
}

function boundedByteCount(current, chunk) {
  const next = current + Buffer.byteLength(chunk);
  return Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER;
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
