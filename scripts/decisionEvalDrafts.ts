/**
 * The draft half of the Jev decision evaluation (JEV-5): whole research drafts
 * through the production claim path — the citation renderer, the claim
 * ledger, the candidate filter and `assessClaimSupportV1` — for two arms on
 * identical inputs, so a change to binding or eligibility is measured where it
 * acts rather than on pre-bound pairs.
 *
 *   npx tsx scripts/decision-eval.ts --drafts --base=<core checkout> [--judge=oracle|live] [--split=heldout] [--reps=3]
 *
 * An arm is a core source tree: `--base` is the baseline (the pinned core),
 * and this checkout is the candidate. Both are imported in one process and
 * asked case by case, interleaved, so neither arm runs on a warmer provider.
 *
 * Judges:
 * - `oracle` (no network, no cost) answers each question from the frozen
 *   label of the sentence asked about, and "insufficient" for a process
 *   sentence, which is what a judge reading "Could not verify: X" against a
 *   passage that does not say X answers (D-135). It measures the pipeline's
 *   coverage and exposure, never the judge.
 * - `live` asks the pinned Jev model with OPENROUTER_API_KEY. It is billed.
 *
 * Labels come from the frozen fixture and are never derived from either
 * arm's output. Every labeled sentence is reported, including the ones an arm
 * never extracted, never checked, or excluded, and every regression.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLAIM_DRAFT_EVAL_SET_V1,
  type ClaimDraftEvalCaseV1,
  type ClaimDraftLabelV1,
} from "../tests/fixtures/decisionEval/claimDraftEvalSet";
import type {
  DecisionClient,
  DecisionRequestV1,
  DecisionResultV1,
} from "../src/decisions/decisionClient";

type Verdict = "supported" | "contradicted" | "insufficient";

interface ArmModules {
  name: string;
  root: string;
  claimLedger: typeof import("../src/agent/claimLedger");
  bibliography: typeof import("../src/agent/citationBibliography");
  assessment: typeof import("../src/decisions/claimSupportAssessment");
  gate: typeof import("../src/decisions/claimSupportGate");
}

export async function loadArm(name: string, root: string): Promise<ArmModules> {
  const load = (relative: string) => import(pathToFileURL(join(root, relative)).href);
  return {
    name,
    root,
    claimLedger: await load("src/agent/claimLedger.ts"),
    bibliography: await load("src/agent/citationBibliography.ts"),
    assessment: await load("src/decisions/claimSupportAssessment.ts"),
    gate: await load("src/decisions/claimSupportGate.ts"),
  };
}

/** What a labeled sentence came to in one arm. */
export interface SentenceOutcome {
  caseId: string;
  match: string;
  label: ClaimDraftLabelV1;
  trap: string | null;
  extracted: boolean;
  claimId: string | null;
  deterministicStatus: string | null;
  /** The deterministic ledger asked for a repair of this sentence. */
  deterministicFlag: boolean;
  /** none: the planner did not consider it; else the finding's status. */
  check: "none" | "decided" | "abstained" | "unavailable" | "excluded";
  exclusion: string | null;
  verdict: Verdict | null;
  /** The Jev finding would repair, then hold, this sentence (Enabled). */
  jevFlag: boolean;
  sentPassages: string[];
  /** The passages the author cited in the token form of the sentence. */
  intendedPassages: string[];
  /** Every intended passage was among those sent. */
  bindingComplete: boolean | null;
}

