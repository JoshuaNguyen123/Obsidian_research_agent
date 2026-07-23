/**
 * Host-owned speech-act classification. Domain nouns are deliberately not
 * authority: only an action clause can turn discussion about a pipeline into
 * execution of that pipeline.
 */
export type MissionSpeechAct =
  | "explain"
  | "evaluate"
  | "execute"
  | "persist"
  | "continue";

export type ExecutionTier =
  | "direct_chat"
  | "bounded_tool"
  | "durable_mission";

export interface MissionSpeechActClassificationV1 {
  speechAct: MissionSpeechAct;
  executionTier: ExecutionTier;
  reasons: readonly string[];
  explicitChatOnly: boolean;
}

export function classifyMissionSpeechAct(
  prompt: string,
): MissionSpeechActClassificationV1 {
  const value = prompt.trim();
  if (!value) {
    return result("explain", "direct_chat", ["empty_prompt"]);
  }

  const explicitChatOnly =
    /\b(?:chat[- ]only|answer (?:only )?in (?:the )?chat|(?:do not|don'?t|without)\s+(?:write|writing|save|saving|append|appending|persist|persisting)(?:\s+(?:to|in))?\s+(?:the\s+)?(?:current\s+)?(?:document|note|page|file|vault|memory)|no (?:specific )?(?:document|note|page|file))\b/iu.test(
      value,
    );
  const continuation =
    /^\s*(?:continue|resume)\b/iu.test(value) ||
    /\b(?:continue|resume)\s+(?:the\s+)?(?:latest|prior|previous|named)\s+(?:run|mission)\b/iu.test(
      value,
    ) ||
    /\brun-[a-z0-9][a-z0-9._-]{5,}\b/iu.test(value);
  if (continuation && !explicitChatOnly) {
    return result("continue", "durable_mission", [
      "explicit_continuation",
    ]);
  }

  const explicitPersistence =
    /\b(?:write|save|append|replace|edit|rewrite|retitle|rename|persist|record|store|trash|delete)\b/iu.test(
      value,
    ) &&
    /\b(?:note|document|page|file|vault|memory|reflection|canvas|diagram|artifact|essay|report|brief)\b/iu.test(
      value,
    );
  const actionVerb =
    "(?:call|run|execute|search|research|look up|fetch|make|generate|draw|implement|build|fix|repair|patch|refactor|create|seed|publish|commit|push|validate|test|deploy|open|submit|send|clean up|delete|update|modify|revise|close|reopen|count|inspect|read|list|trash|move|copy|install)";
  const explicitExecution =
    new RegExp(
      `(?:^|[.!?]\\s*|\\b(?:please|then|and then|after that|i (?:want|need) you to)\\s+)${actionVerb}\\b|\\b(?:can|could|would|will) you\\s+${actionVerb}\\b`,
      "iu",
    ).test(value);
  const namedExternalMutation =
    /\b(?:github_(?:create|update|delete|archive|merge|publish|push|close|reopen)_[a-z0-9_]+|linear_(?:create|update|delete|archive|unarchive|comment|close|reopen)_[a-z0-9_]+)\b/iu.test(
      value,
    );
  const analyticalQuestion =
    /\b(?:from your perspective|what (?:is|was|are|were) (?:hard|difficult|missing|wrong)|how (?:does|do|did|would|can)\b|analy[sz]e\b|explain\b|rate|rating|evaluate|assess|assessment|critique|review|honest (?:technical )?opinion|usefulness|strengths? and weaknesses?|pros? and cons?|what happened|why did)\b/iu.test(
      value,
    );
  const platformAssessment =
    /\b(?:platform|harness|agentic (?:pipeline|gap|gaps)|capabilit(?:y|ies)|tool frontier|missiongraph|mission graph|obsidian.{0,80}linear.{0,80}(?:code|github|reflection))\b/iu.test(
      value,
    );
  const questionForm =
    /(?:\?|^\s*(?:what|why|how|which|where|when|is|are|do|does|did|can|could|would|should)\b)/iu.test(
      value,
    );
  const compoundStages = [
    /\b(?:research|source|obsidian|note|vault)\b/iu.test(value),
    /\blinear\b/iu.test(value),
    /\b(?:repository|repo|workspace|codebase|code files?|implement|validation)\b/iu.test(
      value,
    ),
    /\b(?:github|commit|pull request|draft pr|publish|push)\b/iu.test(value),
    /\b(?:reflect(?:ion)?|research memory)\b/iu.test(value),
  ].filter(Boolean).length;
  const lifecycleSignal =
    /\b(?:full pipeline|end[- ]to[- ]end|then|after that|until (?:complete|done)|stay in the tool loop|do not stop)\b/iu.test(
      value,
    );

  if (!explicitChatOnly && explicitExecution) {
    return result(
      "execute",
      namedExternalMutation || compoundStages >= 2 || lifecycleSignal
        ? "durable_mission"
        : "bounded_tool",
      [
        "explicit_execution",
        ...(namedExternalMutation ? ["named_external_mutation"] : []),
        ...(compoundStages >= 2 ? ["compound_stage_request"] : []),
        ...(lifecycleSignal ? ["lifecycle_signal"] : []),
      ],
    );
  }

  if (!explicitChatOnly && explicitPersistence) {
    return result("persist", "bounded_tool", ["explicit_persistence"]);
  }

  if (explicitChatOnly || analyticalQuestion || (platformAssessment && questionForm)) {
    return result(
      /\b(?:rate|rating|evaluate|assess|assessment|critique|review|opinion|usefulness|strengths?|weaknesses?)\b/iu.test(
        value,
      )
        ? "evaluate"
        : "explain",
      "direct_chat",
      [
        explicitChatOnly ? "explicit_chat_only" : "analytical_request",
        ...(platformAssessment ? ["local_platform_assessment"] : []),
      ],
      explicitChatOnly,
    );
  }

  // Ordinary answers keep the product's active-note default available. Only
  // the high-confidence analytical/chat-only cases above bypass that behavior.
  return result("explain", "bounded_tool", ["ordinary_answer"]);
}

function result(
  speechAct: MissionSpeechAct,
  executionTier: ExecutionTier,
  reasons: string[],
  explicitChatOnly = false,
): MissionSpeechActClassificationV1 {
  return {
    speechAct,
    executionTier,
    reasons,
    explicitChatOnly,
  };
}
