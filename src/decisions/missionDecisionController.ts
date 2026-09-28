import type { RoutedMissionIntent } from "../agent/missionRouter";
import type { ResearchEffortAssist, ResearchModeAssist } from "../agent/researchPlan";
import { fingerprintCanonicalJson } from "../agent/queue/fingerprint";
import { DECISION_CLASSIFICATION_TIMEOUT_MS_V1 } from "./decisionClient";
import type { DecisionRuntimeV1 } from "./decisionRuntime";
import type { DecisionModelModeV1 } from "./decisionSettings";
import type { DecisionLedgerV1, PersistedMissionDecisionContractV1 } from "./decisionLedger";
import {
  MISSION_DECISION_TEMPLATE_VERSION_V1,
  MISSION_DECISION_THRESHOLDS_V1,
  buildMissionDecisionRequestV1,
  compareMissionDecisionWithBaselineV1,
  createDecisionResearchAssistsV1,
  decideEvidenceContractV1,
  describeAssessmentV1,
  interpretMissionDecisionV1,
  routedIntentFromAssessmentV1,
  type DecisionEvidenceContractV1,
  type EvidenceContractDecisionV1,
  type MissionDecisionAssessmentV1,
  type MissionDecisionBaselineV1,
  type MutationFootprintV1,
} from "./missionDecisionAssessment";

export interface MissionDecisionTraceV1 {
  id: string;
  kind: "mission_intent";
  message: string;
  outputPreview: unknown;
}

/**
 * The run-scoped seam between AgentRunner and the mission assessment. It owns
 * the one question per routing prompt, the contract a continuation reuses, and
 * the shadow comparisons — so the runner only asks "what is the assessment",
 * "apply the evidence contract", "adapt it for the router", and "give me the
 * research assists", and never learns the decision model's details.
 *
 * Off: every method is a no-op and nothing is sent.
 * Shadow: the question is asked in the background; nothing the run does
 *   changes; comparisons are recorded when both sides are known.
 * Enabled: the question is awaited (bounded to 2 s) and clear answers act.
 */
export interface MissionDecisionControllerV1 {
  readonly mode: DecisionModelModeV1;
  /** Why Enabled was configured but this component runs in Shadow, if so. */
  readonly heldInShadowBecause: string | null;
  assessForRouting(input: {
    prompt: string;
    hasActiveNote: boolean;
    recentAssistant?: string | null;
  }): Promise<MissionDecisionAssessmentV1 | null>;
  applyEvidenceContract(input: {
    prompt: string;
    lexical: { web: boolean; vault: boolean };
    mutationFootprint: (prompt: string) => MutationFootprintV1;
  }): EvidenceContractDecisionV1;
  routedIntent(input: {
    prompt: string;
    regexIntent: RoutedMissionIntent;
    wordTarget: number | null;
  }): RoutedMissionIntent | null;
  researchAssists(
    fallbacks: {
      modeAssist?: ResearchModeAssist;
      effortAssist?: ResearchEffortAssist;
    },
    options?: { allowModeAssist?: boolean },
  ): {
    modeAssist?: ResearchModeAssist;
    effortAssist?: ResearchEffortAssist;
    /** True when the assists can answer without a utility model. */
    answersWithoutUtilityModel: boolean;
  };
  recordBaseline(prompt: string, baseline: MissionDecisionBaselineV1): void;
  /** Continuations reuse the persisted contract and never ask again. */
  restore(ledger: DecisionLedgerV1 | null | undefined, restoredPrompt: string | null): void;
  ledger(): DecisionLedgerV1 | null;
  /** Wait (bounded) for background shadow work before the run record closes. */
  settle(maxWaitMs?: number): Promise<void>;
}

interface Entry {
  promise: Promise<MissionDecisionAssessmentV1 | null>;
  settled: MissionDecisionAssessmentV1 | null;
}

export function promptFingerprintV1(prompt: string): string {
  return fingerprintCanonicalJson({ prompt });
}

