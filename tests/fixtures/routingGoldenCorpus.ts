import type { MissionSpeechAct, ExecutionTier } from "../../src/agent/missionSpeechAct";
import type {
  NoteOutputDelivery,
  NoteOutputDestination,
  NoteOutputMutation,
  NoteOutputPlan,
} from "../../src/agent/noteOutputPolicy";
import type { RunRoute, StreamingWritebackKind } from "../../src/agent/runPlan";
import { createRunPlan } from "../../src/agent/runPlan";
import { classifyMissionSpeechAct } from "../../src/agent/missionSpeechAct";
import type { AgentSettings } from "../../src/settings";
import type { MissionIntent, ToolExecutionContext } from "../../src/tools/types";
import type { ModelToolDefinition } from "../../src/model/types";
import {
  applyDefaultActiveNoteWriteback,
  buildMissionNoteOutputPlan,
  classifyMissionIntent,
  getDirectCurrentNoteWritebackKind,
  getRequiredCodeWorkflowToolNames,
  getStreamingWritebackKind,
} from "../../src/AgentRunner";

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
export interface RoutingGoldenExpectedV1 {
  speechAct?: MissionSpeechAct;
  executionTier?: ExecutionTier;
  route?: RunRoute;
  reasonsInclude?: readonly string[];
  /** Exact required code-workflow ladder (empty array = no ladder). */
  requiredCodeToolNames?: readonly string[];
  streamingWritebackKind?: StreamingWritebackKind | null;
  directCurrentNoteWritebackKind?: StreamingWritebackKind | null;
  noteOutputDestination?: NoteOutputDestination;
  noteOutputMutation?: NoteOutputMutation;
  noteOutputDelivery?: NoteOutputDelivery;
}

export interface RoutingGoldenCaseV1 {
  id: string;
  prompt: string;
  expected: RoutingGoldenExpectedV1;
  /** Present-day wrong outputs, only for the fields that differ from expected. */
  current?: RoutingGoldenExpectedV1;
  status: "pass" | "known_miss";
  /**
   * @deprecated Hand-set inputs were a test/production split. observe() now
   * computes intent and writeback kinds. Kept only so old case objects typecheck
   * until they are rewritten as expected/current fields.
   */
  intent?: Partial<MissionIntent>;
  streamingWritebackKind?: StreamingWritebackKind | null;
  /** Extra tool names offered beyond the standard corpus catalog. */
  extraTools?: readonly string[];
}

export interface ProductionRoutingObservationV1 {
  speechAct: MissionSpeechAct;
  executionTier: ExecutionTier;
  route: RunRoute;
  traceReasons: readonly string[];
  requiredCodeToolNames: readonly string[];
  streamingWritebackKind: StreamingWritebackKind | null;
  directCurrentNoteWritebackKind: StreamingWritebackKind | null;
  noteOutput: NoteOutputPlan;
  missionIntent: MissionIntent;
}

/**
 * Scratch delivery to a known host folder. It deliberately excludes
 * code_repair_record_cycle and code_commit_verified: both resolve a trusted
 * repository worktree and fail closed with trusted_repository_required on a
 * scratch workspace, which stranded the mission after the files were authored
 * but before they reached the folder the user named.
 */
