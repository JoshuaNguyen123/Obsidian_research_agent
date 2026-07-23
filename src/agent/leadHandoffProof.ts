export function proofDebtSeedsFromOrchestratorHandoff(input: {
  unresolvedQuestions: string[];
  usableSourceCount: number;
  handoffReady: boolean;
}): { missing: string[]; nextToolHints: string[] } {
  const missing: string[] = [];
  const nextToolHints: string[] = [];

  if (!input.handoffReady || input.usableSourceCount === 0) {
    missing.push("orchestrator_handoff:usable_sources");
  }

  for (const question of input.unresolvedQuestions) {
    const trimmed = question.trim();
    if (trimmed) {
      missing.push(`orchestrator_handoff:unresolved:${trimmed}`);
    }
  }

  if (!input.handoffReady || input.usableSourceCount === 0) {
    nextToolHints.push("web_search", "web_fetch");
  }

  return {
    missing,
    nextToolHints: [...new Set(nextToolHints)],
  };
}
