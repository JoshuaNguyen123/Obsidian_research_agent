import { normalizeDurableMissionDurationHours } from "./durableMission";

export interface OvernightMissionIntent {
  requested: boolean;
  durationHours: number;
  reason?: "overnight_keyword" | "explicit_duration";
}

const DURATION_PATTERN =
  /\b(?:for|during)\s+(\d{1,2}(?:\.\d+)?)\s*(?:(?:-|\u2013|\u2014|to)\s*(\d{1,2}(?:\.\d+)?)\s*)?(?:hours?|hrs?|h)\b/i;
const NEGATED_WORK_PATTERN =
  /\b(?:(?:do|does|did)\s+not|don't|doesn't|didn't|dont|doesnt|didnt|never|without)\b[^.;!?]{0,48}\b(?:run(?:ning)?|work(?:ing)?|research(?:ing)?|investigat(?:e|ing)|analy[sz](?:e|ing)|study(?:ing)?|co-?research(?:ing)?)\b/i;
const DIRECT_CONTROL_REQUEST_PATTERN =
  /^(?:please\s+)?(?:run|work|keep\s+(?:working|researching|investigating|analy[sz]ing|studying)|continue\s+(?:working|researching|investigating|analy[sz]ing|studying))\b/i;
const DIRECT_RESEARCH_REQUEST_PATTERN =
  /^(?:please\s+)?(?:research|investigate|analy[sz]e|study)\s+(?:this|it|the\s+(?:task|mission|topic|question|subject))\b/i;
const START_AGENT_REQUEST_PATTERN =
  /^(?:please\s+)?(?:start|launch|begin|use)\s+(?:(?:the|this|my|an?)\s+)?(?:agent|researcher|co-?researcher|research|mission|run)\b/i;
const REQUESTER_CONTROL_PATTERN =
  /^(?:(?:can|could|would|will)\s+you|i\s+(?:want|need|would\s+like)\s+you\s+to|we\s+(?:should|must|need\s+to|want\s+to)|(?:please\s+)?(?:have|let|ask)\s+(?:(?:the|this|my)\s+)?(?:agent|researcher|co-?researcher))\b[^.;!?]{0,100}\b(?:run|work|research|investigate|analy[sz]e|study|co-?research)\b/i;
const DIRECT_RESEARCH_VERB_PATTERN =
  /^(?:please\s+)?(?:research|investigate|analy[sz]e|study)\b/i;
const DESCRIPTIVE_RESEARCH_PATTERN =
  /\b(?:why|how|whether|effects?\s+of|history\s+of|meaning\s+of|policy\s+for|worked|working|ran|running|researched|researching|studied|studying|happened|occurred)\b/i;
const OVERNIGHT_NOUN_REQUEST_PATTERN =
  /^(?:(?:please\s+)?(?:run|start|launch|begin|do|perform)|i\s+(?:want|need)|we\s+(?:want|need))\b[^.;!?]{0,80}\bovernight\s+(?:research|analysis|investigation|mission|run|co-?research)\b/i;
const OVERNIGHT_FIRST_REQUEST_PATTERN =
  /^overnight\s*[,;:]\s*(?:please\s+)?(?:run|work|research|investigate|analy[sz]e|study)\b/i;
const OVERNIGHT_EXECUTION_SUFFIX_PATTERN =
  /^(?:\s*$|\s*[,!?]\s*(?:$|then\b|and\b)|\s*[.!?]|\s+(?:for|and|then|while|until|with|using|on|to)\b)/i;

/**
 * Activates durable overnight execution only for an explicit work request.
 * Factual duration mentions and locally negated clauses stay on the ordinary
 * bounded runner.
 */
export function classifyOvernightMissionIntent(
  prompt: string,
  defaultDurationHours: unknown = 10,
): OvernightMissionIntent {
  const normalizedDefault = normalizeDurableMissionDurationHours(
    defaultDurationHours,
  );
  const text = prompt.trim();
  if (!text) {
    return { requested: false, durationHours: normalizedDefault };
  }

  const durationMatch = DURATION_PATTERN.exec(text);
  if (
    durationMatch &&
    hasExplicitDurationWorkRequest(text, durationMatch.index)
  ) {
    const first = Number(durationMatch[1]);
    const second = durationMatch[2] ? Number(durationMatch[2]) : null;
    const upper = second === null ? first : Math.max(first, second);
    if (Number.isFinite(first) && Number.isFinite(upper) && upper >= 8) {
      const requested =
        second === null
          ? first
          : Math.min(
              Math.max(normalizedDefault, Math.min(first, second)),
              Math.max(first, second),
            );
      return {
        requested: true,
        durationHours: normalizeDurableMissionDurationHours(requested),
        reason: "explicit_duration",
      };
    }
  }

  if (hasExplicitOvernightWorkRequest(text)) {
    return {
      requested: true,
      durationHours: normalizedDefault,
      reason: "overnight_keyword",
    };
  }

  return { requested: false, durationHours: normalizedDefault };
}

function hasExplicitDurationWorkRequest(
  text: string,
  durationIndex: number,
): boolean {
  const prefix = getClausePrefix(text, durationIndex);
  if (!prefix || NEGATED_WORK_PATTERN.test(prefix)) {
    return false;
  }
  return (
    isExplicitWorkRequestPrefix(prefix) ||
    (DIRECT_RESEARCH_VERB_PATTERN.test(prefix) &&
      !DESCRIPTIVE_RESEARCH_PATTERN.test(prefix))
  );
}

function hasExplicitOvernightWorkRequest(text: string): boolean {
  const clauses = text
    .split(/[.;!?]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const overnightIndex = clause.search(/\bovernight\b/i);
    if (overnightIndex < 0 || NEGATED_WORK_PATTERN.test(clause)) {
      continue;
    }
    if (
      OVERNIGHT_NOUN_REQUEST_PATTERN.test(clause) ||
      OVERNIGHT_FIRST_REQUEST_PATTERN.test(clause)
    ) {
      return true;
    }

    const prefix = clause.slice(0, overnightIndex).trim();
    const suffix = clause.slice(overnightIndex + "overnight".length);
    if (!OVERNIGHT_EXECUTION_SUFFIX_PATTERN.test(suffix)) {
      continue;
    }
    if (isExplicitWorkRequestPrefix(prefix)) {
      return true;
    }
    if (
      DIRECT_RESEARCH_VERB_PATTERN.test(prefix) &&
      !DESCRIPTIVE_RESEARCH_PATTERN.test(prefix)
    ) {
      return true;
    }
  }
  return false;
}

function isExplicitWorkRequestPrefix(prefix: string): boolean {
  return (
    DIRECT_CONTROL_REQUEST_PATTERN.test(prefix) ||
    DIRECT_RESEARCH_REQUEST_PATTERN.test(prefix) ||
    START_AGENT_REQUEST_PATTERN.test(prefix) ||
    REQUESTER_CONTROL_PATTERN.test(prefix)
  );
}

function getClausePrefix(text: string, endIndex: number): string {
  const beforeDuration = text.slice(0, endIndex);
  const clauseStart = Math.max(
    beforeDuration.lastIndexOf("."),
    beforeDuration.lastIndexOf(";"),
    beforeDuration.lastIndexOf("!"),
    beforeDuration.lastIndexOf("?"),
  );
  return beforeDuration.slice(clauseStart + 1).trim();
}
