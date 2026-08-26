/**
 * Off-frontier near-miss teaching, reject categories, and eval records.
 */

export type ToolRejectCategoryV1 =
  | "unknown_tool"
  | "missing_argument"
  | "invalid_argument"
  | "extra_argument"
  | "unauthorized"
  | "invalid_state"
  | "ambiguous_target"
  | "policy_rejection"
  | "rate_limit_or_transient"
  | "frontier_narrowed"
  | "frontier_withheld"
  | "placeholder_tool_name"
  | "other";

/**
 * Refusal code for a call the host DID offer at step start and then refused
 * because the menu was rebuilt mid-response. Deliberately carries no
 * `tool_not_allowed` substring: the shared refusal vocabulary buckets by
 * substring match, and this case must not keep inflating the bucket that
 * means "the model named a tool it was never offered".
 */
export const FRONTIER_NARROWED_REFUSAL_CODE_V1 = "frontier_narrowed_mid_response";

/**
 * Refusal code for a call the host offered in an EARLIER step of this run and
 * has since withheld. Like the mid-response code, it deliberately shares no
 * substring with `tool_not_allowed`, and none with the mid-response code
 * either, so the three populations stay separately countable.
 */
export const FRONTIER_WITHHELD_REFUSAL_CODE_V1 =
  "frontier_withheld_since_earlier_step";

/**
 * Why a call name was not on the live menu when the host validated it.
 *
 * `AgentRunner` clears and rebuilds `stepAllowedToolNames` after every
 * committed call in a multi-call response, so calls 2..N are validated
 * against a menu that changed AFTER the model answered. Without this fact
 * recorded, a host-caused refusal is indistinguishable in the run record
 * from a model naming a tool it never saw -- both surfaced as
 * `tool_not_allowed`, and the census attributed both to the model.
 */
export type OffFrontierRefusalProvenanceV1 =
  /**
   * The name is an unfilled function-calling template (`$TOOL_NAME` and
   * friends), not a tool selection at all. Model-side, but a FORMATTING
   * failure: the model never chose a wrong tool, it failed to substitute.
   * Observed live in a compound-flow trace, 2026-08-26.
   */
  | "model_emitted_placeholder_name"
  /** The step-start menu never carried this name. Genuine misselection. */
  | "model_named_unoffered_tool"
  /** Offered at step start; refused only because an earlier call in the SAME response rebuilt the menu. */
  | "host_narrowed_mid_response"
  /**
   * Offered in an EARLIER step of this run and withheld since. The model's
   * selection was correct at the moment it learned it; the host changed the
   * menu underneath. Distinct from every other class because the remedy is
   * not name resolution -- it is telling the model the menu changed and why.
   */
  | "host_withheld_since_earlier_step"
  /**
   * Offered at step start and refused at index 0, before any rebuild could
   * run. Unreachable through the step-menu gate by construction; recorded
   * rather than folded into either bucket so that if the offered menu and
   * the validating menu ever disagree at the first call, it shows up as
   * data instead of silently reading as a model error.
   */
  | "host_narrowed_before_first_call";

/** Recorded facts behind one off-frontier refusal. */
export interface OffFrontierRefusalFactsV1 {
  /** Was this name on the menu the model actually answered? */
  offeredAtStepStart: boolean;
  /** 0-based position of this call inside the provider response. */
  responseCallIndex: number;
  /** How many tool calls that one provider response carried. */
  responseCallCount: number;
  /** Names offered at step start that the live menu no longer carries. */
  droppedSinceStepStart: string[];
  /** Was this name offered in an EARLIER step of this run? */
  offeredInEarlierStep: boolean;
  /** The most recent earlier step that offered it, when known. */
  lastOfferedAtStep: number | null;
  /** Which menu transform last withheld it, when known. */
  withheldBy: string | null;
  provenance: OffFrontierRefusalProvenanceV1;
}

