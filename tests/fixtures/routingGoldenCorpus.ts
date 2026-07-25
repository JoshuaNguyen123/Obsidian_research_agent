import type { MissionSpeechAct, ExecutionTier } from "../../src/agent/missionSpeechAct";
import type { RunRoute } from "../../src/agent/runPlan";
import type { MissionIntent } from "../../src/tools/types";
import type { StreamingWritebackKind } from "../../src/agent/runPlan";

/**
 * Golden routing corpus: one prompt per case, asserted simultaneously at the
 * speech-act, run-plan-route, and required-code-ladder layers.
 *
 * `expected` records the DESIRED classification (only the fields present are
 * asserted). `status: "pass"` means today's classifiers already produce the
 * desired output. `status: "known_miss"` means at least one field differs
 * today; those fields are pinned in `current` and asserted verbatim, so any
 * behavior change flips this test and forces a deliberate corpus update
 * (move the case to "pass", raise ROUTING_BASELINE_ACCURACY).
 */
export interface RoutingGoldenCaseV1 {
  id: string;
  prompt: string;
  expected: {
    speechAct?: MissionSpeechAct;
    executionTier?: ExecutionTier;
    route?: RunRoute;
    reasonsInclude?: readonly string[];
    /** Exact required code-workflow ladder (empty array = no ladder). */
    requiredCodeToolNames?: readonly string[];
  };
  /** Present-day wrong outputs, only for the fields that differ from expected. */
  current?: {
    speechAct?: MissionSpeechAct;
    executionTier?: ExecutionTier;
    route?: RunRoute;
    requiredCodeToolNames?: readonly string[];
  };
  status: "pass" | "known_miss";
  intent?: Partial<MissionIntent>;
  streamingWritebackKind?: StreamingWritebackKind | null;
  /** Extra tool names offered beyond the standard corpus catalog. */
  extraTools?: readonly string[];
}

export const FULL_DESKTOP_LADDER = [
  "code_sandbox_status",
  "code_workspace_create",
  "code_workspace_create_file",
  "code_validate_fast",
  "code_repair_record_cycle",
  "code_validate_targeted",
  "code_validate_full",
  "code_workspace_export_directory",
] as const;

/**
 * Ratchet: pass-cases / total-cases. Raise this whenever a known_miss case is
 * fixed and flipped to pass. It must never go down.
 *
 * History: 14/21 measured 2026-07-25 before any routing change; 61/62 after
 * the deterministic tier landed (write-as-execution, "make" verb, how-to and
 * conversational-revision guards, write-a-note guards, and fuzzy typo
 * rescue). The one open miss is
 * guard-desk-notes, whose route false-positive lives in the shared design
 * gate (`codeDesignIntent.ts` DESIGN_INTENT matching topical "game design");
 * narrowing it risks real design missions, so it waits for the semantic
 * shadow tier evidence.
 */
export const ROUTING_BASELINE_ACCURACY = 61 / 62;

