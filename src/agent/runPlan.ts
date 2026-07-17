import type { AgentSettings } from "../settings";
import type { ModelThink, ModelToolDefinition } from "../model/types";
import type { MissionIntent } from "../tools/types";
import {
  buildRouteBudgetProfile,
  estimateLoopBudget,
  resolveConfiguredMaxAgentSteps,
  type RouteBudgetProfile,
} from "./runBudget";
import { analyzeGeneratedOutputPrompt } from "./generatedOutputPolicy";
import { isCurrentNoteReplaceResetPrompt } from "./currentNoteResetPolicy";
import { planLoopBudget } from "./loopPlanner";
import type { ReflexDecision } from "./reflex/types";
import { isTitleOnlyIntent } from "./titleIntent";
import {
  isCurrentNoteEditOrganizeIntent,
  isNamedSectionEditIntent,
  isVaultWideOrganizeIntent,
  isWholeNoteEditIntent,
  prefersStreamedReplaceForEditOrganize,
} from "./editOrganizeIntent";
import { hasDesignIntent as hasSharedDesignIntent } from "./codeDesignIntent";
import { hasExplicitNoWebIntent } from "./evidenceIntent";

export type RunRoute =
  | "instant_local"
  | "direct_writeback"
  | "prefetched_vault_answer"
  | "prefetched_vault_writeback"
  | "single_model_answer"
  | "single_model_writeback"
  | "tool_required"
  | "grounded_workflow";

export type SlowPathReason =
  | "none"
  | "needs_current_note"
  | "needs_web_sources"
  | "needs_vault_context"
  | "needs_graph_context"
  | "needs_word_count"
  | "needs_edit_or_replace"
  | "needs_model_planning";

export type StreamingWritebackKind = "append" | "replace" | "edit";

export interface RunPlan {
  route: RunRoute;
  maxStepsForRun: number;
  thinking: ModelThink | undefined;
  allowedTools: ModelToolDefinition[];
  slowPathReason: SlowPathReason;
  expectedTimeClass: "quick" | "normal" | "long";
  requiresEnglishGuard: boolean;
}

export interface CreateRunPlanInput {
  prompt: string;
  missionIntent: MissionIntent;
  tools: ModelToolDefinition[];
  settings?: AgentSettings;
  streamingWritebackKind: StreamingWritebackKind | null;
  directCurrentNoteWritebackKind: StreamingWritebackKind | null;
  reflex?: ReflexDecision | null;
}

export interface RunPlanDecision extends RunPlan {
  allowedToolNames: string[];
  traceReasons: string[];
  budgetProfile: RouteBudgetProfile;
}