export interface ArmRun {
  arm: string;
  caseId: string;
  rep: number;
  outcomes: SentenceOutcome[];
  calls: number;
  durationsMs: number[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  status: string;
  coverage: unknown;
  /** Extracted claims no label names: reported, never silently dropped. */
  unlabeledClaims: string[];
}

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim().toLowerCase();

function evidenceFor(item: ClaimDraftEvalCaseV1) {
  return item.sources.map((source) => ({
    id: `evidence:${source.sourceId}`,
    kind: "web_source" as const,
    title: source.title,
    url: source.url,
    sourceId: `source:${source.sourceId}`,
    passageIds: source.passages.map((passage) => passage.id),
    usableSource: true,
    summary: source.title,
    confidence: "high" as const,
  }));
}

function passagesFor(item: ClaimDraftEvalCaseV1) {
  return item.sources.flatMap((source) =>
    source.passages.map((passage) => ({ id: passage.id, text: passage.text, evidenceId: `evidence:${source.sourceId}` })),
  );
}

/** The passages cited in the token-form line holding a labeled sentence. */
function intendedPassagesFor(item: ClaimDraftEvalCaseV1, match: string): string[] {
  const line = item.draft.split("\n").find((candidate) => candidate.includes(match)) ?? "";
  return [...line.matchAll(/source:[a-z0-9]+:passage:\d+-\d+/giu)].map((found) => found[0]);
}

/** The judge's side: an answer for every question in a claim-support request. */
export type Judge = (request: DecisionRequestV1, labelFor: (claimText: string) => ClaimDraftLabelV1 | null) => Promise<DecisionResultV1>;

export function oracleJudge(): Judge {
  return async (request, labelFor) => {
    const state = request.state as { claims: Array<{ key: string; text: string }> };
    const answers: Record<string, unknown> = {};
    for (const claim of state.claims) {
      const label = labelFor(claim.text);
      if (!label) {
        answers[claim.key] = { type: "choice", choice: "supported", confidence: 0.5, probabilities: { supported: 0.5, contradicted: 0.25, insufficient: 0.25 } };
        continue;
      }
      const choice: Verdict = label === "process" ? "insufficient" : label;
      const probabilities = { supported: 0.02, contradicted: 0.02, insufficient: 0.02, [choice]: 0.96 };
      answers[claim.key] = { type: "choice", choice, confidence: 0.96, probabilities };
    }
    return {
      status: "answered",
      purpose: request.purpose,
      templateVersion: request.templateVersion,
      inputFingerprint: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
      requestedModel: "oracle",
      reportedModel: "oracle",
      responseId: null,
      answers: answers as DecisionResultV1 extends { answers: infer A } ? A : never,
      invalidAnswers: [],
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      durationMs: 0,
    } as DecisionResultV1;
  };
}

export function liveJudge(client: DecisionClient, timeoutMs: number): Judge {
  return (request) => client.decide(request, { timeoutMs });
}

export async function runArmOnCase(
  arm: ArmModules,
  item: ClaimDraftEvalCaseV1,
  judge: Judge,
  rep: number,
): Promise<ArmRun> {
  const evidence = evidenceFor(item);
  const passages = passagesFor(item);
  const draft =
    item.render === "footnotes"
      ? arm.bibliography.renderCitedNoteBodyV1({
          content: item.draft,
          evidence: evidence as never,
          now: () => new Date("2026-10-21T00:00:00.000Z"),
        }).content
      : item.draft;
  const ledger = arm.claimLedger.buildClaimLedger({
    draft,
    evidence: evidence as never,
    passages,
    prompt: item.prompt,
    forceRequire: true,
  });
  const claims = arm.gate.claimsForCandidateV1(ledger, draft);
  const labelOf = (text: string): ClaimDraftLabelV1 | null => {
    const normalized = normalize(text);
    const found = item.labels.find((label) => normalized.includes(normalize(label.match)));
    return found?.label ?? null;
  };
  let calls = 0;
  const durationsMs: number[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = 0;
  const runtime = {
    configuredMode: "enabled",
    model: "eval",
    componentMode: () => ({ mode: "enabled" }),
    records: () => [],
    async decide(_component: string, request: DecisionRequestV1) {
      calls += 1;
      const result = await judge(request, labelOf);
      durationsMs.push(result.durationMs);
      if (result.status === "answered") {
        inputTokens += result.usage?.inputTokens ?? 0;
        outputTokens += result.usage?.outputTokens ?? 0;
        costUsd = result.usage?.cost === null || result.usage?.cost === undefined || costUsd === null
          ? null
          : costUsd + result.usage.cost;
      }
      return result;
    },
  };
  // The production gate, as Enabled runs it: what it would repair (and,
  // unrepaired, hold) is what reaches or leaves the final draft.
  const outcome = await arm.gate.evaluateStagedClaimSupportV1({
    runtime: runtime as never,
    ledger: null,
    candidate: draft,
    claimLedger: ledger,
    passages,
    repairAvailable: true,
    now: () => new Date("2026-10-21T00:00:00.000Z"),
  });
  const assessment = outcome.assessment ?? {
    status: "not_applicable",
    coverage: null,
    findings: [] as Array<{ claimId: string; status: SentenceOutcome["check"]; passageIds: string[]; exclusion?: string; verdict: Verdict | null }>,
  };
  const failing = new Set<string>(
    outcome.action === "repair"
      ? outcome.tokens
          .map((token: string) => arm.claimLedger.claimIdFromGroundingToken(token))
          .filter((id: string | null): id is string => Boolean(id))
      : outcome.action === "hold"
        ? outcome.rejections.map((rejection) => rejection.claimId)
        : [],
  );
  const findingFor = new Map(assessment.findings.map((finding) => [finding.claimId, finding]));
  const deterministicFlagged = new Set(
    ledger.missing.map((token) => arm.claimLedger.claimIdFromGroundingToken(token)).filter((id): id is string => Boolean(id)),
  );
  const outcomes: SentenceOutcome[] = item.labels.map((label) => {
    const claim = ledger.claims.find((candidate) => normalize(candidate.text).includes(normalize(label.match)));
    const finding = claim ? findingFor.get(claim.id) : undefined;
    const intended = intendedPassagesFor(item, label.match);
    const sent = finding?.passageIds ?? [];
    return {
      caseId: item.id,
      match: label.match,
      label: label.label,
      trap: label.trap ?? null,
      extracted: Boolean(claim),
      claimId: claim?.id ?? null,
      deterministicStatus: claim?.status ?? null,
      deterministicFlag: claim ? deterministicFlagged.has(claim.id) : false,
      check: finding ? finding.status : "none",
      exclusion: finding?.exclusion ?? null,
      verdict: finding?.verdict ?? null,
      jevFlag: claim ? failing.has(claim.id) : false,
      sentPassages: [...sent],
      intendedPassages: intended,
      bindingComplete:
        finding && (finding.status === "decided" || finding.status === "abstained") && intended.length > 0
          ? intended.every((id) => sent.includes(id))
          : null,
    };
  });
  const unlabeledClaims = ledger.claims
    .filter((claim) => claim.status !== "exempt" || /\[(?:\^\d+|source:)/u.test(claim.text))
    .filter((claim) => !labelOf(claim.text))
    .map((claim) => claim.text.slice(0, 120));
  return {
    arm: arm.name,
    caseId: item.id,
    rep,
    outcomes,
    calls,
    durationsMs,
    inputTokens,
    outputTokens,
    costUsd,
    status: assessment.status,
    coverage: assessment.coverage,
    unlabeledClaims,
  };
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

/** Wilson score interval for k of n, 95%. */
export function wilson(k: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.96;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const percentile = (values: number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
};

export interface ArmScore {
  arm: string;
  runs: number;
  factual: number;
  unsupported: number;
  supported: number;
  process: number;
  /** Factual sentences answered by the judge (decided or abstained). */
  assessed: number;
  decided: number;
  excludedByReason: Record<string, number>;
  notConsidered: number;
  /** Unsupported sentences neither the deterministic ledger nor Jev flagged. */
  unsupportedReachingDraft: number;
  caughtByJev: number;
  caughtDeterministically: number;
  /** Supported claims flagged (Jev or deterministic): harmful. */
  harmfulOnSupported: number;
  /** Process sentences flagged (Jev or deterministic): harmful. */
  harmfulOnProcess: number;
  /** Process sentences that were sent to the judge at all: exposure. */
  processSentToJudge: number;
  bindingComplete: number;
  bindingChecked: number;
  calls: number;
  medianCallMs: number | null;
  p95CallMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  unlabeledClaims: number;
  byTrap: Record<string, { n: number; flagged: number; assessed: number }>;
}

export function scoreArm(runs: readonly ArmRun[]): ArmScore {
  const outcomes = runs.flatMap((run) => run.outcomes);
  const factual = outcomes.filter((outcome) => outcome.label !== "process");
  const unsupported = factual.filter((outcome) => outcome.label !== "supported");
  const supported = factual.filter((outcome) => outcome.label === "supported");
  const process = outcomes.filter((outcome) => outcome.label === "process");
  const flagged = (outcome: SentenceOutcome) => outcome.jevFlag || outcome.deterministicFlag;
  const excludedByReason: Record<string, number> = {};
  for (const outcome of factual) {
    if (outcome.check === "excluded") {
      const reason = outcome.exclusion ?? "unknown";
      excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
    }
  }
  const byTrap: ArmScore["byTrap"] = {};
  for (const outcome of outcomes) {
    const trap = outcome.trap ?? "none";
    const entry = (byTrap[`${trap}:${outcome.label}`] ??= { n: 0, flagged: 0, assessed: 0 });
    entry.n += 1;
    if (flagged(outcome)) entry.flagged += 1;
    if (outcome.check === "decided" || outcome.check === "abstained") entry.assessed += 1;
  }
  const durations = runs.flatMap((run) => run.durationsMs);
  const binding = factual.filter((outcome) => outcome.bindingComplete !== null);
  const costs = runs.map((run) => run.costUsd);
  return {
    arm: runs[0]?.arm ?? "",
    runs: runs.length,
    factual: factual.length,
    unsupported: unsupported.length,
    supported: supported.length,
    process: process.length,
    assessed: factual.filter((outcome) => outcome.check === "decided" || outcome.check === "abstained").length,
    decided: factual.filter((outcome) => outcome.check === "decided").length,
    excludedByReason,
    notConsidered: factual.filter((outcome) => outcome.check === "none").length,
    unsupportedReachingDraft: unsupported.filter((outcome) => !flagged(outcome)).length,
    caughtByJev: unsupported.filter((outcome) => outcome.jevFlag).length,
    caughtDeterministically: unsupported.filter((outcome) => outcome.deterministicFlag).length,
    harmfulOnSupported: supported.filter(flagged).length,
    harmfulOnProcess: process.filter(flagged).length,
    processSentToJudge: process.filter((outcome) => outcome.check === "decided" || outcome.check === "abstained").length,
    bindingComplete: binding.filter((outcome) => outcome.bindingComplete).length,
    bindingChecked: binding.length,
    calls: runs.reduce((sum, run) => sum + run.calls, 0),
    medianCallMs: percentile(durations, 0.5),
    p95CallMs: percentile(durations, 0.95),
    inputTokens: runs.reduce((sum, run) => sum + run.inputTokens, 0),
    outputTokens: runs.reduce((sum, run) => sum + run.outputTokens, 0),
    costUsd: costs.some((cost) => cost === null) ? null : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
    unlabeledClaims: runs.reduce((sum, run) => sum + run.unlabeledClaims.length, 0),
    byTrap,
  };
}

/** Sentences whose outcome got worse from baseline to candidate, rep by rep. */
export function regressions(base: readonly ArmRun[], candidate: readonly ArmRun[]): string[] {
  const key = (outcome: SentenceOutcome, rep: number) => `${outcome.caseId}|${outcome.match}|${rep}`;
  const before = new Map(base.flatMap((run) => run.outcomes.map((outcome) => [key(outcome, run.rep), outcome] as const)));
  const found: string[] = [];
  for (const run of candidate) {
    for (const outcome of run.outcomes) {
      const old = before.get(key(outcome, run.rep));
      if (!old) continue;
      const flaggedNow = outcome.jevFlag || outcome.deterministicFlag;
      const flaggedBefore = old.jevFlag || old.deterministicFlag;
      if (outcome.label === "supported" || outcome.label === "process") {
        if (flaggedNow && !flaggedBefore) found.push(`new hold on ${outcome.label}: ${outcome.caseId} "${outcome.match}" (rep ${run.rep})`);
      } else if (!flaggedNow && flaggedBefore) {
        found.push(`unsupported no longer caught: ${outcome.caseId} "${outcome.match}" (rep ${run.rep})`);
      }
      const assessedNow = outcome.check === "decided" || outcome.check === "abstained";
      const assessedBefore = old.check === "decided" || old.check === "abstained";
      if (outcome.label !== "process" && assessedBefore && !assessedNow) {
        found.push(`no longer assessed: ${outcome.caseId} "${outcome.match}" (${outcome.check}${outcome.exclusion ? `: ${outcome.exclusion}` : ""}, rep ${run.rep})`);
      }
      if (outcome.deterministicStatus !== old.deterministicStatus) {
        found.push(`deterministic status ${old.deterministicStatus} -> ${outcome.deterministicStatus}: ${outcome.caseId} "${outcome.match}" (rep ${run.rep})`);
      }
    }
  }
  return found;
}

export function fixtureFingerprint(root: string): string {
  return createHash("sha256")
    .update(readFileSync(join(root, "tests/fixtures/decisionEval/claimDraftEvalSet.ts")))
    .digest("hex");
}

export function casesFor(split: "calibration" | "heldout" | "all"): readonly ClaimDraftEvalCaseV1[] {
  return split === "all" ? CLAIM_DRAFT_EVAL_SET_V1 : CLAIM_DRAFT_EVAL_SET_V1.filter((item) => item.split === split);
}

export function describeScore(score: ArmScore): string[] {
  const pct = (k: number, n: number) => {
    const interval = wilson(k, n);
    return n === 0 ? "n/a" : `${k}/${n} (${Math.round((k / n) * 100)}%, 95% CI ${Math.round(interval![0] * 100)}–${Math.round(interval![1] * 100)}%)`;
  };
  return [
    `- Factual sentences assessed by the judge: ${pct(score.assessed, score.factual)}; decided ${score.decided}.`,
    `- Not considered: ${score.notConsidered}; excluded: ${JSON.stringify(score.excludedByReason)}.`,
    `- Unsupported reaching the draft (no flag of any kind): ${pct(score.unsupportedReachingDraft, score.unsupported)}; caught by Jev ${score.caughtByJev}, deterministically ${score.caughtDeterministically}.`,
    `- Harmful flags: supported ${pct(score.harmfulOnSupported, score.supported)}, process ${pct(score.harmfulOnProcess, score.process)}; process sentences sent to the judge ${score.processSentToJudge}/${score.process}.`,
    `- Binding: every cited passage sent for ${pct(score.bindingComplete, score.bindingChecked)} of assessed claims.`,
    `- Calls ${score.calls}, median ${score.medianCallMs ?? "n/a"} ms, p95 ${score.p95CallMs ?? "n/a"} ms, tokens ${score.inputTokens}+${score.outputTokens}, cost ${score.costUsd === null ? "not reported" : `$${score.costUsd.toFixed(5)}`}.`,
    `- Extracted claims without a label: ${score.unlabeledClaims}.`,
  ];
}