export const FULL_DESKTOP_LADDER = [
  "code_sandbox_status",
  "code_workspace_create",
  "code_workspace_create_file",
  "code_validate_fast",
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
 * shadow tier evidence. 64/65 after the executable-notebook deliverable
 * predicate landed (notebook-execution-live lane prompt, fast-path deferral,
 * and the jupyter-reflection guard all pass). 66/67 after Genesis-shaped
 * STEM research notes ("cite at least N scholarly sources" + stream to page)
 * were pinned as persist / grounded_workflow with no code ladder.
 * 67/68 after "Write me brief about dfs and bfs in python" stopped matching
 * the write…python code-deliverable arm and stayed a streamed note brief.
 * 75/85 after WS-5 rebuilt observe() on the production writeback pipeline
 * and added the missing prompt families. Two STEM title+stream destination
 * pins and seven new-family misses are known_miss for WS-2 classifiers.
 */
export const ROUTING_BASELINE_ACCURACY = 75 / 85;

export const ROUTING_GOLDEN_CORPUS: readonly RoutingGoldenCaseV1[] = [
  {
    id: "desktop-write-question",
    prompt: "write a number guessing game in Python on my desktop?",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
      reasonsInclude: ["code_execution_intent"],
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
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
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "desktop-can-you-create",
    prompt: "ON the desktop of my computer, can you create a number guessing game in Python?",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      reasonsInclude: ["code_execution_intent"],
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
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
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "desktop-typo-deskto",
    prompt: "write a number guessing game in Python on my deskto",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
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
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "documents-build-checkers",
    prompt: "Build a checkers game in Python and save it to my Documents folder.",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "downloads-make-script",
    prompt: "can you make a small python script that renames my photos and put it in my downloads folder",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "guard-explain-create-file",
    prompt: "explain how to create a file in Python",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
      requiredCodeToolNames: [],
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "guard-hypothetical-wrote-game",
    prompt: "What would happen if you wrote a game in Python?",
    expected: {
      speechAct: "explain",
      route: "direct_writeback",
      requiredCodeToolNames: [],
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "guard-desk-notes",
    prompt: "I sat at my desk to write notes about the game design.",
    expected: {
      speechAct: "explain",
      route: "grounded_workflow",
      requiredCodeToolNames: [],
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    current: {
      // Shared DESIGN_INTENT gate false-fires on topical "game design".
      route: "grounded_workflow",
    },
    status: "known_miss",
  },
  {
    id: "guard-haiku",
    prompt: "Write a haiku about autumn.",
    expected: {
      route: "direct_writeback",
      requiredCodeToolNames: [],
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
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
      streamingWritebackKind: "replace",
      directCurrentNoteWritebackKind: "replace",
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "analytical-gaps",
    prompt: "Is the red list the complete current set of fully-agentic gaps?",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
      reasonsInclude: ["speech_act_direct_chat"],
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
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
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "instant-time",
    prompt: "What time is it?",
    expected: {
      route: "instant_local",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "append-essay",
    prompt: "Append a 200 word essay to this note.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "replace-note",
    prompt: "Replace this note with a fresh brief.",
    expected: {
      speechAct: "persist",
      route: "single_model_writeback",
      streamingWritebackKind: "replace",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "replace",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "vault-search",
    prompt: "Search my vault for related notes.",
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "web-sources",
    prompt: "Find latest sources and cite them.",
    expected: {
      speechAct: "explain",
      route: "grounded_workflow",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "browser-observe",
    prompt: "Open https://example.com in the browser and observe it.",
    extraTools: ["browser_open_page","browser_observe"],
    expected: {
      speechAct: "execute",
      route: "grounded_workflow",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "memory-save",
    prompt: "Save a summary of this conversation to memory.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "tool_required",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "analysis-proof-lanes",
    prompt: "Analyze the current implementation and explain which proof lanes are still missing.",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "evaluate-platform-usefulness",
    prompt: "The current platform that I created to give you tools, no specific document, I want you to rate actual usefulness.",
    expected: {
      speechAct: "evaluate",
      executionTier: "direct_chat",
      route: "single_model_answer",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "analysis-agentic-pipeline-difficulty",
    prompt: "From your perspective, what is hard about doing research in Obsidian agentically, converting the notebook into Linear issues, code files, GitHub, and finally a reflection?",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "analysis-domain-nouns-only",
    prompt: "How do Linear, code files, GitHub, and reflection fit together?",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "analysis-tcp-udp",
    prompt: "Explain the difference between TCP and UDP.",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "analysis-last-run",
    prompt: "What happened during the last run?",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "analysis-web-failure",
    prompt: "Why did the web lookup fail?",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "evaluate-architecture",
    prompt: "Review the architecture and tell me its weaknesses.",
    expected: {
      speechAct: "evaluate",
      executionTier: "direct_chat",
      route: "single_model_answer",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "execute-seed-templates",
    prompt: "Seed the default starter templates in my vault.",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "tool_required",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "execute-revise-mermaid",
    prompt: "Revise the Mermaid diagram under the Architecture heading in Designs/System.md.",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      streamingWritebackKind: "edit",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "execute-count-current-note",
    prompt: "Count the words in the current note.",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "tool_required",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "execute-read-pr-status",
    prompt: "Read the GitHub pull request status and summarize the checks without changing anything.",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "execute-close-github-issue",
    prompt: "Close GitHub issue 12 in repository profile trusted-repository.",
    expected: {
      speechAct: "execute",
      executionTier: "durable_mission",
      route: "tool_required",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "execute-search-release",
    prompt: "Search the web for the latest Obsidian release and cite the source.",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "execute-make-diagram",
    prompt: "Using design tools can you make a diagram?",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "execute-inspect-vault",
    prompt: "Inspect the vault structure with tools.",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "execute-list-templates",
    prompt: "List my saved templates.",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "single_model_answer",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "persist-append-summary",
    prompt: "Append this summary to the current note.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "persist-rename-current-note",
    prompt: "Rename the current note to Purple Horizon.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "tool_required",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "execute-delete-current-note",
    prompt: "Delete the current note.",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "tool_required",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "persist-edit-goals-section",
    prompt: "Edit the Goals section in this note.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "single_model_writeback",
      streamingWritebackKind: "edit",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "persist-write-current-page",
    prompt: "Write this brief to the current page.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "execute-create-markdown-path",
    prompt: "Create a new markdown file at Projects/Brief.md.",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "tool_required",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "persist-append-markdown-path",
    prompt: "Append this text to the file Projects/Brief.md.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "tool_required",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "persist-replace-markdown-path",
    prompt: "Replace the file Projects/Brief.md with a clean brief.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "tool_required",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "persist-rename-markdown-path",
    prompt: "Rename the file Projects/Brief.md to Projects/Renamed.md.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "tool_required",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "execute-delete-folder",
    prompt: "Delete the folder Projects/Archive.",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "continue-latest-run",
    prompt: "Continue the latest run.",
    expected: {
      speechAct: "continue",
      executionTier: "durable_mission",
      route: "grounded_workflow",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "continue-prior-mission",
    prompt: "Resume the prior mission.",
    expected: {
      speechAct: "continue",
      executionTier: "durable_mission",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "continue-explicit-run-id",
    prompt: "continue run run-abc12345",
    expected: {
      speechAct: "continue",
      executionTier: "durable_mission",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "guard-computer-downloads-description",
    prompt: "I keep my computer in Downloads.",
    expected: {
      speechAct: "explain",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "guard-folder-script-description",
    prompt: "The folder contains a Python script.",
    expected: {
      speechAct: "explain",
      executionTier: "bounded_tool",
      route: "prefetched_vault_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "guard-explain-programs",
    prompt: "Can you explain how programs work?",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "guard-explicit-no-write",
    prompt: "Do not write to the note; explain the tradeoffs in chat.",
    expected: {
      speechAct: "explain",
      executionTier: "direct_chat",
      route: "single_model_answer",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "code-verb-computer",
    prompt: "code a timer in Python on my computer",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "program-verb-desktop",
    prompt: "program a calculator in JavaScript for my desktop",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "script-verb-downloads",
    prompt: "script a backup tool for my Downloads folder",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "program-typo-prgram",
    prompt: "prgram a calculator in JavaScript for my desktop",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "create-typo-file",
    prompt: "crate a file for the project",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "downloads-typo-code-delivery",
    prompt: "create a photo renaming script and save it to my dowloads folder",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    // The EXACT prompt e2e/notebook-execution-live.spec.ts submits.
    id: "desktop-notebook-execution-lane",
    prompt: "create a Jupyter notebook on my desktop that computes the first 12 Fibonacci numbers starting from 0 and 1, run its cells so the saved notebook contains the printed sequence as real outputs, and deliver it",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      reasonsInclude: ["code_execution_intent"],
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "notebook-fast-path-defers",
    prompt: "create a Jupyter notebook on my desktop that computes the first 12 Fibonacci numbers starting from 0 and 1, run its cells so the saved notebook contains the printed sequence as real outputs, and deliver it",
    expected: {
      route: "grounded_workflow",
      reasonsInclude: ["code_execution_intent"],
      requiredCodeToolNames: FULL_DESKTOP_LADDER,
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "pass",
  },
  {
    id: "guard-jupyter-reflection-write",
    prompt: "Write the final reflection to a Jupyter notebook.",
    expected: {
      speechAct: "persist",
      requiredCodeToolNames: [],
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "stem-cs-raft-research-note",
    prompt: "I want you to write me a 1000 word research note on the Raft consensus algorithm. Cite at least 5-10 scholarly and academic sources. I want you to stream your results into this note page. Change the title as well.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      reasonsInclude: ["web_search_intent"],
      requiredCodeToolNames: [],
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    current: {
      // WS-2: title+stream should land on active_note append/stream after rename.
      noteOutputDestination: "chat",
      noteOutputDelivery: "atomic",
    },
    status: "known_miss",
  },
  {
    id: "guard-brief-about-dfs-bfs-in-python",
    prompt: "Write me brief about dfs and bfs in python",
    expected: {
      route: "direct_writeback",
      reasonsInclude: ["direct_current_note_writeback:append"],
      requiredCodeToolNames: [],
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "pass",
  },
  {
    id: "stem-ai-rlhf-research-note",
    prompt: "I want you to write me a 1000 word research note on reinforcement learning from human feedback. Cite at least 5-10 scholarly and academic sources. I want you to stream your results into this note page. Change the title as well.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      requiredCodeToolNames: [],
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    current: {
      // WS-2: title+stream should land on active_note append/stream after rename.
      noteOutputDestination: "chat",
      noteOutputDelivery: "atomic",
    },
    status: "known_miss",
  },

  // --- Missing prompt families (WS-5) ---
  {
    // Possessive sources must count as fetched-web, not literary.
    id: "possessive-cite-your-sources",
    prompt: "Cite your sources.",
    expected: {
      speechAct: "explain",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
      reasonsInclude: ["web_search_intent"],
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  {
    // Possessive sources must count as fetched-web, not literary.
    id: "possessive-include-sources",
    prompt: "Include sources.",
    expected: {
      speechAct: "explain",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
      reasonsInclude: ["web_search_intent"],
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  {
    // Possessive sources must count as fetched-web, not literary.
    id: "possessive-back-this-up",
    prompt: "Back this up with sources.",
    expected: {
      speechAct: "explain",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
      reasonsInclude: ["web_search_intent"],
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  {
    // Literary book citations must stay non-web.
    id: "literary-quotations-citations-from-the-book",
    prompt: "Write an essay on the themes of the novel with quotations and citations from the book.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  {
    // Page-clear family: replace the current note, do not append.
    id: "page-clear-delete-all-first",
    prompt: "Delete all the notes on the page first.",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "single_model_writeback",
      streamingWritebackKind: "replace",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "replace",
      noteOutputDelivery: "stream",
      reasonsInclude: ["streaming_writeback:replace"],
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  {
    // Typo rescue for Delate must still page-clear-replace.
    id: "page-clear-delate",
    prompt: "Delate all the notes on the page first.",
    expected: {
      speechAct: "explain",
      executionTier: "bounded_tool",
      route: "single_model_writeback",
      streamingWritebackKind: "replace",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "replace",
      noteOutputDelivery: "stream",
      reasonsInclude: ["streaming_writeback:replace"],
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  {
    // known_miss WS-2: Wipe this note. should page-clear-replace, not default-append.
    id: "page-clear-wipe-this-note",
    prompt: "Wipe this note.",
    expected: {
      speechAct: "explain",
      executionTier: "bounded_tool",
      route: "single_model_writeback",
      streamingWritebackKind: "replace",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "replace",
      noteOutputDelivery: "stream",
    },
    current: {
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "known_miss",
  },
  {
    // known_miss WS-2: Start over on this page. should page-clear-replace.
    id: "page-clear-start-over",
    prompt: "Start over on this page.",
    expected: {
      speechAct: "explain",
      executionTier: "bounded_tool",
      route: "single_model_writeback",
      streamingWritebackKind: "replace",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "replace",
      noteOutputDelivery: "stream",
    },
    current: {
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    status: "known_miss",
  },
  {
    // known_miss WS-2: title+stream destination should be active_note append/stream after rename.
    id: "title-clause-stream-with-rename",
    prompt: "Write a 200 word brief on photosynthesis. Stream onto this page. Change the title as well.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "tool_required",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    current: {
      route: "tool_required",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "known_miss",
  },
  {
    // Stream onto this page without a title clause should stay on the active note.
    id: "title-clause-stream-without-rename",
    prompt: "Write a 200 word brief on photosynthesis. Stream onto this page.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  {
    // Wrapper only; page-content reclassify happens later in AgentRunner when the note is read.
    id: "prompt-on-page-run",
    prompt: "Run the prompt on the page.",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "single_model_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  {
    // Wrapper only; page-content reclassify happens later in AgentRunner when the note is read.
    id: "prompt-on-page-do-whats",
    prompt: "Do what's on the page.",
    expected: {
      speechAct: "explain",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  {
    // new line must not be mistaken for new note.
    id: "new-line-append",
    prompt: "Append one new line to the current note.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
      requiredCodeToolNames: [],
    },
    status: "pass",
  },
  {
    // known_miss WS-2: Create a new note titled X should dest new_note, not current-note writeback.
    id: "new-note-titled",
    prompt: "Create a new note titled Photosynthesis Brief.",
    expected: {
      speechAct: "execute",
      executionTier: "bounded_tool",
      route: "tool_required",
      streamingWritebackKind: null,
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "new_note",
      noteOutputMutation: "create",
      noteOutputDelivery: "atomic",
    },
    current: {
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "chat",
      noteOutputMutation: "append",
      noteOutputDelivery: "atomic",
    },
    status: "known_miss",
  },
  {
    // known_miss WS-2: architecture is a design noun; this must stay scholarly stream-to-page, not a design mission.
    id: "transformer-architecture-without-research-word",
    prompt: "Write a 1000 word note on the transformer architecture. Cite scholarly sources. Stream onto this page.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "grounded_workflow",
      reasonsInclude: ["web_search_intent"],
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
      requiredCodeToolNames: [],
    },
    current: {
      route: "grounded_workflow",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
    },
    status: "known_miss",
  },
  {
    // known_miss WS-2: working memory is the topic, not research-memory read.
    id: "working-memory-steal",
    prompt: "Write a note about working memory onto this page.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    current: {
      route: "tool_required",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
    },
    status: "known_miss",
  },
  {
    // known_miss WS-2: a References section is note structure, not graph-connection.
    id: "references-section-steal",
    prompt: "Write a research note with a References section onto this page.",
    expected: {
      speechAct: "persist",
      executionTier: "bounded_tool",
      route: "direct_writeback",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: "append",
      noteOutputDestination: "active_note",
      noteOutputMutation: "append",
      noteOutputDelivery: "stream",
    },
    current: {
      route: "grounded_workflow",
      streamingWritebackKind: "append",
      directCurrentNoteWritebackKind: null,
      noteOutputDestination: "active_note",
    },
    status: "known_miss",
  },
];

export const CORPUS_TOOL_NAMES = [
  "append_to_current_file",
  "replace_current_file",
  "search_markdown_files",
  "web_search",
  "web_fetch",
  "count_words",
  "code_sandbox_status",
  "code_workspace_create",
  "code_workspace_create_file",
  "code_validate_fast",
  "code_repair_record_cycle",
  "code_validate_targeted",
  "code_validate_full",
  "code_workspace_export_directory",
  "code_commit_verified",
] as const;

const ACTIVE_MARKDOWN_NOTE = {
  path: "Notes/Active.md",
  extension: "md",
  basename: "Active",
};

/**
 * Representative host the AgentRunner writeback pipeline sees for an ordinary
 * current-note mission: an active markdown file, streaming on, and
 * streamWritebackMode "all_current_note_content_writes".
 */
export function createRepresentativeRoutingContext(
  prompt: string,
  missionIntent?: MissionIntent,
): ToolExecutionContext {
  const unusedHttp: ToolExecutionContext["httpTransport"] = async () => {
    throw new Error("routing corpus does not perform HTTP");
  };
  return {
    app: {
      workspace: {
        getActiveFile: () => ACTIVE_MARKDOWN_NOTE,
      },
      vault: {
        read: async () => "",
        modify: async () => {},
      },
      metadataCache: {
        getFileCache: () => ({ headings: [] }),
      },
    },
    settings: {
      enableStreaming: true,
      streamWritebackMode: "all_current_note_content_writes",
      autoTitleOnWrite: true,
      outputProfile: "active_or_new_note",
    } as AgentSettings,
    originalPrompt: prompt,
    httpTransport: unusedHttp,
    writeAutonomy: missionIntent?.allowAutonomousWrite ?? false,
    missionIntent,
    getCurrentMarkdownFile: () => ACTIVE_MARKDOWN_NOTE as never,
  } as unknown as ToolExecutionContext;
}

function corpusTool(name: string): ModelToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    },
  };
}

/**
 * Production-shaped routing observation. Mirrors AgentRunner's compute chain:
 * classifyMissionIntent -> applyDefaultActiveNoteWriteback (forceChatOnly from
 * the speech-act tier, as the runner does for direct_chat) ->
 * getStreamingWritebackKind -> getDirectCurrentNoteWritebackKind ->
 * buildMissionNoteOutputPlan -> createRunPlan.
 *
 * Does not accept a hand-set streamingWritebackKind. Cases that previously
 * injected a stale kind (notebook-fast-path-defers) now observe the kind
 * production would actually compute.
 */
export function observeProductionRouting(input: {
  prompt: string;
  extraTools?: readonly string[];
}): ProductionRoutingObservationV1 {
  const speech = classifyMissionSpeechAct(input.prompt);
  const forceChatOnly =
    speech.executionTier === "direct_chat" || speech.explicitChatOnly;
  const missionIntent = applyDefaultActiveNoteWriteback({
    prompt: input.prompt,
    missionIntent: classifyMissionIntent(input.prompt, {
      hasActiveMarkdownNote: true,
    }),
    toolContext: createRepresentativeRoutingContext(input.prompt),
    enableStreaming: true,
    forceChatOnly,
  });
  const toolContext = createRepresentativeRoutingContext(
    input.prompt,
    missionIntent,
  );
  const streamingWritebackKind = getStreamingWritebackKind(
    input.prompt,
    toolContext,
    true,
  );
  const directCurrentNoteWritebackKind = getDirectCurrentNoteWritebackKind({
    prompt: input.prompt,
    missionIntent,
    streamingWritebackKind,
    toolContext,
  });
  const noteOutput = buildMissionNoteOutputPlan({
    prompt: input.prompt,
    missionIntent,
    toolContext,
    enableStreaming: true,
    forceChatOnly,
  });
  const plan = createRunPlan({
    prompt: input.prompt,
    missionIntent,
    tools: [...CORPUS_TOOL_NAMES, ...(input.extraTools ?? [])].map(corpusTool),
    settings: toolContext.settings,
    streamingWritebackKind,
    directCurrentNoteWritebackKind,
    speechActOverride: speech,
    outputTarget: noteOutput.destination,
  });
  return {
    speechAct: speech.speechAct,
    executionTier: speech.executionTier,
    route: plan.route,
    traceReasons: plan.traceReasons,
    requiredCodeToolNames: getRequiredCodeWorkflowToolNames(input.prompt),
    streamingWritebackKind,
    directCurrentNoteWritebackKind,
    noteOutput,
    missionIntent,
  };
}
