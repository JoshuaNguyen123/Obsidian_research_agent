/**
 * Model-reported context window resolution.
 *
 * Ollama Cloud reports the model's maximum context window during the
 * connection test (/api/show). That evidence is persisted in settings and
 * consumed here so run budgets match the real model window instead of the
 * 48k assumption. Explicit Settings → Context window values always win.
 */

export interface ModelContextWindowSettingsSliceV1 {
  modelProvider?: string;
  model?: string;
  modelConnectionVerifiedProvider?: string;
  modelConnectionVerifiedModel?: string;
  modelConnectionVerifiedContextLength?: number | null;
}

/**
 * The verified context window for the active model, or null when the stored
 * evidence does not match the active provider + model. Restricted to the
 * ollama provider: OpenAI-compatible requests map num_ctx onto max_tokens,
 * so an auto-detected window must never flow there.
 */
export function resolveVerifiedModelContextLength(
  settings: ModelContextWindowSettingsSliceV1 | null | undefined,
): number | null {
  if (!settings) {
    return null;
  }
  if (settings.modelProvider !== "ollama") {
    return null;
  }
  if (settings.modelConnectionVerifiedProvider !== settings.modelProvider) {
    return null;
  }
  const activeModel = settings.model?.trim() ?? "";
  const verifiedModel = settings.modelConnectionVerifiedModel?.trim() ?? "";
  if (!activeModel || activeModel !== verifiedModel) {
    return null;
  }
  const contextLength = settings.modelConnectionVerifiedContextLength;
  if (
    typeof contextLength !== "number" ||
    !Number.isSafeInteger(contextLength) ||
    contextLength <= 0
  ) {
    return null;
  }
  return contextLength;
}
