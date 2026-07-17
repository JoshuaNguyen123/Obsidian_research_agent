export type ToolRisk = "low" | "medium" | "high";

export type ToolStatus = "ok" | "blocked" | "requires_approval" | "error";

export interface ArtifactRef {
  kind: "note" | "canvas" | "screenshot" | "source" | "receipt" | "memory";
  path?: string;
  url?: string;
  id?: string;
  title?: string;
}

export interface SafetyDecision {
  status: "allow" | "require_approval" | "block";
  risk: ToolRisk;
  reason: string;
  policyTags: string[];
}

export interface ToolCall<TInput = unknown> {
  id: string;
  missionId: string;
  step: number;
  name: string;
  input: TInput;
  risk: ToolRisk;
  createdAt: string;
}

export interface ToolReceipt {
  id: string;
  missionId: string;
  toolCallId: string;
  toolName: string;
  risk: ToolRisk;
  status: ToolStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: string;
  safetyDecision?: SafetyDecision;
  artifacts?: ArtifactRef[];
  error?: string;
}

export interface ToolResult<TObservation = unknown> {
  ok: boolean;
  observation?: TObservation;
  receipt: ToolReceipt;
  error?: string;
}

export interface BrowserOpenInput {
  url: string;
  missionMode?: "supervised" | "extract_only";
}

export interface BrowserClickInput {
  candidateId?: string;
  selector?: string;
  candidateFingerprint?: string;
  x?: number;
  y?: number;
  button?: "left" | "middle" | "right";
}

export interface BrowserTypeInput {
  candidateId?: string;
  selector?: string;
  candidateFingerprint?: string;
  text: string;
  clearFirst?: boolean;
}

export interface BrowserKeypressInput {
  key: string;
  candidateId: string;
  selector: string;
  candidateFingerprint: string;
}

export interface BrowserScrollInput {
  direction: "up" | "down" | "left" | "right";
  amount?: number;
}

export interface BrowserScreenshotInput {
  fullPage?: boolean;
}

export interface BrowserExtractMarkdownInput {
  includeLinks?: boolean;
  maxChars?: number;
}

export interface ClickableCandidate {
  id: string;
  label: string;
  role?: string;
  tagName?: string;
  selector?: string;
  candidateFingerprint: string;
  href?: string;
  formAction?: string;
  formMethod?: string;
  submitsForm?: boolean;
  inputType?: string;
  text?: string;
  focused?: boolean;
  enabled: boolean;
  visible: boolean;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  riskHints?: string[];
}

export interface BrowserObservation {
  url: string;
  title?: string;
  visibleTextSummary?: string;
  visibleText?: string;
  screenshotPath?: string;
  candidates: ClickableCandidate[];
  pageStateHints: string[];
  observedAt: string;
  observationFingerprint: string;
}

export type MemoryKind = "episodic" | "semantic" | "procedural" | "source";

export interface MemoryWriteInput {
  vaultScopeId: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  tags?: string[];
  sourceUrl?: string;
  sourceTitle?: string;
  noteReceiptFingerprint?: string;
  evidenceRefs?: ArtifactRef[];
  taskId?: string;
}

export interface MemorySearchInput {
  vaultScopeId: string;
  query: string;
  kinds?: MemoryKind[];
  tags?: string[];
  limit?: number;
  minScore?: number;
}

export interface MemorySearchResult {
  id: string;
  vaultScopeId: string;
  kind: MemoryKind;
  content: string;
  score: number;
  confidence: number;
  tags: string[];
  sourceUrl?: string;
  sourceTitle?: string;
  noteReceiptFingerprint?: string;
  createdAt: string;
}

export interface MemoryDeleteInput {
  vaultScopeId: string;
  memoryId: string;
}

export interface MemoryClearInput {
  vaultScopeId: string;
  kinds?: MemoryKind[];
}

export interface MemoryMutationReceiptV1 {
  version: 1;
  operation: "delete" | "clear";
  vaultScopeId: string;
  deletedCount: number;
  deletedIds: string[];
  observedAt: string;
  fingerprint: string;
}
