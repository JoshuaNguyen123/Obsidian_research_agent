/**
 * Jev decision evaluation: baseline, calibration, held-out comparison, and
 * promotion gates for the two independently promoted components.
 *
 *   npx tsx scripts/decision-eval.ts                      # offline baseline only
 *   npx tsx scripts/decision-eval.ts --live --split=calibration
 *   npx tsx scripts/decision-eval.ts --live --split=heldout
 *
 * Live runs read the OpenRouter credential from OPENROUTER_API_KEY (never from
 * a vault) and call the pinned model. Reports land in docs/eval/decisions/
 * (gitignored): one JSON with every raw answer and one Markdown summary.
 *
 * Discipline: thresholds may be changed only after a calibration run; the
 * held-out split is scored with the frozen template and thresholds, and a
 * failed gate leaves that component in Shadow (src/decisions/decisionSettings
 * DECISION_PROMOTION_MANIFEST_V1). Never weaken a gate or a label to pass.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildResearchEffortAssistForEval,
  buildResearchModeAssistForEval,
  classifyMissionIntent,
  decisionLexicalEvidenceNeedsV1,
  decisionMutationFootprintV1,
  isDecisionEligibleRoutingPromptV1,
} from "../src/AgentRunner";
import { deriveRoutedIntentFallback } from "../src/agent/policyEngine";
import { classifyMissionWithModelDetailed } from "../src/agent/missionRouter";
import { OllamaClient } from "../src/model/OllamaClient";
import { OpenAICompatibleClient } from "../src/model/OpenAICompatibleClient";
import type { ModelClient } from "../src/model/types";
import {
  hasExplicitNoWebIntent,
  hasExplicitSingleWebFetchOnlyIntent,
  hasPrimaryTextCitationIntent,
  requiresVaultEvidenceProof,
  requiresWebEvidenceProof,
} from "../src/agent/evidenceIntent";
import { hasExplicitNoVaultReadIntent } from "../src/agent/missionScope";
import {
  createResearchPlan,
  createResearchPlanWithAssist,
  parseExplicitResearchSourceCount,
  type ResearchMode,
} from "../src/agent/researchPlan";
import {
  DECISION_CLASSIFICATION_TIMEOUT_MS_V1,
  DECISION_VERIFICATION_TIMEOUT_MS_V1,
  JEV_DECISION_MODEL_V1,
  createOpenRouterDecisionClientV1,
} from "../src/decisions/decisionClient";
import type { HttpRequest, HttpResponse } from "../src/model/types";
import {
  MISSION_DECISION_TEMPLATE_VERSION_V1,
  MISSION_DECISION_THRESHOLDS_V1,
  buildMissionDecisionRequestV1,
  decideEvidenceContractV1,
  interpretMissionDecisionV1,
  type MissionDecisionAssessmentV1,
  type MutationFootprintV1,
} from "../src/decisions/missionDecisionAssessment";
import {
  MISSION_DECISION_EVAL_SET_V1,
  type MissionDecisionEvalCaseV1,
} from "../tests/fixtures/decisionEval/missionDecisionEvalSet";
import {
  CLAIM_SUPPORT_EVAL_SET_V1,
  type ClaimSupportEvalCaseV1,
} from "../tests/fixtures/decisionEval/claimSupportEvalSet";
import {
  CLAIM_SUPPORT_TEMPLATE_VERSION_V1,
  CLAIM_SUPPORT_THRESHOLDS_V1,
  buildClaimSupportRequestV1,
  interpretClaimSupportAnswersV1,
  type ClaimSupportCheckV1,
} from "../src/decisions/claimSupportAssessment";

type Split = "calibration" | "heldout";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/u, "").split("=");
    return [key!, value ?? "true"] as const;
  }),
);
const live = args.get("live") === "true";
const split = (args.get("split") ?? "calibration") as Split;
const outDir = join(process.cwd(), "docs", "eval", "decisions");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");

/* ------------------------------------------------------------------ */
/* Mission decisions                                                   */
/* ------------------------------------------------------------------ */

interface MissionDecisionSet {
  web: boolean;
  vault: boolean;
  researchMode: ResearchMode;
  route: string;
}

/** The exact footprint the runner compares before applying a clause. */
function footprint(prompt: string): MutationFootprintV1 {
  return decisionMutationFootprintV1(prompt, true);
}

