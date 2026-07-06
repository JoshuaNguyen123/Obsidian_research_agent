import type { AgenticReflexInput, CompletionSignal } from "./types";

export function evaluateCompletion(input: AgenticReflexInput): CompletionSignal {
  const missing: string[] = [];
  if (input.missionIntent.requireWriteCompletion && input.receipts.length === 0) {
    missing.push("write_receipt");
  }
  if (requiresVaultEvidence(input.prompt) && !hasVaultEvidence(input)) {
    missing.push("vault_evidence");
  }
  if (requiresWebEvidence(input.prompt) && !hasWebEvidence(input)) {
    missing.push("web_evidence");
  }
  if (requiresWordCount(input.prompt) && !hasToolEvidence(input, "count_words")) {
    missing.push("word_count");
  }

  return {
    complete: missing.length === 0,
    confidence: missing.length === 0 ? 0.9 : 0.35,
    missing,
    reason:
      missing.length === 0
        ? "required_evidence_present"
        : "missing_required_evidence",
    mustContinue: missing.length > 0 && hasAllowedRecoveryTool(input, missing),
    recommendedNextTool: getRecommendedNextTool(input, missing),
    blocker:
      missing.length > 0 && !hasAllowedRecoveryTool(input, missing)
        ? "required_evidence_tool_unavailable"
        : undefined,
  };
}

export function requiresVaultEvidence(prompt: string): boolean {
  return /\b(vault|my notes|across notes|related notes|semantic search|what do my notes say|search my notes)\b/i.test(
    prompt,
  );
}

export function requiresWebEvidence(prompt: string): boolean {
  return /\b(web|online|sources?|citations?|latest|current\s+(?:events?|information|data|news)|verify|fact[-\s]?check)\b/i.test(
    prompt,
  );
}

export function requiresWordCount(prompt: string): boolean {
  return /\b(word\s*count|count\s+(?:the\s+)?words?|verify\s+(?:the\s+)?(?:word\s+)?length)\b/i.test(
    prompt,
  );
}

function hasVaultEvidence(input: AgenticReflexInput): boolean {
  return input.evidence.some((item) =>
    item.kind === "vault_note" || item.kind === "tool_result",
  );
}

function hasWebEvidence(input: AgenticReflexInput): boolean {
  return input.evidence.some((item) => item.kind === "web_source");
}

function hasToolEvidence(input: AgenticReflexInput, toolName: string): boolean {
  return input.recentActions.some(
    (event) => event.kind === "tool" && event.name === toolName && event.ok,
  );
}

function hasAllowedRecoveryTool(
  input: AgenticReflexInput,
  missing: string[],
): boolean {
  return getRecommendedNextTool(input, missing) !== undefined;
}

function getRecommendedNextTool(
  input: AgenticReflexInput,
  missing: string[],
): string | undefined {
  if (missing.includes("web_evidence")) {
    return input.allowedToolNames.has("web_fetch")
      ? "web_fetch"
      : input.allowedToolNames.has("web_search")
        ? "web_search"
        : undefined;
  }

  if (missing.includes("vault_evidence")) {
    for (const toolName of [
      "semantic_search_notes",
      "search_markdown_files",
      "inspect_vault_context",
      "read_markdown_files",
      "read_file",
    ]) {
      if (input.allowedToolNames.has(toolName)) {
        return toolName;
      }
    }
  }

  if (missing.includes("word_count") && input.allowedToolNames.has("count_words")) {
    return "count_words";
  }

  if (missing.includes("write_receipt")) {
    for (const toolName of [
      "append_to_current_file",
      "replace_current_file",
      "edit_current_section",
      "create_file",
      "append_file",
      "replace_file",
      "create_design_canvas",
      "create_svg_design",
      "create_design_package",
    ]) {
      if (input.allowedToolNames.has(toolName)) {
        return toolName;
      }
    }
  }

  return undefined;
}
