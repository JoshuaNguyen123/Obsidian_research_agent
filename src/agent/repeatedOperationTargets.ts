/**
 * THE derivation of how many graph nodes one effectful tool owes a mission.
 *
 * Governing rule: a mission node's completion contract closes at its FIRST
 * satisfied receipt. One node therefore cannot serve two operations, and a
 * request that names two destinations for the same tool ("create a folder
 * Projects/Alpha and a folder Projects/Beta") needs two nodes. Before this
 * derivation existed the host planner deduplicated every effectful tool to a
 * single node by NAME (missionGraphHost's `seenEffectfulPlannedNames`), so the
 * model's correct second call had no node to land on and every seat behind the
 * menu gate refused it — correctly. The refusal was never the bug; the plan
 * was.
 *
 * The counter-risk is `product:unpayable_debt`: nodes nothing will ever pay
 * strand a mission on debt it cannot discharge. So this derivation expands on
 * exactly one signal — TWO OR MORE DISTINCT DESTINATIONS THE REQUEST ITSELF
 * NAMES for the same operation. A distinct destination is provably not
 * satisfiable by one call (creating Projects/Alpha does not create
 * Projects/Beta), which is precisely why the first-receipt invariant forces a
 * second node rather than a weaker contract. Plural nouns, numerals, and
 * "several" deliberately expand NOTHING: the host cannot name the targets, so
 * it cannot prove the extra nodes are payable.
 *
 * It returns an empty list whenever the request names fewer than two
 * destinations, so single-destination missions keep byte-identical plans.
 *
 * Every consumer must call THIS function. A second private copy of "how many
 * instances does this request imply" is the two-subsystems-disagree shape that
 * produced the defect in the first place — the planner and the frontier would
 * once again answer differently for the same prompt.
 */

/** Bounded ceiling so a pathological prompt cannot blow the mission graph. */
export const MAX_REPEATED_OPERATION_TARGETS_V1 = 8;

export type RepeatedOperationKindV1 =
  | "vault_folder_create"
  | "vault_file_create"
  | "vault_file_append"
  | "vault_file_replace"
  | "vault_path_delete";

const OPERATION_KIND_BY_TOOL_NAME: ReadonlyMap<string, RepeatedOperationKindV1> =
  new Map([
    ["create_folder", "vault_folder_create"],
    ["create_file", "vault_file_create"],
    ["append_file", "vault_file_append"],
    ["replace_file", "vault_file_replace"],
    ["delete_path", "vault_path_delete"],
  ] as const);

/**
 * Verbs that GOVERN each operation. A clause carrying one of these verbs
 * claims every destination it names for that operation.
 */
const GOVERNING_VERBS: Readonly<Record<RepeatedOperationKindV1, RegExp>> = {
  vault_folder_create:
    /\b(?:create|creating|make|making|add|adding|set\s+up)\b|\bnew\s+(?:folder|director(?:y|ies))\b/iu,
  vault_file_create:
    /\b(?:create|creating|make|making|generate|generating)\b|\bnew\s+(?:markdown\s+)?(?:note|file)\b/iu,
  vault_file_append: /\b(?:append|appending|add|adding)\b/iu,
  vault_file_replace:
    /\b(?:replace|replacing|rewrite|rewriting|overwrite|overwriting)\b/iu,
  vault_path_delete: /\b(?:delete|deleting|remove|removing|trash|trashing)\b/iu,
};

/**
 * Verbs that take a destination for some OTHER purpose. A clause carrying one
 * of these stops the governing verb from eliding into it, so "create a folder
 * Projects/Alpha and read the folder Reference/Notes" never plants a second
 * create node.
 */
const NEUTRALIZING_VERBS =
  /\b(?:read|reading|open|opening|inspect|inspecting|list|listing|search|searching|summar(?:ize|izing|ise|ising)|review|reviewing|link|linking|cite|citing|move|moving|rename|renaming|copy|copying|compare|comparing|check|checking|verify|verifying|count|counting)\b/iu;

/**
 * Where a clause stops naming DESTINATIONS and starts naming SOURCES,
 * CONTENT, or ORDERING. "Create Projects/Summary.md from Projects/Source.md"
 * names one destination and one source: counting both plants a node nothing
 * will ever pay, which is the `product:unpayable_debt` failure this
 * derivation must not cause. Everything at or after the first marker is
 * discarded, and the marker also ends verb elision — coordination after it
 * ("... summarizing A.md and B.md") extends the SOURCE list, never the
 * destination list.
 *
 * The destination prepositions "to", "at", "into", "under", and "in" are
 * deliberately absent: those introduce the target itself.
 */
const SOURCE_OR_CONTENT_MARKER =
  /\b(?:from|with|without|based\s+on|using|derived\s+from|referencing|reference|about|containing|contains|summari[sz](?:e|es|ing|ed)|describ(?:e|es|ing|ed)|explain(?:s|ing|ed)?|copy(?:ing)?|copied|mirroring|after|before|according\s+to|per|out\s+of|link(?:s|ing)?\s+to|so\s+that|such\s+that)\b/iu;

const COMPACT_PATH_SEGMENT = String.raw`[A-Za-z0-9._@()-]+`;
const COMPACT_PATH = String.raw`${COMPACT_PATH_SEGMENT}(?:\/${COMPACT_PATH_SEGMENT})*`;
/** A run of path characters that ENDS at the .md extension. */
const COMPACT_MARKDOWN_PATH = String.raw`[A-Za-z0-9._@()/-]*[A-Za-z0-9_@()-]\.md`;

/**
 * Splits an objective into coordination-aware clauses. Coordination matters:
 * the second destination of "a folder Alpha and a folder Beta" sits in a
 * clause whose verb was elided, and only clause-level governance recovers it.
 */