/** Today's deterministic path: what the host decides with no model at all. */
function baselineDecisions(prompt: string): MissionDecisionSet {
  const intent = classifyMissionIntent(prompt, { hasActiveMarkdownNote: true });
  const web = requiresWebEvidenceProof(prompt, intent);
  const vault = requiresVaultEvidenceProof(prompt, intent);
  const plan = createResearchPlan({
    prompt,
    missionIntent: intent,
    runPlan: {
      route: web ? "grounded_workflow" : "single_model_writeback",
      slowPathReason: web ? "needs_web_sources" : "none",
    },
  });
  const route = deriveRoutedIntentFallback({
    missionIntent: intent,
    writeAutonomy: intent.allowAutonomousWrite,
    writeToolExposed: false,
    prompt,
  }).mode;
  return { web, vault, researchMode: plan?.mode ?? "none", route };
}

/**
 * Whether the runner would ask about this prompt at all: the same rule
 * (`isDecisionEligibleRoutingPromptV1`) the runner applies, so direct chat and
 * the cue-less target-only write fast path stay at zero calls here too.
 */
function wouldAsk(prompt: string): boolean {
  return isDecisionEligibleRoutingPromptV1(prompt);
}

/**
 * The combined system with the decision model Enabled: decided fields act
 * (through the same evidence contract the runner applies), abstained or
 * unavailable fields keep the baseline decision. A prompt the runner would
 * not ask about keeps the baseline in full.
 */
function combinedDecisions(
  prompt: string,
  assessment: MissionDecisionAssessmentV1 | null,
): MissionDecisionSet & { contractReason: string; effectivePrompt: string } {
  const base = baselineDecisions(prompt);
  if (!assessment) return { ...base, contractReason: "not_asked", effectivePrompt: prompt };
  const contract = decideEvidenceContractV1({
    prompt,
    assessment,
    lexical: decisionLexicalEvidenceNeedsV1(prompt, true),
    mutationFootprint: footprint,
  });
  const effectivePrompt = contract.prompt;
  const after = baselineDecisions(effectivePrompt);
  const researchMode =
    assessment.researchMode.status === "decided" && after.researchMode === "none"
      ? assessment.researchMode.value!
      : after.researchMode;
  const route = assessment.route.status === "decided" ? assessment.route.value! : after.route;
  return { ...after, researchMode, route, contractReason: contract.reason, effectivePrompt };
}

/**
 * A perfect decision model's answer for a labeled case, at confident
 * probabilities. Used only for the offline ceiling: it measures what the
 * host's application path (eligibility, evidence clause, constraint and
 * mutation refusals) can deliver, never what Jev delivers.
 */
function oracleAssessment(item: MissionDecisionEvalCaseV1): MissionDecisionAssessmentV1 {
  const noul = (yes: boolean) => ({ type: "noul" as const, noul: yes ? 0.99 : 0.01 });
  const choice = (value: string) => ({
    type: "choice" as const,
    choice: value,
    confidence: 0.97,
    probabilities: { [value]: 0.97, other: 0.03 },
  });
  return interpretMissionDecisionV1({
    status: "answered",
    purpose: "mission_assessment",
    templateVersion: MISSION_DECISION_TEMPLATE_VERSION_V1,
    inputFingerprint: `oracle:${item.id}`,
    requestedModel: JEV_DECISION_MODEL_V1,
    reportedModel: JEV_DECISION_MODEL_V1,
    responseId: null,
    answers: {
      route: item.labels.route ? choice(item.labels.route) : null,
      web_evidence: noul(item.labels.webEvidence),
      vault_evidence: noul(item.labels.vaultEvidence),
      research_mode: choice(item.labels.researchMode),
      effort_tier: null,
      risk: null,
      freshness: null,
    },
    invalidAnswers: [],
    usage: null,
    durationMs: 0,
  } as never);
}

/**
 * Evidence-decision errors: the gate metric. Web and vault evidence needs are
 * decided deterministically in production today, so the offline baseline is
 * exactly what ships.
 */
function missionErrors(item: MissionDecisionEvalCaseV1, decided: MissionDecisionSet): string[] {
  const errors: string[] = [];
  if (decided.web !== item.labels.webEvidence) errors.push("web");
  if (decided.vault !== item.labels.vaultEvidence) errors.push("vault");
  return errors;
}

