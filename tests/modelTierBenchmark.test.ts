import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertBenchmarkExactCleanHead,
  BENCHMARK_EVIDENCE_MISSING_FAILURE_CLASS,
  BENCHMARK_PROOF_POLICY_CONTRACT,
  BENCHMARK_PROOF_POLICY_SCORECARD,
  createBenchmarkPlan,
  describeMissingBenchmarkEvidence,
  hasAcceptedBenchmarkEvidence,
  hasFreshPassingProjectSummary,
  parseBenchmarkOptions,
  resolveBenchmarkProofPolicy,
} from "../scripts/run-model-tier-benchmark.mjs";

test("model benchmark pins the exact clean HEAD before spending a provider call", () => {
  const expectedHead = "a".repeat(40);
  const cleanGit = (args: string[]) => args[0] === "rev-parse" ? expectedHead : "";
  assert.doesNotThrow(() => assertBenchmarkExactCleanHead(expectedHead, cleanGit, "pre"));

  const dirtyGit = (args: string[]) =>
    args[0] === "rev-parse" ? expectedHead : " M scripts/run-model-tier-benchmark.mjs";
  assert.throws(
    () => assertBenchmarkExactCleanHead(expectedHead, dirtyGit, "pre"),
    /working tree is not clean/u,
  );

  const driftedGit = (args: string[]) => args[0] === "rev-parse" ? "b".repeat(40) : "";
  assert.throws(
    () => assertBenchmarkExactCleanHead(expectedHead, driftedGit, "post"),
    /HEAD b{40} != pinned a{40}/u,
  );
});

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(repoRoot, "scripts", "run-model-tier-benchmark.mjs");

test("dry-run executes real code and reports a non-vacuous plan", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--dry-run",
      "--model=glm-5.3-flash:cloud",
      "--cells=research-current-note,vault-recall",
      "--attempts=2",
    ],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /glm-5\.3-flash:cloud × research-current-note/u);
  assert.match(result.stdout, /glm-5\.3-flash:cloud × vault-recall/u);
  assert.match(result.stdout, /planned=4 launched=0 recorded=0/u);
});

test("CLI rejects empty or misspelled selections instead of exiting green", () => {
  for (const args of [
    ["--dry-run", "--models=,"],
    ["--dry-run", "--cells=not-a-real-cell"],
    ["--dry-rnu"],
  ]) {
    const result = spawnSync(process.execPath, [runner, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed`);
    assert.match(result.stderr, /model-tier-benchmark/u);
  }
});

test("model selection is explicit, ordered, and mutually exclusive", () => {
  assert.deepEqual(parseBenchmarkOptions(["--model=kimi-k3:cloud"]).models, [
    "kimi-k3:cloud",
  ]);
  assert.deepEqual(
    parseBenchmarkOptions(["--models=glm-5.3-flash:cloud,glm-5.3:cloud"]).models,
    ["glm-5.3-flash:cloud", "glm-5.3:cloud"],
  );
  assert.throws(
    () => parseBenchmarkOptions(["--model=a", "--models=b,c"]),
    /either --model or --models/u,
  );
});

test("plan cardinality equals models times cells times attempts", () => {
  const options = parseBenchmarkOptions([
    "--models=glm-5.3-flash:cloud,glm-5.3:cloud",
    "--cells=research-current-note,vault-recall,code-delivery",
    "--attempts=2",
  ]);
  const plan = createBenchmarkPlan(options);
  assert.equal(plan.length, 12);
  assert.deepEqual(
    plan.slice(0, 3).map((entry) => [entry.model, entry.cell.id, entry.attempt]),
    [
      ["glm-5.3-flash:cloud", "research-current-note", 1],
      ["glm-5.3-flash:cloud", "research-current-note", 2],
      ["glm-5.3-flash:cloud", "vault-recall", 1],
    ],
  );
});

test("scored exit zero is green only with fresh accepted scorecard evidence", () => {
  const accepted = {
    acceptanceStatus: "pass",
    scorecardAcceptancePassed: true,
    scorecardTotal: 0.91,
  };
  assert.equal(
    hasAcceptedBenchmarkEvidence({ exitCode: 0, summaryFresh: true, acceptance: accepted }),
    true,
  );
  assert.equal(
    hasAcceptedBenchmarkEvidence({ exitCode: 0, summaryFresh: false, acceptance: accepted }),
    false,
  );
  assert.equal(
    hasAcceptedBenchmarkEvidence({
      exitCode: 0,
      summaryFresh: true,
      acceptance: { ...accepted, scorecardAcceptancePassed: false },
    }),
    false,
  );
  assert.equal(
    hasAcceptedBenchmarkEvidence({ exitCode: 1, summaryFresh: true, acceptance: accepted }),
    false,
  );
});

test("scorecard-exempt contract lanes use fresh passing execution proof", () => {
  assert.equal(resolveBenchmarkProofPolicy("daily-use-research"), BENCHMARK_PROOF_POLICY_SCORECARD);
  assert.equal(resolveBenchmarkProofPolicy("real-ai-soak"), BENCHMARK_PROOF_POLICY_CONTRACT);
  assert.equal(
    resolveBenchmarkProofPolicy("desktop-code-delivery-real-live"),
    BENCHMARK_PROOF_POLICY_CONTRACT,
  );

  const summary = {
    records: [
      { project: "real-ai-soak", status: "passed" },
      { project: "another-project", status: "failed" },
    ],
  };
  assert.equal(hasFreshPassingProjectSummary(summary, true, "real-ai-soak"), true);
  assert.equal(hasFreshPassingProjectSummary(summary, false, "real-ai-soak"), false);
  assert.equal(hasFreshPassingProjectSummary(summary, true, "missing-project"), false);
  assert.equal(
    hasAcceptedBenchmarkEvidence({
      exitCode: 0,
      summaryFresh: true,
      acceptance: {
        acceptanceStatus: "needs_more_work",
        scorecardAcceptancePassed: null,
        scorecardTotal: null,
      },
      proofPolicy: BENCHMARK_PROOF_POLICY_CONTRACT,
      contractEvidencePassed: true,
    }),
    true,
  );
  assert.equal(
    hasAcceptedBenchmarkEvidence({
      exitCode: 0,
      summaryFresh: true,
      acceptance: {},
      proofPolicy: BENCHMARK_PROOF_POLICY_CONTRACT,
      contractEvidencePassed: false,
    }),
    false,
  );
});

test("missing-evidence diagnostics name every absent proof field", () => {
  assert.equal(
    BENCHMARK_EVIDENCE_MISSING_FAILURE_CLASS,
    "harness:benchmark_evidence_missing",
  );
  assert.match(
    describeMissingBenchmarkEvidence({
      summaryFresh: false,
      acceptance: {
        acceptanceStatus: "needs_more_work",
        scorecardAcceptancePassed: false,
        scorecardTotal: null,
      },
    }),
    /fresh run summary, acceptanceStatus=pass, scorecardAcceptancePassed=true, finite scorecardTotal/u,
  );
});

test("contract-lane diagnostics name missing execution proof instead of an absent scorecard", () => {
  assert.equal(
    describeMissingBenchmarkEvidence({
      summaryFresh: false,
      acceptance: {},
      proofPolicy: BENCHMARK_PROOF_POLICY_CONTRACT,
      contractEvidencePassed: false,
    }),
    "fresh run summary, passing project execution record",
  );
});
