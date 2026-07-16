/**
 * Pure note-output decision for content-producing missions.
 * One plan controls destination, mutation, delivery, and title policy.
 */

export type NoteOutputDestination = "active_note" | "new_note" | "chat";
export type NoteOutputMutation = "append" | "replace" | "create";
export type NoteOutputDelivery = "stream" | "atomic";
export type NoteOutputTitlePolicy = "automatic" | "preserve" | "explicit";

export type NoteOutputReasonCode =
  | "explicit_chat_only"
  | "force_chat_only"
  | "trivial_chat"
  | "specialized_route"
  | "explicit_new_note"
  | "active_note_available"
  | "no_active_note_create"
  | "no_active_note_chat_first"
  | "active_note_only_no_file"
  | "output_streaming_disabled"
  | "replace_explicit"
  | "preserve_named_title";

export type AutonomyProfile = "automatic" | "conservative" | "custom";
export type OutputProfile =
  | "active_or_new_note"
  | "active_note_only"
  | "chat_first";

export interface NoteOutputPlan {
  destination: NoteOutputDestination;
  mutation: NoteOutputMutation;
  delivery: NoteOutputDelivery;
  title: NoteOutputTitlePolicy;
  reason: NoteOutputReasonCode;
}

export interface NoteOutputPolicyInput {
  prompt: string;
  forceChatOnly?: boolean;
  hasActiveMarkdownNote: boolean;
  activeNoteIsPlaceholder?: boolean;
  outputProfile: OutputProfile;
  enableStreaming: boolean;
  streamWritebackMode: "off" | "all_current_note_content_writes";
  autoTitleOnWrite: boolean;
  /** When true, keep specialized path tooling; do not coerce into default note stream. */
  specializedRoute?: boolean;
  /** Explicit create-new-note wording. */
  explicitNewNote?: boolean;
  /** Explicit whole-note replace / rewrite. */
  explicitReplace?: boolean;
  /** Explicit preserve/keep title wording. */
  preserveTitle?: boolean;
  /** Content-producing (draft/explain/report) vs trivial chat. */
  contentProducing?: boolean;
}

const CHAT_ONLY_PATTERN =
  /\b(chat\s+only|only\s+in\s+chat|answer\s+in\s+chat|respond\s+in\s+chat|do\s+not\s+(?:write|append|save)\s+(?:to|in|into)\s+(?:the\s+)?(?:note|page|document|file))\b/i;

const EXPLICIT_NEW_NOTE_PATTERN =
  /\b(create|make|new)\b[\s\S]{0,80}\b(note|markdown\s+file|file)\b|\b(note|markdown\s+file)\b[\s\S]{0,40}\b(named|called|titled)\b/i;

const EXPLICIT_REPLACE_PATTERN =
  /\b(replace|rewrite|overwrite|start\s+fresh|reset|clear\s+(?:and\s+)?write|delete\s+(?:the\s+)?(?:content|body)\s+and\s+write)\b/i;