/**
 * Route and research mode are decided by model calls in production (the
 * structured router and the utility-model research assists), so the
 * deterministic projection is not their baseline. They are reported, never
 * gated, unless a live baseline run supplies the existing classifiers'
 * answers (`--baseline-model`).
 */
function secondaryErrors(
  item: MissionDecisionEvalCaseV1,
  decided: Pick<MissionDecisionSet, "researchMode" | "route">,
): string[] {
  const errors: string[] = [];
  if (decided.researchMode !== item.labels.researchMode) errors.push("research_mode");
  if (item.labels.route && decided.route !== item.labels.route) errors.push("route");
  return errors;
}

/** Hard constraints the combined system must never break. */
function constraintViolations(
  item: MissionDecisionEvalCaseV1,
  decided: MissionDecisionSet,
  contractReason: string,
  effectivePrompt: string = item.prompt,
): string[] {
  const violations: string[] = [];
  for (const constraint of item.constraints ?? []) {
    if (constraint === "no_web" && hasExplicitNoWebIntent(item.prompt) && decided.web) violations.push("no_web");
    if (constraint === "no_vault" && hasExplicitNoVaultReadIntent(item.prompt) && decided.vault) violations.push("no_vault");
    if (constraint === "chat_only" && contractReason === "applied") violations.push("chat_only");
    if (constraint === "exact_fetch" && hasExplicitSingleWebFetchOnlyIntent(item.prompt) && contractReason === "applied") violations.push("exact_fetch");
    if (constraint === "literary_primary_text" && hasPrimaryTextCitationIntent(item.prompt) && decided.web) violations.push("literary_primary_text");
    if (constraint === "no_new_evidence" && contractReason === "applied") violations.push("no_new_evidence");
  }
  // Source counts stay with the deterministic parser: whatever the decision
  // model said, the prompt every stage reads must parse to the same count.
  if (parseExplicitResearchSourceCount(effectivePrompt) !== parseExplicitResearchSourceCount(item.prompt)) {
    violations.push("exact_source_count_changed");
  }
  return violations;
}

/* ------------------------------------------------------------------ */
/* Live transport                                                      */
/* ------------------------------------------------------------------ */

async function fetchTransport(request: HttpRequest): Promise<HttpResponse> {
  const response = await fetch(request.url, {
    method: request.method ?? "GET",
    headers: request.headers,
    body: request.body as string | undefined,
    signal: request.abortSignal,
  });
  const text = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, text };
}

/**
 * The existing model-based classifiers, for the route/research baseline:
 * the structured router and the utility-model research assists, exactly as
 * the runner calls them, against the model the owner configures by env:
 * BASELINE_MODEL_PROVIDER (ollama | openai_compatible), BASELINE_MODEL,
 * BASELINE_BASE_URL, BASELINE_API_KEY.
 */
function createBaselineModelClient(): ModelClient {
  const provider = process.env.BASELINE_MODEL_PROVIDER === "openai_compatible" ? "openai_compatible" : "ollama";
  const model = process.env.BASELINE_MODEL?.trim() || "qwen3.5:cloud";
  const baseUrl =
    process.env.BASELINE_BASE_URL?.trim() ||
    (provider === "ollama" ? "https://ollama.com/api" : "https://openrouter.ai/api/v1");
  const apiKey = process.env.BASELINE_API_KEY?.trim() ?? "";
  const options = { baseUrl, apiKey, model, transport: fetchTransport, requestTimeoutMs: 120_000 };
  return provider === "openai_compatible" ? new OpenAICompatibleClient(options) : new OllamaClient(options);
}