export function createRunPlan({
  prompt,
  missionIntent,
  tools,
  settings,
  streamingWritebackKind,
  directCurrentNoteWritebackKind,
  reflex,
}: CreateRunPlanInput): RunPlanDecision {
  const requiresEnglishGuard = isLikelyEnglishPrompt(prompt);
  const configuredMaxSteps = resolveConfiguredMaxAgentSteps(settings?.maxAgentSteps);
  const explicitModelStepTarget = parseExplicitModelStepTarget(prompt);
  const allowReflexReadRouting =
    !missionIntent.explicitMutation && !missionIntent.explicitDelete;
  const explicitWebSearchIntent =
    hasWebSearchIntent(prompt) && countExplicitCodeToolNames(prompt) === 0;
  const hasReflexReadLabel = (labels: ReflexDecision["label"][]) =>
    allowReflexReadRouting && hasSafeReflexLabel(reflex ?? null, labels);
  const capSteps = (steps: number) =>
    estimateLoopBudget({
      route: "tool_required",
      configuredMaxSteps,
      requestedSteps: steps,
    });
  const applyExplicitModelStepTarget = (steps: number) =>
    explicitModelStepTarget === null ? steps : capSteps(explicitModelStepTarget);

  const plan = ({
    route,
    maxStepsForRun,
    thinking,
    allowedTools,
    slowPathReason,
    expectedTimeClass,
    traceReasons,
  }: Omit<RunPlanDecision, "requiresEnglishGuard" | "allowedToolNames" | "budgetProfile">): RunPlanDecision => {
    const allowedToolNames = allowedTools.map((tool) => tool.function.name);
    const generated = analyzeGeneratedOutputPrompt(prompt);
    const budgetProfile = buildRouteBudgetProfile({
      mission: prompt,
      route,
      requiresWeb:
        slowPathReason === "needs_web_sources" ||
        allowedToolNames.some((name) => name === "web_search" || name === "web_fetch"),
      requiresVaultContext:
        slowPathReason === "needs_vault_context" ||
        slowPathReason === "needs_graph_context" ||
        missionIntent.vaultContext,
      requiresWrite: missionIntent.requireWriteCompletion || missionIntent.explicitMutation,
      requiresVerification:
        generated.requiresGrounding ||
        slowPathReason !== "none" ||
        allowedToolNames.length > 0,
      explicitDeepResearch: hasLongResearchIntent(prompt),
      configuredMaxSteps,
      expectedTools: allowedToolNames.filter((name) =>
        /web_|semantic_|read_|count_words|run_code_block|create_|append_|replace_|rename_|highlight_/.test(name),
      ),
    });
    return {
      route,
      maxStepsForRun,
      thinking,
      allowedTools,
      allowedToolNames,
      slowPathReason,
      expectedTimeClass,
      requiresEnglishGuard,
      traceReasons,
      budgetProfile: {
        ...budgetProfile,
        maxSteps: maxStepsForRun,
      },
    };
  };

  const grounded = (
    slowPathReason: SlowPathReason,
    expectedTimeClass: RunPlan["expectedTimeClass"] = "long",
    traceReasons: string[],
  ) => {
    const generated = analyzeGeneratedOutputPrompt(prompt);
    const loopBudget = planLoopBudget({
      prompt,
      route: "grounded_workflow",
      generated,
      configuredMaxSteps,
    });
    return plan({
      route: "grounded_workflow",
      maxStepsForRun: applyExplicitModelStepTarget(
        Math.max(
          1,
          Math.min(
            loopBudget.hardCap,
            hasLongResearchIntent(prompt)
              ? loopBudget.hardCap
              : loopBudget.toolStepBudget + loopBudget.finalizationReserve,
          ),
        ),
      ),
      thinking: resolveThinkingMode(settings),
      allowedTools: tools,
      slowPathReason,
      expectedTimeClass,
      traceReasons,
    });
  };

  if (hasSimpleDateTimePrompt(prompt)) {
    return plan({
      route: "instant_local",
      maxStepsForRun: 0,
      thinking: undefined,
      allowedTools: [],
      slowPathReason: "none",
      expectedTimeClass: "quick",
      traceReasons: ["simple_date_time_prompt"],
    });
  }

  if (directCurrentNoteWritebackKind !== null) {
    return plan({
      route: "direct_writeback",
      maxStepsForRun: capSteps(1),
      thinking: undefined,
      allowedTools: [],
      slowPathReason: "none",
      expectedTimeClass: "quick",
      traceReasons: [`direct_current_note_writeback:${directCurrentNoteWritebackKind}`],
    });
  }

  if (hasGraphConnectionIntent(prompt) || hasReflexReadLabel(["graph_context"])) {
    return grounded("needs_graph_context", "normal", [
      hasGraphConnectionIntent(prompt) ? "graph_connection_intent" : "reflex_graph_context",
    ]);
  }

  if (shouldPrefetchVaultFolderAnswer(prompt, missionIntent)) {
    const route =
      missionIntent.noteOutput && streamingWritebackKind === "append"
        ? "prefetched_vault_writeback"
        : "prefetched_vault_answer";
    return plan({
      route,
      maxStepsForRun: capSteps(1),
      thinking: undefined,
      allowedTools: [],
      slowPathReason: "needs_vault_context",
      expectedTimeClass: "quick",
      traceReasons: ["prefetchable_vault_folder_answer"],
    });
  }

  if (
    isVaultWideOrganizeIntent(prompt) &&
    !isCurrentNoteEditOrganizeIntent(prompt) &&
    !missionIntent.explicitMutation &&
    !missionIntent.requireWriteCompletion
  ) {
    return grounded("needs_vault_context", "normal", [
      "vault_wide_organize_clarify",
    ]);
  }

  if (
    hasVaultContextQuestionIntent(prompt) ||
    hasVaultBrowseIntent(prompt) ||
    (!explicitWebSearchIntent &&
      hasReflexReadLabel(["vault_search", "semantic_vault_search"]))
  ) {
    return grounded("needs_vault_context", "normal", [
      hasVaultContextQuestionIntent(prompt)
        ? "vault_context_question_intent"
        : hasVaultBrowseIntent(prompt)
          ? "vault_browse_intent"
          : "reflex_vault_context",
    ]);
  }

  if (
    explicitWebSearchIntent ||
    hasReflexReadLabel(["web_research"])
  ) {
    return grounded("needs_web_sources", "long", [
      hasWebSearchIntent(prompt) ? "web_search_intent" : "reflex_web_research",
    ]);
  }

  if (hasLongResearchIntent(prompt) || hasBrowserAutomationIntent(prompt)) {
    return grounded("needs_model_planning", "long", [
      hasLongResearchIntent(prompt) ? "long_research_intent" : "browser_automation_intent",
    ]);
  }

  if (
    hasDesignIntent(prompt) ||
    hasCodeExecutionIntent(prompt) ||
    hasHtmlPreviewIntent(prompt) ||
    hasOpenWebSourceIntent(prompt)
  ) {
    const generated = analyzeGeneratedOutputPrompt(prompt);
    const loopBudget = planLoopBudget({
      prompt,
      route: "grounded_workflow",
      generated,
      configuredMaxSteps,
    });
    const explicitCodeToolCount = countExplicitCodeToolNames(prompt);
    const codeToolStepBudget = Math.max(
      loopBudget.toolStepBudget,
      explicitCodeToolCount,
    );
    return plan({
      route: "grounded_workflow",
      maxStepsForRun: applyExplicitModelStepTarget(
        Math.max(
          1,
          Math.min(
            loopBudget.hardCap,
            codeToolStepBudget + loopBudget.finalizationReserve,
          ),
        ),
      ),
      thinking: resolveThinkingMode(settings),
      allowedTools: tools,
      slowPathReason: "needs_model_planning",
      expectedTimeClass: "normal",
      traceReasons: [
        hasDesignIntent(prompt)
          ? "design_intent"
          : hasCodeExecutionIntent(prompt)
            ? "code_execution_intent"
            : hasHtmlPreviewIntent(prompt)
              ? "html_preview_intent"
              : "open_web_source_intent",
      ],
    });
  }

  if (hasWordCountIntent(prompt) || hasReflexReadLabel(["word_count"])) {
    return plan({
      route: "tool_required",
      maxStepsForRun: capSteps(3),
      thinking: undefined,
      allowedTools: tools,
      slowPathReason: "needs_word_count",
      expectedTimeClass: "quick",
      traceReasons: [
        hasWordCountIntent(prompt) ? "word_count_intent" : "reflex_word_count",
      ],
    });
  }

  if (hasResearchMemoryReadIntent(prompt)) {
    return plan({
      route: "tool_required",
      maxStepsForRun: capSteps(2),
      thinking: undefined,
      allowedTools: tools,
      slowPathReason: "needs_vault_context",
      expectedTimeClass: "quick",
      traceReasons: ["research_memory_read_intent"],
    });
  }

  // Title + content needs a tool step for rename_current_file before streamed
  // writeback. Do not take the single-step writeback route or the rename never
  // runs (or the run ends after rename with maxSteps=1 and no stream).
  if (
    streamingWritebackKind !== null &&
    !hasTitleIntent(prompt) &&
    !isTitleOnlyIntent(prompt)
  ) {
    return plan({
      route: "single_model_writeback",
      maxStepsForRun: capSteps(streamingWritebackKind === "edit" ? 3 : 1),
      thinking: undefined,
      allowedTools: tools,
      slowPathReason:
        streamingWritebackKind === "edit" ? "needs_edit_or_replace" : "none",
      expectedTimeClass: streamingWritebackKind === "edit" ? "normal" : "quick",
      traceReasons: [`streaming_writeback:${streamingWritebackKind}`],
    });
  }

  if (isNamedSectionEditIntent(prompt)) {
    return plan({
      route: "tool_required",
      maxStepsForRun: capSteps(3),
      thinking: undefined,
      allowedTools: tools,
      slowPathReason: "needs_edit_or_replace",
      expectedTimeClass: "normal",
      traceReasons: ["named_section_edit"],
    });
  }

  if (requiresCurrentNoteContent(prompt)) {
    const compoundTitleWriteback =
      hasTitleIntent(prompt) &&
      missionIntent.noteOutput &&
      streamingWritebackKind !== null;
    return plan({
      route: "tool_required",
      // A compound title + body mission needs room to observe the note,
      // obtain the explicit rename/retitle tool call, and hand the body to
      // runner-owned streamed writeback. Keep one bounded correction step so
      // a model that first answers with prose is not stopped before mutation.
      maxStepsForRun: capSteps(compoundTitleWriteback ? 4 : 2),
      thinking: undefined,
      allowedTools: tools,
      slowPathReason: "needs_current_note",
      expectedTimeClass: "quick",
      traceReasons: [
        "requires_current_note_content",
        ...(compoundTitleWriteback ? ["compound_title_writeback"] : []),
      ],
    });
  }

  // Current-note edit/organize prefers streamed replace; when stream kind was
  // not precomputed, still route as write/edit rather than chat-only.
  if (
    prefersStreamedReplaceForEditOrganize(prompt) ||
    isCurrentNoteEditOrganizeIntent(prompt) ||
    isWholeNoteEditIntent(prompt)
  ) {
    return plan({
      route: "single_model_writeback",
      maxStepsForRun: capSteps(1),
      thinking: undefined,
      allowedTools: tools,
      slowPathReason: "needs_edit_or_replace",
      expectedTimeClass: "quick",
      traceReasons: [
        isCurrentNoteEditOrganizeIntent(prompt)
          ? "current_note_edit_organize"
          : "whole_note_edit_replace",
      ],
    });
  }

  // Vault-wide organize without targets must not force a write-completion-only
  // tool_required dead-end (handled earlier when requireWriteCompletion is false).

  if (missionIntent.explicitMutation || missionIntent.requireWriteCompletion) {
    return plan({
      route: "tool_required",
      maxStepsForRun: capSteps(3),
      thinking: undefined,
      allowedTools: tools,
      slowPathReason: missionIntent.explicitMutation
        ? "needs_edit_or_replace"
        : "needs_model_planning",
      expectedTimeClass: "normal",
      traceReasons: [
        missionIntent.explicitMutation
          ? "explicit_mutation"
          : "write_completion_required",
      ],
    });
  }

  return plan({
    route: "single_model_answer",
    maxStepsForRun: applyExplicitModelStepTarget(capSteps(2)),
    thinking: undefined,
    allowedTools: tools,
    slowPathReason: "none",
    expectedTimeClass: "quick",
    traceReasons: ["default_single_model_answer"],
  });
}

