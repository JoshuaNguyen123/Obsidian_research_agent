import type { AgentSettings } from "../../settings";
import type { MissionIntent } from "../../tools/types";
import type { SemanticEmbeddingProvider } from "../../embeddings/types";
import type { MissionEvidence } from "../missionLedger";

export type ReflexLabel =
  | "chat_answer"
  | "current_note_write"
  | "vault_search"
  | "semantic_vault_search"
  | "web_research"
  | "graph_context"
  | "template_work"
  | "word_count"
  | "design_artifact"
  | "code_execution"
  | "browser_learning"
  | "memory_update"
  | "unknown";

export interface ReflexDecision {
  label: ReflexLabel;
  confidence: number;
  applied: boolean;
  reason: string;
  safetyNotes: string[];
}

export interface AgentTrajectoryEvent {
  kind: "model" | "tool" | "final" | "status";
  name?: string;
  ok?: boolean;
  signature?: string;
}

export interface ReflexReceiptLike {
  toolName?: string;
  operation: string;
  path?: string;
}

export interface CandidateAgentAction {
  kind:
    | "answer"
    | "read_current_note"
    | "search_vault"
    | "semantic_search"
    | "read_files"
    | "web_search"
    | "web_fetch"
    | "count_words"
    | "write_current_note"
    | "create_artifact"
    | "ask_clarifying_question"
    | "stop_with_blocker";
  toolName?: string;
  rationale: string;
  risk: "read" | "write" | "destructive" | "external" | "none";
}

export interface ActionScore {
  action: CandidateAgentAction;
  score: number;
  reason: string;
}

export interface ProgressSignal {
  progressScore: number;
  loopRiskScore: number;
  shouldReflect: boolean;
  shouldStop: boolean;
  reason: string;
}

export interface CompletionSignal {
  complete: boolean;
  confidence: number;
  missing: string[];
  reason: string;
  mustContinue: boolean;
  recommendedNextTool?: string;
  blocker?: string;
}

export interface ReflexDiagnostics {
  enabled: boolean;
  topAction?: string;
  fallbackReason?: string;
}

export interface AgenticReflexInput {
  prompt: string;
  missionIntent: MissionIntent;
  allowedToolNames: Set<string>;
  recentActions: AgentTrajectoryEvent[];
  evidence: MissionEvidence[];
  receipts: ReflexReceiptLike[];
  settings?: AgentSettings;
  embeddingProvider?: SemanticEmbeddingProvider;
}

export interface AgenticReflexOutput {
  intent: ReflexDecision;
  actionScores: ActionScore[];
  progress: ProgressSignal;
  completion: CompletionSignal;
  diagnostics: ReflexDiagnostics;
}