const cleanNames = (names: readonly string[]): string[] =>
  names.map((name) => name.trim()).filter(Boolean);

/**
 * Explicit placeholder tokens seen in unfilled function-calling templates.
 * Every real tool in this product is lower_snake_case and none of these is a
 * registered name, so matching them cannot shadow a genuine selection.
 */
const UNFILLED_TOOL_NAME_PLACEHOLDER_TOKENS = new Set([
  "tool_name",
  "toolname",
  "tool",
  "function_name",
  "functionname",
  "your_tool_name",
  "name",
]);

/**
 * CLASSIFICATION ONLY -- this never rewrites or repairs a call.
 *
 * A model that emits `$TOOL_NAME` did not choose the wrong tool; it failed to
 * substitute into its own template. That is a different diagnosis with a
 * different fix from naming a real-but-unoffered tool, and lumping the two
 * into one bucket hides both. Detection is syntactic (template sigils) plus a
 * closed token list, never "this name is unfamiliar" -- an unfamiliar name is
 * exactly what genuine misselection looks like, and must stay in its own
 * class.
 *
 * Repairing a placeholder into the offered tool is a separate, narrower
 * concern owned elsewhere (prod/continuation-final-only-heal): it only rewrites
 * when exactly one read-effect tool is offered. This predicate deliberately
 * does not duplicate that decision -- it only labels what reached the gate.
 */
export function looksLikeUnfilledToolNamePlaceholderV1(
  toolName: string | null | undefined,
): boolean {
  const raw = String(toolName ?? "").trim();
  if (!raw) return false;
  // Template sigils: $TOOL, ${tool}, {{tool}}, <tool_name>, [tool], %tool%.
  if (/^[$%]/u.test(raw)) return true;
  if (/^\{\{.*\}\}$/u.test(raw)) return true;
  if (/^\{.*\}$/u.test(raw)) return true;
  if (/^<.*>$/u.test(raw)) return true;
  if (/^\[.*\]$/u.test(raw)) return true;
  if (/%$/u.test(raw) && raw.includes("%")) return true;
  // Bare template words, with or without separators/case decoration.
  const bare = raw.replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return UNFILLED_TOOL_NAME_PLACEHOLDER_TOKENS.has(bare.toLowerCase());
}

/**
 * The one answer to "was this refused name on the step-start offered menu,
 * and did the host narrow it away mid-response?". Every seat that reports an
 * off-frontier refusal reads this; none re-derives it.
 */
export function classifyOffFrontierRefusalV1(input: {
  toolName: string;
  /** The menu offered to the model at the start of this step. */
  offeredAtStepStartToolNames: readonly string[];
  /** The menu the call was actually validated against. */
  liveReadyToolNames: readonly string[];
  responseCallIndex: number;
  responseCallCount: number;
  /**
   * The most recent EARLIER step of this run whose offered menu carried this
   * name, or null when no earlier step did. The caller owns the history and
   * the "earlier than now" comparison; this predicate only reads the answer.
   */
  lastOfferedAtStep?: number | null;
  /** Which menu transform last withheld it, when the caller knows. */
  withheldBy?: string | null;
}): OffFrontierRefusalFactsV1 {
  const toolName = input.toolName.trim();
  const offered = new Set(cleanNames(input.offeredAtStepStartToolNames));
  const live = new Set(cleanNames(input.liveReadyToolNames));
  const offeredAtStepStart = offered.has(toolName);
  const responseCallIndex = Number.isFinite(input.responseCallIndex)
    ? Math.max(0, Math.trunc(input.responseCallIndex))
    : 0;
  const responseCallCount = Number.isFinite(input.responseCallCount)
    ? Math.max(0, Math.trunc(input.responseCallCount))
    : 0;
  const lastOfferedAtStep =
    typeof input.lastOfferedAtStep === "number" &&
    Number.isFinite(input.lastOfferedAtStep)
      ? input.lastOfferedAtStep
      : null;
  const offeredInEarlierStep = lastOfferedAtStep !== null;
  return {
    offeredAtStepStart,
    responseCallIndex,
    responseCallCount,
    droppedSinceStepStart: [...offered].filter((name) => !live.has(name)),
    offeredInEarlierStep,
    lastOfferedAtStep,
    withheldBy: input.withheldBy?.trim() || null,
    // Precedence is by strength of evidence about WHO changed what:
    //  1. the host offered it this very step  -> a rebuild took it away;
    //  2. the host offered it in an earlier step -> the menu decayed under
    //     a model that had already been taught the name;
    //  3. otherwise the model produced a name the host never offered, which
    //     splits again into an unfilled template and a real misselection.
    // A name the host DID offer is never a placeholder, whatever it looks
    // like: the menu is the authority on what is a real tool here.
    provenance: offeredAtStepStart
      ? responseCallIndex > 0
        ? "host_narrowed_mid_response"
        : "host_narrowed_before_first_call"
      : offeredInEarlierStep
        ? "host_withheld_since_earlier_step"
        : looksLikeUnfilledToolNamePlaceholderV1(toolName)
          ? "model_emitted_placeholder_name"
          : "model_named_unoffered_tool",
  };
}