export function resolveThinkingMode(
  settings: AgentSettings | undefined,
): ModelThink | undefined {
  const mode = settings?.thinkingMode ?? "auto";

  if (mode === "off") {
    return undefined;
  }

  if (mode !== "auto") {
    return mode;
  }

  const model = settings?.model?.trim().toLowerCase() ?? "";

  if (!model) {
    return undefined;
  }

  if (model.startsWith("gpt-oss")) {
    return "medium";
  }

  if (
    model.startsWith("qwen3") ||
    model.startsWith("deepseek-r1") ||
    model.startsWith("deepseek-v3.1")
  ) {
    return true;
  }

  return undefined;
}

function parseExplicitModelStepTarget(prompt: string): number | null {
  const match =
    /\b(?:complete|run|perform|use|take)\s+(?:exactly\s+)?(\d{1,3})\s+(?:model|agent|planning|loop)\s+steps?\b/i.exec(
      prompt,
    ) ??
    /\b(?:exactly\s+)?(\d{1,3})\s+(?:model|agent|planning|loop)\s+steps?\s+before\b/i.exec(
      prompt,
    );

  if (!match) {
    return null;
  }

  const target = Number.parseInt(match[1], 10);
  return Number.isFinite(target) && target > 0 ? target : null;
}

function isLikelyEnglishPrompt(prompt: string): boolean {
  const englishLetters = prompt.match(/[A-Za-z]/g)?.length ?? 0;
  const nonAsciiChars = prompt.match(/[^\x00-\x7F]/g)?.length ?? 0;

  return englishLetters > 0 && englishLetters >= nonAsciiChars;
}