const PRESERVE_TITLE_PATTERN =
  /\b(keep|preserve|do\s+not\s+(?:change|rename|retitle)|don'?t\s+(?:change|rename|retitle))\b[\s\S]{0,40}\b(title|name|filename)\b/i;

const CONTENT_PRODUCING_PATTERN =
  /\b(write|draft|compose|generate|research|investigate|summar(?:y|ize)|explain|essay|report|article|plan|analysis|how\s+to|guide|brief|markdown|append|put\s+(?:this|it)\s+(?:in|on|into)\s+(?:the\s+)?(?:note|page)|cited\s+findings|stream\s+writeback)\b/i;

const TRIVIAL_CHAT_PATTERN =
  /^(?:\s*(?:hi|hello|hey|thanks|thank\s+you|ok|okay|yes|no|sure|what(?:'s|\s+is)\s+up)\s*[.!?…]*)+$/i;

export function detectChatOnlyIntent(prompt: string): boolean {
  return CHAT_ONLY_PATTERN.test(prompt);
}

export function detectExplicitNewNoteIntent(prompt: string): boolean {
  return EXPLICIT_NEW_NOTE_PATTERN.test(prompt);
}

export function detectExplicitReplaceIntent(prompt: string): boolean {
  return EXPLICIT_REPLACE_PATTERN.test(prompt);
}

export function detectPreserveTitleIntent(prompt: string): boolean {
  return PRESERVE_TITLE_PATTERN.test(prompt);
}

export function detectContentProducingIntent(prompt: string): boolean {
  if (TRIVIAL_CHAT_PATTERN.test(prompt.trim())) {
    return false;
  }
  return CONTENT_PRODUCING_PATTERN.test(prompt) || prompt.trim().length >= 24;
}

export function resolveNoteOutputPlan(
  input: NoteOutputPolicyInput,
): NoteOutputPlan {
  const prompt = input.prompt ?? "";
  const streamingEnabled =
    input.enableStreaming &&
    input.streamWritebackMode === "all_current_note_content_writes";
  const delivery: NoteOutputDelivery = streamingEnabled ? "stream" : "atomic";
  const contentProducing =
    input.contentProducing ?? detectContentProducingIntent(prompt);
  const specialized = input.specializedRoute === true;
  const explicitNewNote =
    input.explicitNewNote ?? detectExplicitNewNoteIntent(prompt);
  const explicitReplace =
    input.explicitReplace ?? detectExplicitReplaceIntent(prompt);
  const preserveTitle =
    input.preserveTitle ?? detectPreserveTitleIntent(prompt);

  if (input.forceChatOnly) {
    return chatPlan("force_chat_only");
  }
  if (detectChatOnlyIntent(prompt)) {
    return chatPlan("explicit_chat_only");
  }
  if (specialized) {
    return chatPlan("specialized_route");
  }
  if (!contentProducing) {
    return chatPlan("trivial_chat");
  }

  const title = resolveTitlePolicy({
    autoTitleOnWrite: input.autoTitleOnWrite,
    preserveTitle,
    hasActiveMarkdownNote: input.hasActiveMarkdownNote,
    activeNoteIsPlaceholder: input.activeNoteIsPlaceholder === true,
  });

  if (explicitNewNote) {
    return {
      destination: "new_note",
      mutation: "create",
      delivery,
      title: preserveTitle ? "preserve" : input.autoTitleOnWrite ? "automatic" : "preserve",
      reason: "explicit_new_note",
    };
  }

  if (input.hasActiveMarkdownNote) {
    return {
      destination: "active_note",
      mutation: explicitReplace ? "replace" : "append",
      delivery,
      title,
      reason: explicitReplace ? "replace_explicit" : "active_note_available",
    };
  }

  if (input.outputProfile === "chat_first") {
    return chatPlan("no_active_note_chat_first");
  }
  if (input.outputProfile === "active_note_only") {
    return chatPlan("active_note_only_no_file");
  }

  // active_or_new_note (default Automatic / recommended)
  if (!streamingEnabled && input.outputProfile === "active_or_new_note") {
    return {
      destination: "new_note",
      mutation: "create",
      delivery: "atomic",
      title: input.autoTitleOnWrite && !preserveTitle ? "automatic" : "preserve",
      reason: "no_active_note_create",
    };
  }

  return {
    destination: "new_note",
    mutation: "create",
    delivery,
    title: input.autoTitleOnWrite && !preserveTitle ? "automatic" : "preserve",
    reason: "no_active_note_create",
  };
}

function resolveTitlePolicy(input: {
  autoTitleOnWrite: boolean;
  preserveTitle: boolean;
  hasActiveMarkdownNote: boolean;
  activeNoteIsPlaceholder: boolean;
}): NoteOutputTitlePolicy {
  if (input.preserveTitle) {
    return "preserve";
  }
  if (!input.autoTitleOnWrite) {
    return "preserve";
  }
  if (input.hasActiveMarkdownNote && !input.activeNoteIsPlaceholder) {
    return "preserve";
  }
  return "automatic";
}

function chatPlan(reason: NoteOutputReasonCode): NoteOutputPlan {
  return {
    destination: "chat",
    mutation: "append",
    delivery: "atomic",
    title: "preserve",
    reason,
  };
}

/** Derive effective output profile from legacy flags when profile is missing. */
export function deriveOutputProfileFromLegacy(input: {
  enableStreaming: boolean;
  streamWritebackMode: "off" | "all_current_note_content_writes";
  autoTitleOnWrite: boolean;
}): OutputProfile {
  if (
    !input.enableStreaming ||
    input.streamWritebackMode === "off"
  ) {
    return "chat_first";
  }
  if (!input.autoTitleOnWrite) {
    return "active_note_only";
  }
  return "active_or_new_note";
}

export function noteOutputPlanAllowsVaultWrite(plan: NoteOutputPlan): boolean {
  return plan.destination === "active_note" || plan.destination === "new_note";
}