/**
 * True when the refusal is host-caused menu drift WITHIN one response rather
 * than the model naming a tool it was never shown.
 */
export function isHostNarrowedOffFrontierRefusalV1(
  facts: OffFrontierRefusalFactsV1,
): boolean {
  return facts.provenance === "host_narrowed_mid_response";
}

/**
 * True when the refusal is host-caused menu decay ACROSS steps: the model was
 * taught this name earlier in the same run and the host stopped offering it.
 */
export function isHostWithheldOffFrontierRefusalV1(
  facts: OffFrontierRefusalFactsV1,
): boolean {
  return facts.provenance === "host_withheld_since_earlier_step";
}

/**
 * True when the refusal is host-caused at all -- the union of menu drift
 * within a response and menu decay across steps. This is the share of the
 * `tool_not_allowed` population that no amount of model improvement can fix.
 */
export function isHostCausedOffFrontierRefusalV1(
  facts: OffFrontierRefusalFactsV1,
): boolean {
  return (
    isHostNarrowedOffFrontierRefusalV1(facts) ||
    isHostWithheldOffFrontierRefusalV1(facts) ||
    facts.provenance === "host_narrowed_before_first_call"
  );
}

export type ToolRejectEvalV1 = {
  userIntentExcerpt: string;
  selectedTool: string;
  argumentsSummary?: string;
  expectedPrerequisite?: string | null;
  result: "rejected";
  errorCategory: ToolRejectCategoryV1 | string;
  retryCount: number;
  readyFrontier: string[];
  /**
   * Off-frontier provenance, when the refusal came from the step-menu gate.
   * This is what converts "26 tool_not_allowed" from an ambiguity into a
   * split between model-side naming errors and host-side menu drift.
   */
  offFrontier?: OffFrontierRefusalFactsV1;
};