async function existingModelDecisions(
  client: ModelClient,
  prompt: string,
): Promise<{ route: string; researchMode: ResearchMode; routeMs: number }> {
  const intent = classifyMissionIntent(prompt, { hasActiveMarkdownNote: true });
  const startedAt = Date.now();
  const routed = await classifyMissionWithModelDetailed({ client, prompt, timeoutMs: 120_000 });
  const routeMs = Date.now() - startedAt;
  const regex = deriveRoutedIntentFallback({
    missionIntent: intent,
    writeAutonomy: intent.allowAutonomousWrite,
    writeToolExposed: false,
    prompt,
  });
  const route = routed.intent && routed.intent.confidence >= 0.75 ? routed.intent.mode : regex.mode;
  const model = (client as { descriptor?: { model: string } }).descriptor?.model;
  const plan = await createResearchPlanWithAssist({
    prompt,
    missionIntent: intent,
    runPlan: { route: "grounded_workflow", slowPathReason: "none" },
    utilityModelConfigured: true,
    modeAssist: buildResearchModeAssistForEval(client, model),
    effortAssist: buildResearchEffortAssistForEval(client, model),
  });
  return { route, researchMode: plan?.mode ?? "none", routeMs };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/* ------------------------------------------------------------------ */
/* Claims                                                              */
/* ------------------------------------------------------------------ */

function claimChecks(items: readonly ClaimSupportEvalCaseV1[]): ClaimSupportCheckV1[] {
  return items.map((item) => ({
    claimId: item.id,
    claimText: item.claim,
    passages: item.passages.map((passage) => ({ id: passage.id, text: passage.text })),
  }));
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(outDir, { recursive: true });
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    model: JEV_DECISION_MODEL_V1,
    missionTemplate: MISSION_DECISION_TEMPLATE_VERSION_V1,
    missionThresholds: MISSION_DECISION_THRESHOLDS_V1,
    claimTemplate: CLAIM_SUPPORT_TEMPLATE_VERSION_V1,
    claimThresholds: CLAIM_SUPPORT_THRESHOLDS_V1,
    live,
    split: live ? split : "all",
  };

  // Baseline over both splits, per family.
  const baselineRows = MISSION_DECISION_EVAL_SET_V1.map((item) => {
    const decided = baselineDecisions(item.prompt);
    return {
      id: item.id,
      split: item.split,
      family: item.family,
      errors: missionErrors(item, decided),
      secondaryErrors: secondaryErrors(item, decided),
      decided,
    };
  });
  const summarize = (rows: Array<{ family: string; split: string; errors: string[] }>, family: string, only?: Split) => {
    const selected = rows.filter((row) => row.family === family && (!only || row.split === only));
    const wrong = selected.filter((row) => row.errors.length > 0).length;
    return { cases: selected.length, casesWithError: wrong, accuracy: selected.length ? 1 - wrong / selected.length : null };
  };
  report.missionBaseline = {
    ordinary: summarize(baselineRows, "ordinary"),
    challenge: summarize(baselineRows, "challenge"),
    // Deterministic parser misses the decision model never touches.
    sourceCountParserMisses: MISSION_DECISION_EVAL_SET_V1.filter(
      (item) =>
        item.labels.exactSourceCount !== undefined &&
        parseExplicitResearchSourceCount(item.prompt) !== item.labels.exactSourceCount,
    ).map((item) => item.id),
    rows: baselineRows,
  };
  // Reach and ceiling: which cases the runner would ask about at all, and the
  // best the application path could do with a perfect answer on each.
  const ceilingRows = MISSION_DECISION_EVAL_SET_V1.map((item) => {
    const asked = wouldAsk(item.prompt);
    const combined = combinedDecisions(item.prompt, asked ? oracleAssessment(item) : null);
    return {
      id: item.id,
      split: item.split,
      family: item.family,
      asked,
      contractReason: combined.contractReason,
      errors: missionErrors(item, combined),
      violations: constraintViolations(item, combined, combined.contractReason, combined.effectivePrompt),
    };
  });
  report.missionCeiling = {
    note: "A perfect decision model on every case the runner asks about. Measures the host's application path, not Jev.",
    asked: {
      ordinary: ceilingRows.filter((row) => row.family === "ordinary" && row.asked).length,
      challenge: ceilingRows.filter((row) => row.family === "challenge" && row.asked).length,
    },
    ordinary: summarize(ceilingRows, "ordinary"),
    challenge: summarize(ceilingRows, "challenge"),
    violations: ceilingRows.flatMap((row) => row.violations.map((violation) => `${row.id}:${violation}`)),
    rows: ceilingRows,
  };
  // The deterministic verifier accepts every claim in the set: each cites a
  // real fetched passage and quotes nothing it does not contain. So its
  // detection of contradicted/insufficient claims is 0 by construction.
  const clearClaims = CLAIM_SUPPORT_EVAL_SET_V1.filter((item) => item.label !== "supported");
  report.claimBaseline = {
    clearFindings: clearClaims.length,
    detectedByDeterministicVerifier: 0,
    supported: CLAIM_SUPPORT_EVAL_SET_V1.length - clearClaims.length,
    falseHoldsByDeterministicVerifier: 0,
  };

  if (live) {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";
    if (!apiKey) {
      console.error("OPENROUTER_API_KEY is not set; live evaluation needs the decision credential.");
      process.exitCode = 2;
      return;
    }
    const client = createOpenRouterDecisionClientV1({ apiKey, transport: fetchTransport });

    // Missions.
    const missionItems = MISSION_DECISION_EVAL_SET_V1.filter((item) => item.split === split);
    const missionRows: unknown[] = [];
    const durations: number[] = [];
    let unavailable = 0;
    const byFamily = { ordinary: { base: 0, combined: 0, n: 0 }, challenge: { base: 0, combined: 0, n: 0 } };
    const violations: string[] = [];
    const secondary = { existing: 0, combined: 0, n: 0 };
    const existingRouterDurations: number[] = [];
    const baselineModel = args.get("baseline-model") === "true" ? createBaselineModelClient() : null;
    let notAsked = 0;
    for (const item of missionItems) {
      const asked = wouldAsk(item.prompt);
      const result = asked
        ? await client.decide(
            buildMissionDecisionRequestV1({ mission: item.prompt, hasActiveNote: true }),
            { timeoutMs: DECISION_CLASSIFICATION_TIMEOUT_MS_V1 * 5 },
          )
        : null;
      if (!result) notAsked += 1;
      if (result) durations.push(result.durationMs);
      if (result && result.status !== "answered") unavailable += 1;
      const assessment = result ? interpretMissionDecisionV1(result) : null;
      const baseline = baselineDecisions(item.prompt);
      const combined = combinedDecisions(item.prompt, assessment);
      const baseErrors = missionErrors(item, baseline);
      const combinedErrors = missionErrors(item, combined);
      const caseViolations = constraintViolations(item, combined, combined.contractReason, combined.effectivePrompt);
      violations.push(...caseViolations.map((violation) => `${item.id}:${violation}`));
      const family = byFamily[item.family];
      family.n += 1;
      if (baseErrors.length > 0) family.base += 1;
      if (combinedErrors.length > 0) family.combined += 1;
      // Route and research mode: the existing model-based classifiers are the
      // baseline, so they are compared only when --baseline-model ran them.
      const existing = baselineModel
        ? await existingModelDecisions(baselineModel, item.prompt)
        : null;
      const jevSecondary = secondaryErrors(item, {
        researchMode:
          assessment?.researchMode.status === "decided"
            ? assessment.researchMode.value!
            : (existing?.researchMode ?? combined.researchMode),
        route:
          assessment?.route.status === "decided"
            ? assessment.route.value!
            : (existing?.route ?? combined.route),
      });
      const existingSecondary = existing ? secondaryErrors(item, existing) : null;
      if (existingSecondary) {
        secondary.n += 1;
        if (existingSecondary.length > 0) secondary.existing += 1;
        if (jevSecondary.length > 0) secondary.combined += 1;
        if (existing?.routeMs !== undefined) existingRouterDurations.push(existing.routeMs);
      }
      missionRows.push({
        id: item.id,
        family: item.family,
        result,
        assessment,
        baseErrors,
        combinedErrors,
        jevSecondary,
        existing,
        existingSecondary,
        caseViolations,
      });
    }
    const challengeReduction =
      byFamily.challenge.base > 0 ? (byFamily.challenge.base - byFamily.challenge.combined) / byFamily.challenge.base : null;
    const routingGates = {
      noConstraintViolations: violations.length === 0,
      challengeErrorsReducedAtLeast20pct: challengeReduction !== null && challengeReduction >= 0.2,
      noOrdinaryRegression: byFamily.ordinary.combined <= byFamily.ordinary.base,
      medianDecisionMs: median(durations),
      medianWithinClassificationBudget: (median(durations) ?? Infinity) <= DECISION_CLASSIFICATION_TIMEOUT_MS_V1,
      // Classification time must drop against the calls it replaces.
      medianExistingRouterMs: median(existingRouterDurations),
      fasterThanExistingRouter:
        existingRouterDurations.length > 0
          ? (median(durations) ?? Infinity) < (median(existingRouterDurations) ?? 0)
          : null,
      secondaryRouteAndResearch: secondary.n > 0 ? secondary : "not measured (run with --baseline-model)",
    };
    report.missionLive = {
      split,
      byFamily,
      challengeReduction,
      unavailable,
      notAsked,
      violations,
      gates: routingGates,
      rows: missionRows,
    };

    // Claims, in the same batches the runner uses.
    const claimItems = CLAIM_SUPPORT_EVAL_SET_V1.filter((item) => item.split === split);
    const checks = claimChecks(claimItems);
    const claimRows: unknown[] = [];
    const claimDurations: number[] = [];
    let detected = 0;
    let clear = 0;
    let falseHolds = 0;
    let supported = 0;
    let unassessed = 0;
    for (let offset = 0; offset < checks.length; offset += 8) {
      const batch = checks.slice(offset, offset + 8);
      const request = buildClaimSupportRequestV1(batch);
      const result = await client.decide(request.request, { timeoutMs: DECISION_VERIFICATION_TIMEOUT_MS_V1 * 3 });
      claimDurations.push(result.durationMs);
      const findings = interpretClaimSupportAnswersV1(result, request.questionFor);
      for (const check of batch) {
        const item = claimItems.find((candidate) => candidate.id === check.claimId)!;
        const finding = findings.get(check.claimId);
        const verdict = finding?.status === "decided" ? finding.verdict : null;
        if (!verdict) unassessed += 1;
        if (item.label === "supported") {
          supported += 1;
          if (verdict === "contradicted" || verdict === "insufficient") falseHolds += 1;
        } else {
          clear += 1;
          if (verdict === "contradicted" || verdict === "insufficient") detected += 1;
        }
        claimRows.push({ id: item.id, label: item.label, trap: item.trap ?? null, finding });
      }
    }
    const detectionRate = clear > 0 ? detected / clear : null;
    const falseHoldRate = supported > 0 ? falseHolds / supported : null;
    report.claimLive = {
      split,
      detectionRate,
      falseHoldRate,
      unassessed,
      medianBatchMs: median(claimDurations),
      gates: {
        detectionAtLeast90pct: detectionRate !== null && detectionRate >= 0.9,
        falseHoldsAtMost2pct: falseHoldRate !== null && falseHoldRate <= 0.02,
      },
      rows: claimRows,
    };
    if (split === "heldout") {
      report.promotion = {
        mission_routing:
          routingGates.noConstraintViolations &&
          routingGates.challengeErrorsReducedAtLeast20pct &&
          routingGates.noOrdinaryRegression &&
          routingGates.medianWithinClassificationBudget &&
          routingGates.fasterThanExistingRouter === true
            ? "gates passed on held-out; promote only after the end-to-end latency and scorecard comparison also pass"
            : "stays in Shadow",
        claim_support:
          (report.claimLive as { gates: Record<string, boolean> }).gates.detectionAtLeast90pct &&
          (report.claimLive as { gates: Record<string, boolean> }).gates.falseHoldsAtMost2pct
            ? "gates passed on held-out; promote only after the end-to-end scorecard comparison also passes"
            : "stays in Shadow",
      };
    }
  }

  const base = join(outDir, `${live ? `live-${split}` : "baseline"}-${stamp}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${base}.md`, renderMarkdown(report));
  console.log(renderMarkdown(report));
  console.log(`Wrote ${base}.json and .md`);
}