function hasSafeReflexLabel(
  reflex: ReflexDecision | null,
  labels: ReflexDecision["label"][],
): boolean {
  return Boolean(
    reflex &&
      reflex.confidence >= 0.72 &&
      labels.includes(reflex.label) &&
      !reflex.safetyNotes.includes("unsafe"),
  );
}

function isPromptOnCurrentPageIntent(prompt: string): boolean {
  return (
    /\b(read|check|extract|use|answer|run|execute|follow|refer)\b[\s\S]{0,100}\b(prompt|instruction|question|task|request)\b[\s\S]{0,100}\b(?:on|from|in|as)\s+(?:the\s+)?(?:page|note|document|notepage)\b/i.test(
      prompt,
    ) ||
    /\b(prompt|instruction|question|task|request)\b[\s\S]{0,100}\b(?:on|from|in)\s+(?:the\s+)?(?:page|note|document|notepage)\b/i.test(
      prompt,
    ) ||
    /\b(read|check|extract|use|answer|run|execute|follow|refer)\b[\s\S]{0,120}\bnotes?\b[\s\S]{0,120}\b(?:notepage|page|note|document)\b[\s\S]{0,80}\bas\s+(?:the\s+)?prompt\b/i.test(
      prompt,
    )
  );
}

function requiresCurrentNoteContent(prompt: string): boolean {
  return (
    isPromptOnCurrentPageIntent(prompt) ||
    hasEditIntent(prompt) ||
    hasWholeNoteRevisionIntent(prompt) ||
    hasSectionAppendIntent(prompt) ||
    hasReplaceIntent(prompt) ||
    hasTitleIntent(prompt) ||
    hasDeleteIntent(prompt) ||
    /\b(read|check|inspect|look\s+at|open)\b[\s\S]{0,80}\b(current|this|active)\s+(note|file|markdown|document)\b/i.test(
      prompt,
    ) ||
    /\b(current|this|active)\s+(note|file|markdown|document)\b[\s\S]{0,80}\b(read|check|inspect|look\s+at|open)\b/i.test(
      prompt,
    ) ||
    /\b(summari[sz]e|analy[sz]e|explain|extract|review|describe)\b[\s\S]{0,40}\b(current|this|active)\s+(note|file|markdown|document)\b/i.test(
      prompt,
    ) ||
    /\b(summary|analysis|explanation|review|description)\s+of\s+(?:the\s+)?(current|this|active)\s+(note|file|markdown|document)\b/i.test(
      prompt,
    ) ||
    /\b(what|which|where|why|how)\b[\s\S]{0,80}\b(current|this|active)\s+(note|file|markdown|document)\b/i.test(
      prompt,
    ) ||
    /\b(based\s+on|from|using|according\s+to)\s+(?:the\s+)?(current|this|active)\s+(note|file|markdown|document|content)\b/i.test(
      prompt,
    )
  );
}

function shouldPrefetchVaultFolderAnswer(
  prompt: string,
  intent: MissionIntent,
): boolean {
  const safeCurrentPageWriteback =
    intent.explicitMutation &&
    intent.noteOutput &&
    hasCurrentPageWritebackIntent(prompt) &&
    !hasReplaceIntent(prompt) &&
    !hasEditIntent(prompt) &&
    !hasDeleteIntent(prompt) &&
    !hasDeletePathIntent(prompt);

  return (
    intent.vaultContext &&
    hasPrefetchableFolderSummaryIntent(prompt) &&
    !hasWebSearchIntent(prompt) &&
    !hasGraphConnectionIntent(prompt) &&
    !hasTemplateIntent(prompt) &&
    !hasSpecificFileReadIntent(prompt) &&
    !hasTopicSearchVaultQuestionIntent(prompt) &&
    !/^\s*Continue the prior vault exploration\b/i.test(prompt) &&
    (!intent.explicitMutation || safeCurrentPageWriteback) &&
    !intent.explicitDelete
  );
}