export function mapToolRejectCategory(input: {
  toolName: string;
  message?: string | null;
  code?: string | null;
  pendingGraphNodeId?: string | null;
}): ToolRejectCategoryV1 {
  const message = String(input.message ?? "").toLowerCase();
  const code = String(input.code ?? "").toLowerCase();
  const blob = `${message} ${code}`;

  // Host-side menu drift is not the model naming an unknown tool: the host
  // offered this exact name at the start of the step. It must be checked
  // first, or the unknown_tool arm below claims it and the eval record
  // repeats the misattribution this code exists to end.
  if (
    new RegExp(FRONTIER_NARROWED_REFUSAL_CODE_V1, "i").test(blob) ||
    /offered at the start of this step/i.test(blob)
  ) {
    return "frontier_narrowed";
  }
  if (
    /unknown tool|not available for this prompt|off-frontier|tool_not_allowed/i.test(
      blob,
    ) ||
    input.pendingGraphNodeId
  ) {
    return "unknown_tool";
  }
  if (/missing.*argument|required.*(field|literal)|omitted/i.test(blob)) {
    return "missing_argument";
  }
  if (/invalid.*argument|wrong type|enum|schema correction|literal/i.test(blob)) {
    return "invalid_argument";
  }
  if (/extra argument|unsupported field|additional propert/i.test(blob)) {
    return "extra_argument";
  }
  if (
    /approval|unauthorized|preauthorized_authority|denied|expired/i.test(blob)
  ) {
    return "unauthorized";
  }
  if (
    /ambiguous|multi-?match|reconcile.*ambigu/i.test(blob)
  ) {
    return "ambiguous_target";
  }
  if (
    /plan_dependency|envelope|passing_fast|code_spec_binding|not ready|invalid state|workflow/i.test(
      blob,
    )
  ) {
    return "invalid_state";
  }
  if (/policy|safety|blocked|disallowed/i.test(blob)) {
    return "policy_rejection";
  }
  if (/rate.?limit|transient|timeout|econnreset|503|429/i.test(blob)) {
    return "rate_limit_or_transient";
  }
  return "other";
}

export function describeOffFrontierToolNearMiss(
  toolName: string,
  readyFrontierToolNames: readonly string[] = [],
): string | null {
  const name = toolName.trim().toLowerCase();
  if (!name) return null;
  const ready = new Set(
    readyFrontierToolNames.map((entry) => entry.trim()).filter(Boolean),
  );
  const listedAmong = (...candidates: string[]): string[] =>
    candidates.filter((candidate) => ready.has(candidate));

  if (
    name === "verify_all" ||
    name === "verify_project" ||
    name === "validate" ||
    name === "validate_all" ||
    name.endsWith("verify_all") ||
    name.endsWith("verify_project")
  ) {
    const listed = listedAmong(
      "code_validate_fast",
      "code_validate_targeted",
      "code_validate_full",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed.join(" or ")} now (repo scripts/verify_*.py are not tools).`;
    }
    return "Near-miss: use code_validate_fast, code_validate_targeted, or code_validate_full when listed on the frontier (repo scripts/verify_*.py are not tools).";
  }

  if (
    name === "patch" ||
    name === "replace" ||
    name === "replace_workspace_text" ||
    name === "write_workspace_file"
  ) {
    const listed = listedAmong(
      "code_workspace_write_expected",
      "code_workspace_patch",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed.join(" or ")} now; do not invent patch/replace tool names.`;
    }
    return "Near-miss: use code_workspace_patch or code_workspace_write_expected when listed on the frontier.";
  }

  if (
    name === "commit" ||
    name === "git_commit" ||
    name === "git_add" ||
    name === "git commit"
  ) {
    const listed = listedAmong("code_commit_verified");
    if (listed.length > 0) {
      return "Near-miss: call code_commit_verified now (host runs git add + commit; do not invent git_* tools).";
    }
    return "Near-miss: use code_commit_verified when listed on the frontier (host git add+commit).";
  }

  if (
    name === "create_repo" ||
    name === "create_repository" ||
    name === "github_create_repo"
  ) {
    const listed = listedAmong(
      "github_create_repository",
      "github_create_private_repository",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed[0]} now; repository visibility must come from the user's explicit public/private choice.`;
    }
    return "Near-miss: use github_create_repository when listed on the frontier; never infer public or private visibility.";
  }

  if (
    name === "publish" ||
    name === "push" ||
    name === "git_push" ||
    name === "create_pr" ||
    name === "draft_pr" ||
    name === "create_pull_request"
  ) {
    const listed = listedAmong(
      "publish_verified_code_to_github",
      "github_publish_verified_branch",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed.join(" or ")} now for publish_draft.`;
    }
    return "Near-miss: use publish_verified_code_to_github when listed on the frontier.";
  }

  if (
    name === "linear_create" ||
    name === "create_issue" ||
    name === "create_linear_issue"
  ) {
    const listed = listedAmong(
      "linear_create_issue",
      "publish_research_to_linear",
      "publish_research_project_to_linear",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed.join(" or ")} now.`;
    }
    return "Near-miss: use linear_create_issue or publish_research_to_linear when listed on the frontier.";
  }

  if (name === "search" || name === "search_notes" || name === "search_vault") {
    const listed = listedAmong(
      "semantic_search_notes",
      "search_markdown_files",
      "web_search",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed.join(" or ")} now.`;
    }
    return "Near-miss: use semantic_search_notes or search_markdown_files when listed on the frontier.";
  }

  if (
    name === "code_workspace_write_expected" &&
    ready.has("code_repair_record_cycle")
  ) {
    return "Near-miss: call code_repair_record_cycle now to open the next correction cycle before writing.";
  }
  if (
    (name === "code_validate_fast" ||
      name === "code_validate_targeted" ||
      name === "code_validate_full") &&
    ready.has("code_repair_record_cycle")
  ) {
    return "Near-miss: call code_repair_record_cycle now; do not re-validate until the repair cycle opens corrections.";
  }
  if (name === "read_file" || name === "read" || name === "read_markdown_files") {
    if (ready.has("code_workspace_read")) {
      return "Near-miss: call code_workspace_read now for workspace or protected scripts.";
    }
    return "Near-miss: for workspace or protected scripts, use code_workspace_read when listed on the frontier.";
  }
  if (name === "create_file" || name === "write_file" || name === "mkdir") {
    const listed = listedAmong(
      "code_workspace_create_file",
      "code_workspace_mkdir",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed.join(" or ")} now.`;
    }
    return "Near-miss: use code_workspace_create_file or code_workspace_mkdir when listed on the frontier.";
  }
  return null;
}