function splitClausesV1(objective: string): string[] {
  return objective
    .replace(/\r\n?/gu, "\n")
    // A period inside a filename must never end a clause, so sentence
    // punctuation only splits when whitespace or the end of the objective
    // follows it. Splitting "Projects/One.md" would erase the destination the
    // whole derivation exists to count.
    .split(/(?:[;!?\n]+|[.:](?=\s|$)|,\s*|\s+and\s+then\s+|\s+then\s+|\s+and\s+|\s+&\s+)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function folderTargetsInClauseV1(clause: string): string[] {
  const quoted = [
    ...clause.matchAll(
      new RegExp(
        String.raw`\b(?:folders?|director(?:y|ies))\b\s*(?:named|called|at|under|in|into)?\s*["'\x60]([^"'\x60\n]{1,120})["'\x60]`,
        "giu",
      ),
    ),
  ].map((match) => match[1] ?? "");
  // An unquoted folder name is accepted only as a compact slash path. A bare
  // word after "folder" is ordinary prose ("create a folder for my notes") and
  // must never become a second destination.
  const slashPaths = [
    ...clause.matchAll(
      new RegExp(
        String.raw`\b(?:folders?|director(?:y|ies))\b\s*(?:named\s+|called\s+|at\s+|under\s+|in\s+|into\s+)?(${COMPACT_PATH_SEGMENT}(?:\/${COMPACT_PATH_SEGMENT})+)`,
        "giu",
      ),
    ),
  ].map((match) => match[1] ?? "");
  return [...quoted, ...slashPaths]
    .map((value) => normalizeTargetV1(value))
    .filter((value) => value.length > 0 && !/\.md$/iu.test(value));
}

function markdownTargetsInClauseV1(clause: string): string[] {
  const quoted = [
    ...clause.matchAll(
      new RegExp(String.raw`["'\x60]([^"'\x60\n]{1,160}\.md)["'\x60]`, "giu"),
    ),
  ].map((match) => match[1] ?? "");
  const labelled = [
    ...clause.matchAll(
      new RegExp(
        String.raw`\b(?:markdown\s+file|file|note|path)\s+(?:(?:named|called|at|to|into)\s+)?([A-Za-z0-9 ._@()-]+?\.md)\b`,
        "giu",
      ),
    ),
  ].map((match) => match[1] ?? "");
  const compact = [
    ...clause.matchAll(new RegExp(COMPACT_MARKDOWN_PATH, "gu")),
  ].map((match) => match[0] ?? "");
  return [...quoted, ...labelled, ...compact]
    .map((value) => normalizeTargetV1(value))
    .filter((value) => /\.md$/iu.test(value));
}

function normalizeTargetV1(value: string): string {
  return value
    .trim()
    .replace(/\\/gu, "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/^\/+/gu, "")
    .replace(/\/+$/gu, "")
    .trim();
}

/**
 * Returns the exact distinct destinations the objective names for `toolName`,
 * or an empty list when it names fewer than two. An empty list means "keep the
 * single-node plan this mission already got" — never "plan nothing".
 */
export function deriveRepeatedOperationTargetsV1(input: {
  toolName: string;
  objective: string;
}): string[] {
  const kind = OPERATION_KIND_BY_TOOL_NAME.get(input.toolName);
  if (!kind || typeof input.objective !== "string") return [];
  const objective = input.objective.trim();
  if (!objective) return [];

  const governingVerb = GOVERNING_VERBS[kind];
  const collect =
    kind === "vault_folder_create"
      ? folderTargetsInClauseV1
      : markdownTargetsInClauseV1;

  const targets: string[] = [];
  let governed = false;
  for (const clause of splitClausesV1(objective)) {
    const governs = governingVerb.test(clause);
    const neutralizes = NEUTRALIZING_VERBS.test(clause);
    // A clause with a competing verb never inherits governance, and a clause
    // with the operation's own verb always claims its destinations even when
    // it also mentions a neutral verb ("create Projects/Brief.md summarizing
    // the sources").
    if (governs) {
      governed = true;
    } else if (neutralizes) {
      governed = false;
      continue;
    }
    if (!governed) continue;
    // Keep only the destination head of the clause, then stop eliding: a
    // source or content marker turns every later coordinate into part of the
    // source list, not another destination.
    const marker = SOURCE_OR_CONTENT_MARKER.exec(clause);
    const destinationHead = marker ? clause.slice(0, marker.index) : clause;
    for (const target of collect(destinationHead)) {
      if (!targets.includes(target)) targets.push(target);
    }
    if (marker) governed = false;
  }

  // One destination is not a repeated operation: today's single node already
  // serves it, and returning it here would silently re-author every
  // single-target plan.
  if (targets.length < 2) return [];
  return targets.slice(0, MAX_REPEATED_OPERATION_TARGETS_V1);
}

/** The exact per-instance objective a repeated-operation node carries. */
export function repeatedOperationNodeObjectiveV1(
  toolName: string,
  target: string,
): string {
  switch (OPERATION_KIND_BY_TOOL_NAME.get(toolName)) {
    case "vault_folder_create":
      return `Create the exact named vault folder ${target}.`;
    case "vault_file_create":
      return `Create the exact new vault note ${target} without overwrite.`;
    case "vault_file_append":
      return `Append to the exact named vault note ${target}.`;
    case "vault_file_replace":
      return `Replace the exact named vault note ${target}.`;
    case "vault_path_delete":
      return `Delete the exact named vault path ${target}.`;
    default:
      return `Run ${toolName} against the exact named target ${target}.`;
  }
}
