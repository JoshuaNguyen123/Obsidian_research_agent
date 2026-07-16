import path from "node:path";

export type DailyUseFailureCategory =
  | "product_assertion"
  | "provider_competence"
  | "credential_setup"
  | "process_lifecycle"
  | "windows_file_mapping"
  | "cleanup";

export type DailyUseTaskFamily =
  | "notes"
  | "research"
  | "code"
  | "linear"
  | "github"
  | "compound"
  | "settings"
  | "unknown";

export interface DailyUseFailureInput {
  title: string;
  file: string;
  project: string;
  errorMessages: readonly string[];
}

export interface DailyUseFailureClassification {
  scenarioId: `DU-0${1 | 2 | 3 | 4 | 5 | 6}` | null;
  taskFamily: DailyUseTaskFamily;
  category: DailyUseFailureCategory;
}

/**
 * Converts a Playwright failure into a bounded, secret-free triage record.
 * Error text is inspected in memory only; reporters persist the category, not
 * provider responses, credentials, prompts, or stack traces.
 */
export function classifyDailyUseFailure(
  input: DailyUseFailureInput,
): DailyUseFailureClassification {
  const searchable = [
    input.title,
    path.basename(input.file),
    input.project,
    ...input.errorMessages,
  ].join("\n");
  const scenarioId = extractScenarioId(searchable);
  return {
    scenarioId,
    taskFamily: inferTaskFamily(searchable, scenarioId),
    category: inferFailureCategory(searchable),
  };
}

export function extractScenarioId(
  value: string,
): DailyUseFailureClassification["scenarioId"] {
  return (value.match(/\bDU-0[1-6]\b/iu)?.[0]?.toUpperCase() as
    | DailyUseFailureClassification["scenarioId"]
    | undefined) ?? null;
}

function inferTaskFamily(
  searchable: string,
  scenarioId: DailyUseFailureClassification["scenarioId"],
): DailyUseTaskFamily {
  const scenarioFamily: Record<NonNullable<typeof scenarioId>, DailyUseTaskFamily> = {
    "DU-01": "notes",
    "DU-02": "research",
    "DU-03": "code",
    "DU-04": "linear",
    "DU-05": "github",
    "DU-06": "compound",
  };
  if (scenarioId) return scenarioFamily[scenarioId];
  if (/settings|migration|capability setup|connection preflight/iu.test(searchable)) {
    return "settings";
  }
  if (/linear|phase6/iu.test(searchable)) return "linear";
  if (/github|pull request|phase7/iu.test(searchable)) return "github";
  if (/sandbox|code workspace|phase4|\bcode\b/iu.test(searchable)) return "code";
  if (/research|semantic|web fetch|source passage/iu.test(searchable)) return "research";
  if (/note|vault|writeback/iu.test(searchable)) return "notes";
  return "unknown";
}

function inferFailureCategory(searchable: string): DailyUseFailureCategory {
  if (/cleanup|teardown|restore.*data\.json|owned artifact|temporary provider resource/iu.test(searchable)) {
    return "cleanup";
  }
  if (/main\.js.*(?:mapped|mapping|locked)|EPERM|EBUSY|user-mapped section/iu.test(searchable)) {
    return "windows_file_mapping";
  }
  if (/CDP|Obsidian\.exe|process.*(?:exit|terminate)|port .*in use|exclusive.*lock|renderer.*closed/iu.test(searchable)) {
    return "process_lifecycle";
  }
  if (/missing:|credential|unauthorized|forbidden|authentication|api key|setup needed|preflight|not configured/iu.test(searchable)) {
    return "credential_setup";
  }
  if (/provider_budget|provider.*timeout|model.*(?:failed|refused|loop)|competence|no usable evidence|direct_executor_incomplete/iu.test(searchable)) {
    return "provider_competence";
  }
  return "product_assertion";
}