export function buildOffFrontierToolRejectionMessage(input: {
  toolName: string;
  pendingGraphNodeId?: string | null;
  readyFrontierToolNames: readonly string[];
  preferredNextTool?: string | null;
  category?: ToolRejectCategoryV1 | string | null;
  /**
   * The refusing subsystem's real reason text. Classification must read
   * THIS, not a hardcoded stand-in: an authority refusal saying "not ready
   * in the authoritative mission graph" is `invalid_state`, and stamping it
   * `unknown_tool` mislabels every authority refusal of a tool the model
   * was correctly offered (proof-matrix interrupted-continuation,
   * 2026-08-25).
   */
  reasonMessage?: string | null;
  /**
   * Write tools currently held by proof verification. A held tool may sit on
   * the ready frontier (the graph considers it ready), but the proof gate
   * will hold it again on the very next call -- so this message must never
   * advise it, or the rejection commands the call another subsystem forbids.
   */
  heldWriteToolNames?: readonly string[];
  /**
   * Off-frontier provenance from `classifyOffFrontierRefusalV1`. When it
   * reports host-side menu drift, "Tool is not available for this prompt" is
   * simply false -- the host listed this exact name in the menu the model
   * answered -- and a model that can see the contradiction has no correction
   * to make. Say what actually happened instead.
   */
  offFrontier?: OffFrontierRefusalFactsV1 | null;
}): string {
  const frontier =
    input.readyFrontierToolNames.length > 0
      ? input.readyFrontierToolNames.join(", ")
      : "none";
  const hostNarrowed =
    input.offFrontier != null &&
    isHostNarrowedOffFrontierRefusalV1(input.offFrontier);
  const hostWithheld =
    input.offFrontier != null &&
    isHostWithheldOffFrontierRefusalV1(input.offFrontier);
  const placeholderName =
    input.offFrontier?.provenance === "model_emitted_placeholder_name";
  const nearMiss =
    hostNarrowed || hostWithheld || placeholderName
      ? // Near-miss teaching maps one INTENDED name onto the right one. A
        // host-narrowed or host-withheld call already had the right name, and
        // a placeholder never expressed an intent to map.
        null
      : describeOffFrontierToolNearMiss(
          input.toolName,
          input.readyFrontierToolNames,
        );
  const category =
    input.category ??
    (hostNarrowed
      ? "frontier_narrowed"
      : hostWithheld
        ? "frontier_withheld"
        : placeholderName
        ? "placeholder_tool_name"
        : mapToolRejectCategory({
          toolName: input.toolName,
          pendingGraphNodeId: input.pendingGraphNodeId,
          message:
            input.reasonMessage?.trim() ||
            (input.pendingGraphNodeId
              ? "off-frontier"
              : "not available for this prompt"),
        }));
  const heldWriteTools = new Set(
    (input.heldWriteToolNames ?? []).filter(Boolean),
  );
  const preferred =
    input.preferredNextTool?.trim() ||
    input.readyFrontierToolNames
      .filter((name) => !heldWriteTools.has(name))
      .slice(0, 3)
      .filter(Boolean)
      .join(", ") ||
    "none";
  const base = placeholderName
    ? `Rejected ${input.toolName}: that is an unfilled template placeholder, not a tool name.`
    : hostNarrowed
    ? `Deferred ${input.toolName}: it WAS offered at the start of this step. ` +
      `This was call ${(input.offFrontier?.responseCallIndex ?? 0) + 1} of ` +
      `${input.offFrontier?.responseCallCount ?? 1} in one response, and an earlier ` +
      `call in that same response advanced the mission graph past this tool's planned slot.`
    : hostWithheld
      ? `Deferred ${input.toolName}: THE MENU CHANGED. It was offered at step ` +
        `${input.offFrontier?.lastOfferedAtStep ?? "an earlier step"} of this run and has been ` +
        `withheld since.`
      : input.pendingGraphNodeId
        ? `Deferred ${input.toolName}: authoritative mission node ${input.pendingGraphNodeId} is not on the ready frontier.`
        : `Tool is not available for this prompt: ${input.toolName}`;
  // The model can see it was offered this name moments ago. Telling it the
  // name is unavailable invites a retry loop against a contradiction it
  // cannot resolve. Name the real state and the real remedy instead.
  const narrowedNote = hostNarrowed
    ? `${input.toolName} is not an invalid name and nothing about this call was malformed; ` +
      `the mission graph simply has no remaining ready slot for it. Nothing was executed for this call.`
    : "";
  // A refusal that says only "not offered" after having offered the tool for
  // several steps teaches the model nothing it can act on. Say WHY the menu
  // changed whenever the withholding transform is known.
  const withheldNote = hostWithheld
    ? `Your name selection was correct when you learned it; the offered menu has since changed. ` +
      (input.offFrontier?.withheldBy
        ? `Reason: ${input.offFrontier.withheldBy}. `
        : "") +
      `Do not keep re-issuing ${input.toolName}; work from the ready frontier above or return your final answer.`
    : "";
  // "Preferred next" is ordering, not dependency reasoning: pickPreferredNextTool
  // returns the first unpaid delivery tool that happens to be ready, otherwise
  // the first ready name. It has never known what unblocks the deferred node.
  // Read as "call this and the deferred tool opens", it produces a loop -- call
  // the hint, retry the deferred tool, get the identical refusal. Say what is
  // actually true so the model stops re-attempting the deferred call.
  const deferredNote = input.pendingGraphNodeId
    ? `${input.toolName} stays refused until its own node is ready; calling the preferred tool does not by itself open it.`
    : "";
  // A verification hold has already told the model to return the corrected
  // content as its final answer; "call that exact name" for the held tool
  // would command the very call the gate holds again, and the model burns
  // turns reconciling the two. When the frontier offers nothing but held
  // tools, the frontier listing stays (it is factual) but no call directive
  // may appear -- there is nothing safe to call.
  const heldFrontierTools = input.readyFrontierToolNames.filter((name) =>
    heldWriteTools.has(name),
  );
  const heldPreferred = heldWriteTools.has(preferred)
    ? preferred
    : preferred === "none" && heldFrontierTools.length > 0
      ? heldFrontierTools.join(", ")
      : null;
  const preferredLine = heldPreferred
    ? `${heldPreferred} is currently held by proof verification — return the corrected note content as your final answer instead of calling it.`
    : preferred === "none"
      ? // "Preferred next: none. Call that exact name." literally instructs the
        // model to call a tool named "none". When nothing is callable, say so.
        "No tool is ready to call; return your best final answer instead."
      : `Preferred next: ${preferred}. Call that exact name.`;
  return [
    base,
    `category=${category}`,
    `Ready frontier tool(s) now: ${frontier}.`,
    preferredLine,
    deferredNote,
    narrowedNote,
    withheldNote,
    nearMiss ?? "",
    hostNarrowed
      ? "Continue from the ready frontier; do not re-issue this call in this turn."
      : hostWithheld
        ? ""
        : "Correct only that issue; do not repeat this exact call.",
  ]
    .filter(Boolean)
    .join(" ");
}