function hasPrefetchableFolderSummaryIntent(prompt: string): boolean {
  return (
    hasFolderContentQuestionIntent(prompt) &&
    /\b(say|says|contain|contains|contents?|details?|discover(?:ed|ies)?|findings?|report\s+back|gather|collect|read|summari[sz]e|what\s+they\s+say|tell\s+me(?:\s+what|\s+about)?)\b/i.test(
      prompt,
    )
  ) || /\b(gather|collect|read|summari[sz]e|report\s+back|tell\s+me)\b[\s\S]{0,160}\bother\s+folders?\b[\s\S]{0,80}\b(say|says|what\s+they\s+say|details?|contents?)\b/i.test(
    prompt,
  ) || hasNamedFolderTraversalIntent(prompt);
}

function hasTopicSearchVaultQuestionIntent(prompt: string): boolean {
  return /\b(what|where|find|search|show|list)\b[\s\S]{0,80}\b(my\s+)?notes?\b[\s\S]{0,80}\b(about|mention|mentions|reference|references|related\s+to)\b/i.test(
    prompt,
  );
}

function hasVaultContextQuestionIntent(prompt: string): boolean {
  return /\b(what\s+(did|do)\s+you\s+(learn|know|remember)\s+about\s+me|what\s+have\s+i\s+told\s+you|what\s+do\s+my\s+notes\s+say|based\s+on\s+my\s+notes|in\s+my\s+notes|across\s+my\s+notes|search\s+(my\s+)?notes|find\s+(notes?|details?|mentions?|references?)|where\s+did\s+i\s+mention|summari[sz]e\s+what\s+i\s+(know|have|wrote)|look\s+through\s+(my\s+)?vault|check\s+(my\s+)?folders?)\b/i.test(
    prompt,
  ) || hasFolderContentQuestionIntent(prompt) || hasGraphConnectionIntent(prompt);
}

function hasWordCountIntent(prompt: string): boolean {
  return /\b(word\s*count|count\s+(?:the\s+)?words?|how\s+many\s+words?|length\s+check|verify\s+(?:the\s+)?(?:word\s+)?length)\b/i.test(
    prompt,
  );
}

function hasGraphConnectionIntent(prompt: string): boolean {
  // Vault paths are opaque resource identifiers, not natural-language intent.
  // A path such as `Mission Graph Guard/restart.md` must not silently route an
  // append mission through graph retrieval merely because its folder name
  // contains "graph" and the path itself ends in a Markdown file.
  const intentText = prompt.replace(
    /[A-Za-z0-9 .@()[\]_-]+(?:\/[A-Za-z0-9 .@()[\]_-]+)+\.md\b/giu,
    " [markdown-path] ",
  ).replace(
    /\bpreserve\b[^.\n]{0,100}\b(?:note\s+)?backlinks?\b/giu,
    " ",
  );
  return /\b(graph|backlinks?|outgoing\s+links?|incoming\s+links?|related\s+notes?|semantic(?:ally)?\s+(?:related|connected)|connections?|connected|link(?:ed)?\s+notes?|note\s+relationships?|references?)\b/i.test(
    intentText,
  ) && /\b(note|notes|file|files|vault|current|this|active|markdown)\b/i.test(intentText);
}

function hasOpenWebSourceIntent(prompt: string): boolean {
  return /\b(open|view|show|launch)\b[\s\S]{0,120}\b(source|sources|link|url|web|browser|reference|citation|page)\b|\b(source|sources|link|url|web\s+page|reference|citation|page)\b[\s\S]{0,120}\b(open|view|show|launch)\b/i.test(
    prompt,
  );
}

function hasCodeExecutionIntent(prompt: string): boolean {
  return (
    /\b(run|execute|eval|evaluate|test|compile)\b[\s\S]{0,120}\b(code|script|program|snippet|python|javascript|typescript|html|css|c\+\+|cpp|c\s+code)\b|\b(code|script|program|snippet|python|javascript|typescript|html|css|c\+\+|cpp|c\s+code)\b[\s\S]{0,120}\b(run|execute|eval|evaluate|test|compile)\b/i.test(
      prompt,
    ) ||
    /\b(?:code_workspace_[a-z0-9_]+|code_validate_(?:fast|targeted|full)|code_repair_(?:status|record_cycle)|code_commit_verified|install_code_dependency)\b/i.test(
      prompt,
    ) ||
    /\b(repository|repo|codebase|worktree|code\s+workspace|project\s+folder)\b[\s\S]{0,180}\b(implement|fix|repair|patch|refactor|edit|change|create|add|remove|rename|move|copy|validate|test|build|commit)\b|\b(implement|fix|repair|patch|refactor|edit|change|create|add|remove|rename|move|copy|validate|test|build|commit)\b[\s\S]{0,180}\b(repository|repo|codebase|worktree|code\s+workspace|project\s+folder)\b/i.test(
      prompt,
    )
  );
}