export const ROUTING_GOLDEN_CORPUS: readonly RoutingGoldenCaseV1[] = [
  // --- The two live-reported desktop prompts and near variants ---
  {
    id: "desktop-write-question",
    prompt: "write a number guessing game in Python on my desktop?",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
      reasonsInclude: ["code_execution_intent"],
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
    },
    status: "pass",
  },
  {
    id: "desktop-write-bare",
    prompt: "write a number guessing game in Python on my desktop",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
      reasonsInclude: ["code_execution_intent"],
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
    },
    status: "pass",
  },
  {
    id: "desktop-can-you-create",
    prompt:
      "ON the desktop of my computer, can you create a number guessing game in Python?",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      reasonsInclude: ["code_execution_intent"],
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
    },
    status: "pass",
  },
  {
    id: "desktop-create-bare",
    prompt: "create a number guessing game in Python on my desktop",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
    },
    status: "pass",
  },
  // --- Typo variants the deterministic tier must eventually rescue ---
  {
    id: "desktop-typo-deskto",
    prompt: "write a number guessing game in Python on my deskto",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
    },
    status: "pass",
  },
  {
    id: "desktop-typo-crate",
    prompt: "crate a number guessing game in Python on my desktop",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
    },
    status: "pass",
  },
  // --- Other known-host-directory deliverables ---
  {
    id: "documents-build-checkers",
    prompt: "Build a checkers game in Python and save it to my Documents folder.",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
    },
    status: "pass",
  },
  {
    id: "downloads-make-script",
    prompt:
      "can you make a small python script that renames my photos and put it in my downloads folder",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
    },
    status: "pass",
  },
  // --- Guards: must NOT become code missions ---
  {
    id: "guard-explain-create-file",
    prompt: "explain how to create a file in Python",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  {
    id: "guard-hypothetical-wrote-game",
    prompt: "What would happen if you wrote a game in Python?",
    expected: {
      speechAct: "explain",
      route: "single_model_answer",
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  {
    id: "guard-desk-notes",
    prompt: "I sat at my desk to write notes about the game design.",
    expected: {
      speechAct: "explain",
      route: "single_model_answer",
      requiredCodeToolNames: [],
    },
    current: {
      // Shared DESIGN_INTENT gate false-fires on the topical phrase "game
      // design"; the code ladder is already clean for this prompt.
      route: "grounded_workflow",
    },
    status: "known_miss",
  },
  {
    id: "guard-haiku",
    prompt: "Write a haiku about autumn.",
    expected: {
      route: "single_model_answer",
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  {
    id: "guard-conversation-revision",
    prompt: "Edit the essay you gave me with more details.",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
      reasonsInclude: ["conversation_revision"],
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  // --- Established behaviors that must not regress ---
  {
    id: "analytical-gaps",
    prompt: "Is the red list the complete current set of fully-agentic gaps?",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
      reasonsInclude: ["speech_act_direct_chat"],
    },
    status: "pass",
  },
  {
    id: "platform-question",
    prompt: "How does the mission graph decide which tools to offer?",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
    },
    status: "pass",
  },
  {
    id: "instant-time",
    prompt: "What time is it?",
    expected: { route: "instant_local" },
    status: "pass",
  },
  {
    id: "append-essay",
    prompt: "Append a 200 word essay to this note.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "single_model_writeback",
    },
    intent: {
      mode: "note_output",
      noteOutput: true,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    },
    streamingWritebackKind: "append",
    status: "pass",
  },
  {
    id: "replace-note",
    prompt: "Replace this note with a fresh brief.",
    expected: {
      speechAct: "persist",
      route: "tool_required",
    },
    intent: {
      mode: "explicit_file_mutation",
      noteOutput: true,
      explicitMutation: true,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    },
    status: "pass",
  },
  {
    id: "vault-search",
    prompt: "Search my vault for related notes.",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
    },
    intent: { mode: "vault_context_answer", vaultContext: true },
    status: "pass",
  },
  {
    id: "web-sources",
    prompt: "Find latest sources and cite them.",
    expected: {
      speechAct: "explain",
      route: "grounded_workflow",
    },
    status: "pass",
  },
  {
    id: "browser-observe",
    prompt: "Open https://example.com in the browser and observe it.",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
    },
    extraTools: ["browser_open_page", "browser_observe"],
    status: "pass",
  },
  {
    id: "memory-save",
    prompt: "Save a summary of this conversation to memory.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
    },
    status: "pass",
  },
  // --- Consolidated established classifier prompts (copied from focused tests) ---
  {
    id: "analysis-proof-lanes",
    prompt:
      "Analyze the current implementation and explain which proof lanes are still missing.",
    expected: { speechAct: "explain", executionTier: "direct_chat" },
    status: "pass",
  },
  {
    id: "evaluate-platform-usefulness",
    prompt:
      "The current platform that I created to give you tools, no specific document, I want you to rate actual usefulness.",
    expected: { speechAct: "evaluate", executionTier: "direct_chat" },
    status: "pass",
  },
  {
    id: "analysis-agentic-pipeline-difficulty",
    prompt:
      "From your perspective, what is hard about doing research in Obsidian agentically, converting the notebook into Linear issues, code files, GitHub, and finally a reflection?",
    expected: { speechAct: "explain", executionTier: "direct_chat" },
    status: "pass",
  },
  {
    id: "analysis-domain-nouns-only",
    prompt: "How do Linear, code files, GitHub, and reflection fit together?",
    expected: { speechAct: "explain", executionTier: "direct_chat" },
    status: "pass",
  },
  {
    id: "analysis-tcp-udp",
    prompt: "Explain the difference between TCP and UDP.",
    expected: { speechAct: "explain", executionTier: "direct_chat" },
    status: "pass",
  },
  {
    id: "analysis-last-run",
    prompt: "What happened during the last run?",
    expected: { speechAct: "explain", executionTier: "direct_chat" },
    status: "pass",
  },
  {
    id: "analysis-web-failure",
    prompt: "Why did the web lookup fail?",
    expected: { speechAct: "explain", executionTier: "direct_chat" },
    status: "pass",
  },
  {
    id: "evaluate-architecture",
    prompt: "Review the architecture and tell me its weaknesses.",
    expected: { speechAct: "evaluate", executionTier: "direct_chat" },
    status: "pass",
  },
  {
    id: "execute-seed-templates",
    prompt: "Seed the default starter templates in my vault.",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "execute-revise-mermaid",
    prompt:
      "Revise the Mermaid diagram under the Architecture heading in Designs/System.md.",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "execute-count-current-note",
    prompt: "Count the words in the current note.",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "execute-read-pr-status",
    prompt:
      "Read the GitHub pull request status and summarize the checks without changing anything.",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "execute-close-github-issue",
    prompt: "Close GitHub issue 12 in repository profile trusted-repository.",
    expected: { speechAct: "execute", executionTier: "durable_mission" },
    status: "pass",
  },
  {
    id: "execute-search-release",
    prompt: "Search the web for the latest Obsidian release and cite the source.",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "execute-make-diagram",
    prompt: "Using design tools can you make a diagram?",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "execute-inspect-vault",
    prompt: "Inspect the vault structure with tools.",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "execute-list-templates",
    prompt: "List my saved templates.",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "persist-append-summary",
    prompt: "Append this summary to the current note.",
    expected: { speechAct: "persist", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "persist-rename-current-note",
    prompt: "Rename the current note to Purple Horizon.",
    expected: { speechAct: "persist", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "execute-delete-current-note",
    prompt: "Delete the current note.",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "persist-edit-goals-section",
    prompt: "Edit the Goals section in this note.",
    expected: { speechAct: "persist", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "persist-write-current-page",
    prompt: "Write this brief to the current page.",
    expected: { speechAct: "persist", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "execute-create-markdown-path",
    prompt: "Create a new markdown file at Projects/Brief.md.",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "persist-append-markdown-path",
    prompt: "Append this text to the file Projects/Brief.md.",
    expected: { speechAct: "persist", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "persist-replace-markdown-path",
    prompt: "Replace the file Projects/Brief.md with a clean brief.",
    expected: { speechAct: "persist", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "persist-rename-markdown-path",
    prompt: "Rename the file Projects/Brief.md to Projects/Renamed.md.",
    expected: { speechAct: "persist", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "execute-delete-folder",
    prompt: "Delete the folder Projects/Archive.",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "continue-latest-run",
    prompt: "Continue the latest run.",
    expected: { speechAct: "continue", executionTier: "durable_mission" },
    status: "pass",
  },
  {
    id: "continue-prior-mission",
    prompt: "Resume the prior mission.",
    expected: { speechAct: "continue", executionTier: "durable_mission" },
    status: "pass",
  },
  {
    id: "continue-explicit-run-id",
    prompt: "continue run run-abc12345",
    expected: { speechAct: "continue", executionTier: "durable_mission" },
    status: "pass",
  },
  // --- Additional negatives and vocabulary/fuzzy boundaries ---
  {
    id: "guard-computer-downloads-description",
    prompt: "I keep my computer in Downloads.",
    expected: { speechAct: "explain", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "guard-folder-script-description",
    prompt: "The folder contains a Python script.",
    expected: { speechAct: "explain", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "guard-explain-programs",
    prompt: "Can you explain how programs work?",
    expected: { speechAct: "explain", executionTier: "direct_chat" },
    status: "pass",
  },
  {
    id: "guard-explicit-no-write",
    prompt: "Do not write to the note; explain the tradeoffs in chat.",
    expected: { speechAct: "explain", executionTier: "direct_chat" },
    status: "pass",
  },
  {
    id: "code-verb-computer",
    prompt: "code a timer in Python on my computer",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "program-verb-desktop",
    prompt: "program a calculator in JavaScript for my desktop",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "script-verb-downloads",
    prompt: "script a backup tool for my Downloads folder",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "program-typo-prgram",
    prompt: "prgram a calculator in JavaScript for my desktop",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "create-typo-file",
    prompt: "crate a file for the project",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
  {
    id: "downloads-typo-code-delivery",
    prompt:
      "create a photo renaming script and save it to my dowloads folder",
    expected: { speechAct: "execute", executionTier: "bounded_tool" },
    status: "pass",
  },
];