export type ProofGatedWritebackBoundaryV1 = "pre_mutation" | "commit";

export type ProofGatedWritebackQuoteCorrectionV1 = {
  passageId: string;
  attempted: string;
  passageExcerpt: string;
};

export type ProofGatedWritebackHoldV1 = {
  /** Tool-result message the model reads. */
  message: string;
  /** System corrective pushed after the tool result. */
  systemCorrective: string;
  /**
   * Non-null only on the verification-required arm, whose message promises
   * "return the content as the final answer". Refusal builders consume it as
   * `heldWriteToolNames` so they stop advising the very tool this hold keeps
   * holding.
   */
  heldWriteToolName: string | null;
  /** True only on the evidence-incomplete arm, which narrows the frontier. */
  narrowsOfferedFrontier: boolean;
};

/**
 * ONE implementation of the proof-gated writeback hold, consumed by both
 * seats that can hold the same write for the same reason.
 *
 * The two seats had drifted: the step-loop hold taught a remedy, remembered
 * the held tool name, and pushed a corrective; the mutation-boundary hold —
 * the LAST gate before bytes land — said only "the final payload does not
 * satisfy the closed fetched-source proof contract" and stopped. A model held
 * there is told a contract was violated and never told what to do instead, so
 * it retries, and the evidence arm narrows the frontier for retrying. It also
 * never fed `heldWriteToolName`, so off-frontier refusals kept advising the
 * exact tool the boundary was holding.
 *
 * `boundary` selects only the cause clause, so each seat's existing wording is
 * preserved byte-for-byte; the remedy, the corrective, and the two side-effect
 * decisions are shared. `missing` is the message's own detail list;
 * `blockingProofs` is the corrective's, because the two seats compute them
 * from different acceptance snapshots.
 */