function countExplicitCodeToolNames(prompt: string): number {
  return new Set(
    prompt.toLowerCase().match(
      /\b(?:code_workspace_[a-z0-9_]+|code_validate_(?:fast|targeted|full)|code_repair_(?:status|record_cycle)|code_commit_verified|install_code_dependency|run_code_block|render_html_preview)\b/gu,
    ) ?? [],
  ).size;
}

function hasHtmlPreviewIntent(prompt: string): boolean {
  return /\b(preview|render|show)\b[\s\S]{0,100}\b(html|css|web\s+page|mockup|prototype)\b|\b(html|css|web\s+page|mockup|prototype)\b[\s\S]{0,100}\b(preview|render|show)\b/i.test(
    prompt,
  );
}

function hasDesignIntent(prompt: string): boolean {
  return hasSharedDesignIntent(prompt);
}

function hasBrowserAutomationIntent(prompt: string): boolean {
  return /\b(browser|web\s*acting|open\s+(?:the\s+)?page|open\s+(?:a\s+)?url|navigate|click|scroll|type\s+into|keypress|screenshot|extract\s+markdown|page\s+to\s+markdown|learn\s+(?:this\s+)?(?:page|site|workflow|game)|flash\s+game|swf)\b/i.test(
    prompt,
  );
}

function hasLongResearchIntent(prompt: string): boolean {
  return /\b(deep\s+research|long\s+research|in-depth\s+research|deep\s+dive|investigate|compare\s+sources|multi[-\s]?source|strategy|broad\s+constraints|evidence\s+ledger|checkpoint|long[-\s]?running)\b/i.test(
    prompt,
  );
}

function hasTemplateIntent(prompt: string): boolean {
  return /\b(template|templates|templated|form|boilerplate|reusable\s+(?:note|markdown|outline|format|structure)|fill\s+(?:this|the)?\s*(?:out\s+)?(?:form|template)|populate\s+(?:this|the)?\s*(?:form|template))\b/i.test(
    prompt,
  );
}

function hasResearchMemoryReadIntent(prompt: string): boolean {
  return /\b(research\s+memory|topic\s+memory|memory|remember|recall|long[-\s]?term|continue\s+(?:this|the)\s+research|build\s+on\s+(?:this|the)\s+research)\b/i.test(
    prompt,
  );
}

function hasVaultBrowseIntent(prompt: string): boolean {
  return /\b(vault|files|file names|filenames|markdown files|md files|folders|folder|directory|directories|path|paths|list|browse|inspect|where\s+this\s+note\s+belongs|placement|organize\s+(?:the\s+)?vault|across\s+files)\b/i.test(
    prompt,
  );
}

function hasFolderContentQuestionIntent(prompt: string): boolean {
  return (
    hasNamedFolderTraversalIntent(prompt) ||
    /\b(other|all|nearby|related|vault|my)\s+(folders?|notes?|files?)\b/i.test(
      prompt,
    ) ||
    /\b(folders?|vault)\b[\s\S]{0,100}\b(say|says|contain|contains|details?|contents?|report\s+back|gather|browse|locate|summari[sz]e|tell\s+me)\b/i.test(
      prompt,
    ) ||
    /\b(gather|collect|read|inspect|look\s+through|browse|check|summari[sz]e|report)\b[\s\S]{0,140}\b(other\s+)?(folders?|vault|my\s+notes|notes?\s+in\s+(?:the\s+)?other\s+folders?|files?\s+in\s+(?:the\s+)?other\s+folders?)\b/i.test(
      prompt,
    )
  );
}