function renderMarkdown(report: Record<string, unknown>): string {
  const lines = [`# Jev decision evaluation (${String(report.generatedAt)})`, ""];
  lines.push(`Model: \`${String(report.model)}\` · mission template \`${String(report.missionTemplate)}\` · claim template \`${String(report.claimTemplate)}\``);
  const baseline = report.missionBaseline as { ordinary: { cases: number; casesWithError: number }; challenge: { cases: number; casesWithError: number } };
  lines.push("", "## Baseline (deterministic classifiers, no model)", "");
  lines.push(`- Ordinary missions: ${baseline.ordinary.casesWithError}/${baseline.ordinary.cases} with an evidence-decision error.`);
  lines.push(`- Challenge missions: ${baseline.challenge.casesWithError}/${baseline.challenge.cases} with an evidence-decision error.`);
  const parserMisses = (report.missionBaseline as { sourceCountParserMisses: string[] }).sourceCountParserMisses;
  if (parserMisses.length > 0) {
    lines.push(`- Source-count parser misses (deterministic, untouched by the decision model): ${parserMisses.join(", ")}.`);
  }
  const claimBaseline = report.claimBaseline as { clearFindings: number; supported: number };
  lines.push(`- Claims: the deterministic verifier accepts all ${claimBaseline.clearFindings + claimBaseline.supported}; it detects 0/${claimBaseline.clearFindings} unsupported or contradicted claims that cite a real passage.`);
  const ceiling = report.missionCeiling as {
    asked: { ordinary: number; challenge: number };
    ordinary: { cases: number; casesWithError: number };
    challenge: { cases: number; casesWithError: number };
    violations: string[];
    rows: Array<{ id: string; asked: boolean; contractReason: string; errors: string[] }>;
  };
  lines.push("", "## Ceiling (a perfect answer on every case the runner asks about)", "");
  lines.push("Not a measurement of Jev: this is what the host's application path — eligibility, the evidence clause, and the constraint and mutation refusals — can deliver at best.", "");
  lines.push(`- Asked about: ${ceiling.asked.ordinary}/${ceiling.ordinary.cases} ordinary, ${ceiling.asked.challenge}/${ceiling.challenge.cases} challenge.`);
  lines.push(`- Ordinary missions: ${ceiling.ordinary.casesWithError}/${ceiling.ordinary.cases} with an evidence-decision error.`);
  lines.push(`- Challenge missions: ${ceiling.challenge.casesWithError}/${ceiling.challenge.cases} with an evidence-decision error.`);
  lines.push(`- Constraint violations: ${ceiling.violations.length === 0 ? "none" : ceiling.violations.join(", ")}.`);
  const residual = ceiling.rows.filter((row) => row.errors.length > 0);
  if (residual.length > 0) {
    lines.push("", "| case | asked | clause | still wrong |", "| --- | --- | --- | --- |");
    for (const row of residual) {
      lines.push(`| ${row.id} | ${row.asked ? "yes" : "no"} | ${row.contractReason} | ${row.errors.join(", ")} |`);
    }
  }
  if (report.missionLive) {
    const missionLive = report.missionLive as { split: string; byFamily: Record<string, { base: number; combined: number; n: number }>; challengeReduction: number | null; violations: string[]; gates: Record<string, unknown>; unavailable: number };
    lines.push("", `## Live: missions (${missionLive.split})`, "");
    for (const [family, counts] of Object.entries(missionLive.byFamily)) {
      lines.push(`- ${family}: baseline ${counts.base}/${counts.n} wrong → with Jev ${counts.combined}/${counts.n} wrong.`);
    }
    lines.push(`- Challenge error reduction: ${missionLive.challengeReduction === null ? "n/a" : `${Math.round(missionLive.challengeReduction * 100)}%`}; unavailable answers: ${missionLive.unavailable}.`);
    lines.push(`- Constraint violations: ${missionLive.violations.length === 0 ? "none" : missionLive.violations.join(", ")}.`);
    lines.push(`- Gates: ${JSON.stringify(missionLive.gates)}`);
  }
  if (report.claimLive) {
    const claimLive = report.claimLive as { split: string; detectionRate: number | null; falseHoldRate: number | null; unassessed: number; gates: Record<string, boolean> };
    lines.push("", `## Live: claims (${claimLive.split})`, "");
    lines.push(`- Detection of clear findings: ${claimLive.detectionRate === null ? "n/a" : `${Math.round(claimLive.detectionRate * 100)}%`} (gate ≥ 90%).`);
    lines.push(`- False holds on supported claims: ${claimLive.falseHoldRate === null ? "n/a" : `${(claimLive.falseHoldRate * 100).toFixed(1)}%`} (gate ≤ 2%).`);
    lines.push(`- Unassessed (abstained or unavailable): ${claimLive.unassessed}.`);
    lines.push(`- Gates: ${JSON.stringify(claimLive.gates)}`);
  }
  if (report.promotion) {
    lines.push("", "## Promotion", "", "```json", JSON.stringify(report.promotion, null, 2), "```");
  }
  return `${lines.join("\n")}\n`;
}

void main();