export function buildProofGatedWritebackHoldV1(input: {
  toolName: string;
  boundary: ProofGatedWritebackBoundaryV1;
  /** `durablePreWriteProofSatisfied` — false selects the evidence arm. */
  evidenceSatisfied: boolean;
  missing?: readonly string[];
  blockingProofs?: readonly string[];
  quoteCorrections?: readonly ProofGatedWritebackQuoteCorrectionV1[];
}): ProofGatedWritebackHoldV1 {
  const missingDetail = input.missing?.length
    ? ` (${input.missing.join(", ")})`
    : "";
  const quoteCorrectionTail = (input.quoteCorrections ?? [])
    .map(
      (correction) =>
        ` Quote correction for ${correction.passageId}: your draft quoted "${correction.attempted}" but the cited passage actually reads: "${correction.passageExcerpt}".`,
    )
    .join("");
  const cause =
    input.boundary === "commit"
      ? `Held ${input.toolName} at the mutation boundary because the final payload does not satisfy the closed fetched-source proof contract${missingDetail}. No note bytes were changed.`
      : input.evidenceSatisfied
        ? `Held ${input.toolName} before mutation because this sourced writeback requires final passage verification${missingDetail}.`
        : `Held ${input.toolName} before mutation because required research evidence is still incomplete${missingDetail}.`;
  const remedy = input.evidenceSatisfied
    ? `Return the complete corrected note content as the final answer without another write tool call; read tools such as web_search or read_source_section may still be used first to verify exact quotations. The runner will verify and commit the final content exactly once.${quoteCorrectionTail}`
    : "Continue with the allowed read and research tools before drafting the final writeback.";
  const systemCorrective = input.evidenceSatisfied
    ? "Do not request a current-note write tool again. Return the complete sourced markdown as your final answer. The runner will hold it, verify passage ids and quotation spans, and perform the single authorized note mutation only after verification passes."
    : `Do not request a current-note write tool again yet. Continue with allowed read or research tools until these blocking proof requirements are satisfied: ${
        input.blockingProofs?.join(", ") || "required research evidence"
      }. Only then return the complete sourced markdown for final verification.`;
  return {
    message: `${cause} ${remedy}`,
    systemCorrective,
    heldWriteToolName: input.evidenceSatisfied ? input.toolName : null,
    narrowsOfferedFrontier: !input.evidenceSatisfied,
  };
}