function hasSpecificFileReadIntent(prompt: string): boolean {
  return /(?:^|[\s"'`])[\w .@()-]+\/[\w .@()/-]+|\.md\b|\b(file named|note named|named file|named note|specific file|existing file|vault file)\b/i.test(
    prompt,
  );
}

function hasPathTargetIntent(prompt: string): boolean {
  return /(?:^|[\s"'`])[\w .@()-]+\/[\w .@()/-]+|\.md\b|\b(path|folder|folders|directory|directories|vault file|vault folder|file named|note named|named file|named note|another file|specific file|existing file)\b/i.test(
    prompt,
  );
}

function hasCurrentPageWritebackIntent(prompt: string): boolean {
  return (
    /\b(stream|write|append|save|add|insert|put|record)\b[\s\S]{0,120}\b(?:onto|to|into|in|on)\s+(?:this|the|current|active)\s+(?:page|note|document|file)\b/i.test(
      prompt,
    ) ||
    /\b(?:this|the|current|active)\s+(?:page|note|document|file)\b[\s\S]{0,120}\b(stream|write|append|save|add|insert|put|record)\b/i.test(
      prompt,
    )
  );
}

function hasCurrentNoteSectionTarget(prompt: string): boolean {
  return /\b(?:below|under|after|beneath|inside)\b[\s\S]{0,100}\b(?:section|heading)\b|\b(?:section|heading)\b[\s\S]{0,100}\b(?:below|under|after|beneath|inside)\b/i.test(
    prompt,
  );
}

function hasSectionAppendIntent(prompt: string): boolean {
  return (
    hasCurrentNoteSectionTarget(prompt) &&
    /\b(write|draft|compose|generate|append|add|insert|put)\b/i.test(prompt)
  );
}

function hasAppendIntent(prompt: string): boolean {
  return /\b(append|save|write|update|add|insert|copy|paste|put)\b[\s\S]{0,80}\b(note|file|markdown|vault|page|document)\b|\b(note|file|markdown|vault|page|document)\b[\s\S]{0,80}\b(append|save|write|update|add|insert|copy|paste|put)\b|\b(append|save|write|update|add|insert|copy|paste|put)\b[\s\S]{0,120}\.md\b/i.test(
    prompt,
  );
}

function hasReplaceIntent(prompt: string): boolean {
  return (
    isCurrentNoteReplaceResetPrompt(prompt) ||
    hasWholeNoteRevisionIntent(prompt) ||
    /\b(rewrite|replace|reset|overwrite)\b|\bclean\s+up\b|\bstart\s+(?:fresh|cleanly)\b|\bedit\s+over\s+(?:it|this|the\s+(?:note|page|document|file|contents?))\b|\breplace\s+(?:the\s+)?existing\s+contents?\b/i.test(
      prompt,
    ) || hasClearPageAndWriteIntent(prompt)
  );
}

function hasClearPageAndWriteIntent(prompt: string): boolean {
  return /\b(clear|delete|remove)\s+all\s+(?:the\s+)?(?:notes?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active)\s+(?:page|note|document|file)\b[\s\S]{0,180}\b(write|draft|compose|generate|create)\b|\b(write|draft|compose|generate|create)\b[\s\S]{0,180}\b(?:after|then)\b[\s\S]{0,120}\b(clear|delete|remove)\s+all\s+(?:the\s+)?(?:notes?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active)\s+(?:page|note|document|file)\b/i.test(
    prompt,
  );
}

function hasWholeNoteRevisionIntent(prompt: string): boolean {
  if (isNamedSectionEditIntent(prompt)) {
    return false;
  }

  if (
    isWholeNoteEditIntent(prompt) ||
    isCurrentNoteEditOrganizeIntent(prompt)
  ) {
    return true;
  }

  const sectionTarget =
    /\b(section|heading)\b/i.test(prompt) &&
    !/\b(essay|draft|article|paragraphs?|body|content|document)\b/i.test(
      prompt,
    );
  if (sectionTarget) {
    return false;
  }

  const revisionVerb =
    /\b(edit(?:ing)?|revise|revising|revision|rewrite|rewriting|improve|improving|expand|expanding|iterate|iterating|flesh\s+out|develop|add(?:ing)?\s+(?:more\s+)?detail)\b/i;
  const wholeTextTarget =
    /\b(essay|draft|article|paragraphs?|body|content|document)\b|\b(?:whole|entire|current|this|active)\s+(?:note|page|file|markdown)\b|\b(?:note|page|file|markdown)\b[\s\S]{0,40}\b(?:whole|entire|current|this|active)\b/i;
  const updateVerb = /\b(update|updating)\b/i;

  return (
    revisionVerb.test(prompt) && wholeTextTarget.test(prompt)
  ) || (
    updateVerb.test(prompt) &&
    /\b(essay|draft|article|paragraphs?|body|content|document)\b|\b(?:whole|entire)\s+(?:note|page|file|markdown)\b/i.test(
      prompt,
    )
  );
}

function hasEditIntent(prompt: string): boolean {
  return isNamedSectionEditIntent(prompt);
}

function hasDeleteIntent(prompt: string): boolean {
  if (isCurrentNoteReplaceResetPrompt(prompt)) {
    return false;
  }

  return /\b(delete|remove|trash)\b[\s\S]{0,80}\b(?:current|this|active|whole|entire)\s+(?:note|file)\b|\b(?:current|this|active|whole|entire)\s+(?:note|file)\b[\s\S]{0,80}\b(delete|remove|trash)\b/i.test(
    prompt,
  );
}

function hasDeletePathIntent(prompt: string): boolean {
  if (isCurrentNoteReplaceResetPrompt(prompt)) {
    return false;
  }

  return /\b(delete|remove|trash)\b/i.test(prompt) && hasPathTargetIntent(prompt);
}

function hasWebSearchIntent(prompt: string): boolean {
  if (hasExplicitNoWebIntent(prompt)) {
    return false;
  }
  if (hasSimpleDateTimePrompt(prompt)) {
    return false;
  }

  if (hasPriorAssistantResponseWritebackIntent(prompt)) {
    return false;
  }

  if (hasTitleOnlyIntent(prompt)) {
    return false;
  }

  if (/\b(search|use|check|consult)\s+(?:the\s+)?web\b/i.test(prompt)) {
    return true;
  }

  if (hasCurrentWebFactIntent(prompt)) {
    return true;
  }

  if (hasStaticGenerationIntent(prompt) && !hasFetchedWebSourceIntent(prompt)) {
    return false;
  }

  if (hasFolderContentQuestionIntent(prompt)) {
    return false;
  }

  if (hasExplicitWebSearchIntent(prompt) || hasDeepResearchIntent(prompt)) {
    return true;
  }

  return /\b(research|investigate|find|gather)\b/i.test(prompt);
}

function hasPriorAssistantResponseWritebackIntent(prompt: string): boolean {
  return /\bmost recent assistant response\b[\s\S]{0,120}\bcurrent Obsidian note\b/i.test(
    prompt,
  ) || isRecentAssistantWritebackFollowup(prompt);
}

function isRecentAssistantWritebackFollowup(prompt: string): boolean {
  return /\b(write|copy|save|append|add|insert|paste|put)\b[\s\S]{0,100}\b(this|that|the|your|previous|prior|last|above)\s+(essay|answer|response|reply|summary|analysis|content|text|draft|paragraph|article|report)\b[\s\S]{0,100}\b(?:on|onto|to|into|in)\s+(?:the\s+)?(?:page|note|document|file|markdown)\b|\b(?:on|onto|to|into|in)\s+(?:the\s+)?(?:page|note|document|file|markdown)\b[\s\S]{0,100}\b(write|copy|save|append|add|insert|paste|put)\b[\s\S]{0,100}\b(this|that|the|your|previous|prior|last|above)\s+(essay|answer|response|reply|summary|analysis|content|text|draft|paragraph|article|report)\b/i.test(
    prompt,
  );
}

function hasFetchedWebSourceIntent(prompt: string): boolean {
  return /\b(cited\s+sources?|cite\s+sources?|citations?|source\s+urls?|bibliography|reference\s+list|verified\s+sources?|fact[-\s]?check(?:ed)?|verify\s+(?:sources?|facts?|claims?))\b/i.test(
    prompt,
  );
}

function hasCurrentWebFactIntent(prompt: string): boolean {
  return /\b(?:latest|recent|current|up[-\s]?to[-\s]?date)\b[\s\S]{0,100}\b(?:events?|news|information|info|data|facts?|research|reports?|papers?|studies?|market|markets?|industry|industries|trends?|prices?|rates?|status|versions?|law|policy|policies)\b/i.test(
    prompt,
  );
}

function hasDeepResearchIntent(prompt: string): boolean {
  return /\b(deep\s+research|in[-\s]?depth(?:\s+(?:research|analysis|investigation|report))?|deep\s+dive|thorough\s+research|comprehensive\s+research|serious\s+research)\b/i.test(
    prompt,
  );
}

function hasExplicitWebSearchIntent(prompt: string): boolean {
  return /\b(web|internet|online|search|look\s+up|browse|sources?|citations?|cited|cite|news|up[-\s]?to[-\s]?date|verify|fact[-\s]?check)\b|\b(?:latest|recent|current)\b[\s\S]{0,60}\b(events?|news|information|info|version|versions?|prices?|rates?|status|facts?|research|reports?|papers?|studies?)\b/i.test(
    prompt,
  );
}

function hasSimpleDateTimePrompt(prompt: string): boolean {
  return /^\s*(?:(?:what(?:'s| is)?|tell me|give me|show me)\s+)?(?:today'?s\s+)?(?:current\s+)?(?:date|time|day)(?:\s+(?:today|now|right now))?\??\s*$/i.test(
    prompt,
  ) || /^\s*what\s+(?:date|time|day)\s+is\s+it(?:\s+(?:today|now|right now))?\??\s*$/i.test(
    prompt,
  );
}

function hasStaticGenerationIntent(prompt: string): boolean {
  return /\b(generate|write|draft|compose|create)\b[\s\S]{0,80}\b(essay|article|paragraph|summary|brief|outline|report|note|content|post)\b|\b(essay|article|paragraph|summary|brief|outline|report)\b[\s\S]{0,80}\b\d+\s*words?\b|\b(write|draft|compose|generate|create)\b[\s\S]{0,80}\b\d{1,5}\s*words?\b/i.test(
    prompt,
  );
}

function hasTitleIntent(prompt: string): boolean {
  if (/\b(retitle|rename|title|h1)\b|\bcall\s+(?:this|the)\s+note\b/i.test(prompt)) {
    return true;
  }

  // Bare "heading" is title intent only when not a named section edit.
  if (/\bheading\b/i.test(prompt) && !isNamedSectionEditIntent(prompt)) {
    return true;
  }

  // Content organize/edit owns the route; do not force rename-only tools.
  if (
    isCurrentNoteEditOrganizeIntent(prompt) ||
    isVaultWideOrganizeIntent(prompt) ||
    isWholeNoteEditIntent(prompt)
  ) {
    return false;
  }

  return /\b(note|file)\b[\s\S]{0,80}\b(organize|restructure|improve)\b|\b(organize|restructure|improve)\b[\s\S]{0,80}\b(note|file)\b/i.test(
    prompt,
  );
}

function hasTitleOnlyIntent(prompt: string): boolean {
  return isTitleOnlyIntent(prompt);
}

function hasNamedFolderTraversalIntent(prompt: string): boolean {
  return (
    /\b(traverse|inspect|browse|read|look\s+through|check|summari[sz]e)\b[\s\S]{0,120}\bfolders?\b/i.test(
      prompt,
    ) &&
    /\bfolders?\b[\s\S]{0,100}\b(?:named|called)\b/i.test(prompt)
  );
}