export function createMissionDecisionControllerV1(input: {
  runtime: DecisionRuntimeV1 | null;
  getAbortSignal: () => AbortSignal | undefined;
  onTrace?: (event: MissionDecisionTraceV1) => void;
  onLedgerChange?: () => void;
}): MissionDecisionControllerV1 {
  const runtime = input.runtime;
  const resolution = runtime?.componentMode("mission_routing") ?? null;
  const mode: DecisionModelModeV1 = resolution?.effective ?? "off";
  const entries = new Map<string, Entry>();
  /** Augmented routing prompt -> the prompt the assessment answered. */
  const aliases = new Map<string, string>();
  const pending = new Set<Promise<unknown>>();
  let continuation = false;
  let contract: PersistedMissionDecisionContractV1 | undefined;
  let evidenceContract: DecisionEvidenceContractV1 | null = null;
  const shadowComparisons: unknown[] = [];
  /** Call records inherited from the run this one continues. */
  let restoredRecords: DecisionLedgerV1["records"] = [];
  const shadowEvidenceReasons = new Map<string, string>();
  let traceSequence = 0;

  const trace = (message: string, outputPreview: unknown) => {
    try {
      input.onTrace?.({
        id: `decision-mission-${++traceSequence}`,
        kind: "mission_intent",
        message,
        outputPreview,
      });
    } catch {
      // Diagnostics never change a decision.
    }
  };
  const changed = () => {
    try {
      input.onLedgerChange?.();
    } catch {
      // Persistence is the runner's concern.
    }
  };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
    return promise;
  };
  const resolveKey = (prompt: string): string => {
    const key = promptFingerprintV1(prompt);
    return aliases.get(key) ?? key;
  };

  const start = (prompt: string, hasActiveNote: boolean, recentAssistant?: string | null) => {
    const key = promptFingerprintV1(prompt);
    const existing = entries.get(key);
    if (existing) return existing;
    const request = buildMissionDecisionRequestV1({ mission: prompt, hasActiveNote, recentAssistant });
    const entry: Entry = { promise: Promise.resolve(null), settled: null };
    entry.promise = track(
      (async () => {
        try {
          const result = await runtime!.decide("mission_routing", request, {
            timeoutMs: DECISION_CLASSIFICATION_TIMEOUT_MS_V1,
            abortSignal: input.getAbortSignal(),
          });
          if (!result) return null;
          const assessment = interpretMissionDecisionV1(result);
          entry.settled = assessment;
          contract = {
            version: 1,
            promptFingerprint: key,
            inputFingerprint: assessment.inputFingerprint,
            templateVersion: assessment.templateVersion,
            thresholdsVersion: assessment.thresholdsVersion,
            mode: mode === "enabled" ? "enabled" : "shadow",
            assessment,
            evidenceContract: null,
          };
          trace(
            `${mode === "enabled" ? "Jev assessment" : "Jev shadow assessment"}: ${describeAssessmentV1(assessment, runtime!.model)}`,
            { mode, assessment },
          );
          changed();
          return assessment;
        } catch {
          // An abort or an unexpected failure is not decision evidence: the
          // existing classifiers decide, and the stop path handles the abort.
          return null;
        }
      })(),
    );
    entries.set(key, entry);
    return entry;
  };

  const settledFor = (prompt: string): MissionDecisionAssessmentV1 | null =>
    entries.get(resolveKey(prompt))?.settled ?? null;

  return {
    mode,
    heldInShadowBecause: resolution?.heldInShadowBecause ?? null,

    async assessForRouting({ prompt, hasActiveNote, recentAssistant }) {
      if (mode === "off" || !runtime || continuation) return null;
      const entry = start(prompt, hasActiveNote, recentAssistant);
      if (mode !== "enabled") return null;
      return entry.promise;
    },

    applyEvidenceContract({ prompt, lexical, mutationFootprint }) {
      const untouched: EvidenceContractDecisionV1 = { contract: null, prompt, reason: "not_requested" };
      if (mode === "off") return untouched;
      const entry = entries.get(resolveKey(prompt));
      if (!entry) return untouched;
      if (mode === "shadow") {
        // Record what Enabled would have done, without doing it.
        void entry.promise.then((assessment) => {
          if (!assessment) return;
          const would = decideEvidenceContractV1({ prompt, assessment, lexical, mutationFootprint });
          shadowEvidenceReasons.set(resolveKey(prompt), would.reason);
        });
        return untouched;
      }
      const assessment = entry.settled;
      if (!assessment) return untouched;
      const decision = decideEvidenceContractV1({ prompt, assessment, lexical, mutationFootprint });
      if (decision.contract) {
        evidenceContract = decision.contract;
        aliases.set(promptFingerprintV1(decision.prompt), resolveKey(prompt));
        if (contract) contract = { ...contract, evidenceContract: decision.contract };
        trace(
          `Jev found a request for ${decision.contract.web && decision.contract.vault ? "web and vault" : decision.contract.web ? "web" : "vault"} evidence the wording did not name; the research contract now requires it.`,
          { evidenceContract: decision.contract },
        );
        changed();
      } else if (decision.reason !== "not_requested") {
        trace(`Jev evidence judgment not applied (${decision.reason}).`, {
          reason: decision.reason,
        });
      }
      return decision;
    },

    routedIntent({ prompt, regexIntent, wordTarget }) {
      if (mode !== "enabled" || !runtime) return null;
      const assessment = settledFor(prompt);
      if (!assessment) return null;
      return routedIntentFromAssessmentV1({
        assessment,
        regexIntent,
        prompt,
        wordTarget,
        model: runtime.model,
      });
    },

    researchAssists(fallbacks, options) {
      if (mode !== "enabled" || !runtime) {
        return {
          ...(options?.allowModeAssist === false ? {} : { modeAssist: fallbacks.modeAssist }),
          effortAssist: fallbacks.effortAssist,
          answersWithoutUtilityModel: false,
        };
      }
      const assists = createDecisionResearchAssistsV1({
        // Only an assessment already asked for this prompt (or restored for a
        // continuation) is used; the assist never starts a new question.
        assessmentFor: async (prompt) => {
          const entry = entries.get(resolveKey(prompt));
          return entry ? entry.promise : null;
        },
        fallbackModeAssist: fallbacks.modeAssist,
        fallbackEffortAssist: fallbacks.effortAssist,
        onDecision: (event) =>
          trace(
            `Research ${event.question === "research_mode" ? "mode" : "effort"} decided by ${event.source.replace(/_/gu, " ")}${event.fields.length > 0 ? ` (${event.fields.join(", ")})` : ""}.`,
            event,
          ),
      });
      return {
        // A caller that withholds the mode assist (a Lead holding a
        // Specialist's research) keeps withholding it.
        ...(options?.allowModeAssist === false ? {} : { modeAssist: assists.modeAssist }),
        effortAssist: assists.effortAssist,
        answersWithoutUtilityModel: true,
      };
    },

    recordBaseline(prompt, baseline) {
      if (mode !== "shadow") return;
      const key = resolveKey(prompt);
      const entry = entries.get(key);
      if (!entry) return;
      void track(
        entry.promise.then((assessment) => {
          if (!assessment) return;
          const comparison = compareMissionDecisionWithBaselineV1(assessment, baseline);
          const withEvidence = {
            ...comparison,
            evidenceContractWouldApply: shadowEvidenceReasons.get(key) ?? null,
          };
          shadowComparisons.push(withEvidence);
          if (shadowComparisons.length > 8) shadowComparisons.shift();
          const agreed = Object.values(comparison.agreement).filter((value) => value === true).length;
          const disagreed = Object.values(comparison.agreement).filter((value) => value === false).length;
          trace(
            `Jev shadow comparison: ${agreed} agreed, ${disagreed} differed with the existing routing and research decisions.`,
            withEvidence,
          );
          changed();
        }),
      );
    },

    restore(ledger, restoredPrompt) {
      continuation = true;
      // The record keeps what earlier segments asked and compared, whatever
      // the current mode: a continuation never erases decision history.
      restoredRecords = ledger?.records ?? [];
      if (ledger?.shadowComparisons) shadowComparisons.push(...ledger.shadowComparisons.slice(-8));
      const persisted = ledger?.missionContract;
      if (!persisted || mode === "off") return;
      if (persisted.templateVersion !== MISSION_DECISION_TEMPLATE_VERSION_V1) return;
      if (persisted.thresholdsVersion !== MISSION_DECISION_THRESHOLDS_V1.version) return;
      const assessment = persisted.assessment as MissionDecisionAssessmentV1;
      if (!assessment || assessment.version !== 1) return;
      contract = persisted;
      evidenceContract = (persisted.evidenceContract as DecisionEvidenceContractV1 | null) ?? null;
      entries.set(persisted.promptFingerprint, {
        promise: Promise.resolve(assessment),
        settled: assessment,
      });
      if (restoredPrompt) {
        const restoredKey = promptFingerprintV1(restoredPrompt);
        if (restoredKey !== persisted.promptFingerprint) {
          aliases.set(restoredKey, persisted.promptFingerprint);
        }
      }
      trace("Continuation reuses the persisted Jev mission assessment; no new decision call.", {
        inputFingerprint: persisted.inputFingerprint,
      });
    },

    ledger() {
      const current = runtime?.records() ?? [];
      const seen = new Set(current.map((record) => record.id));
      const records = [...restoredRecords.filter((record) => !seen.has(record.id)), ...current];
      if (records.length === 0 && !contract && shadowComparisons.length === 0) return null;
      return {
        version: 1,
        records: records.slice(-32),
        ...(contract ? { missionContract: { ...contract, evidenceContract } } : {}),
        ...(shadowComparisons.length > 0 ? { shadowComparisons: [...shadowComparisons] } : {}),
      };
    },

    async settle(maxWaitMs = DECISION_CLASSIFICATION_TIMEOUT_MS_V1) {
      if (pending.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.max(0, maxWaitMs));
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