/**
 * The corrective for a call that failed twice with identical arguments.
 *
 * The FIRST such failure has always received a rich corrective (a schema, a
 * named prerequisite tool, an exact section list). The repeat received a
 * ledger blocker and a trace and nothing else — the host decided to stop
 * retrying and never told the model, so the model's next turn is spent
 * guessing against a decision it cannot see. Both repeat seats now say the
 * same thing, once.
 */
export function buildRepeatedInvalidToolCallCorrectiveV1(input: {
  toolName: string;
  failureCode: string;
  readyFrontierToolNames: readonly string[];
}): string {
  const alternatives = input.readyFrontierToolNames
    .map((name) => name.trim())
    .filter((name) => Boolean(name) && name !== input.toolName);
  return [
    `Blocked ${input.toolName}: the same arguments failed twice (${input.failureCode}), so this exact call will not be attempted again.`,
    alternatives.length > 0
      ? `Either change the arguments, or call one of these exact names instead: ${alternatives.join(", ")}.`
      : `No other tool is ready. Either change the arguments, or return your best final answer and state in one sentence that ${input.toolName} could not be completed.`,
    "Do not repeat this exact call.",
  ].join(" ");
}

export function buildToolRejectEvalV1(input: {
  userIntentExcerpt: string;
  selectedTool: string;
  argumentsSummary?: string;
  expectedPrerequisite?: string | null;
  errorCategory: ToolRejectCategoryV1 | string;
  retryCount?: number;
  readyFrontier: readonly string[];
  offFrontier?: OffFrontierRefusalFactsV1 | null;
}): ToolRejectEvalV1 {
  return {
    userIntentExcerpt: String(input.userIntentExcerpt ?? "").slice(0, 400),
    selectedTool: input.selectedTool,
    argumentsSummary: input.argumentsSummary
      ? String(input.argumentsSummary).slice(0, 400)
      : undefined,
    expectedPrerequisite: input.expectedPrerequisite ?? null,
    result: "rejected",
    errorCategory: input.errorCategory,
    retryCount: input.retryCount ?? 0,
    readyFrontier: [...input.readyFrontier].slice(0, 24),
    ...(input.offFrontier
      ? {
          offFrontier: {
            ...input.offFrontier,
            droppedSinceStepStart: input.offFrontier.droppedSinceStepStart.slice(
              0,
              24,
            ),
          },
        }
      : {}),
  };
}
