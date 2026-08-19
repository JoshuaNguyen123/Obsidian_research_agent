export function buildByokPhaseAResearchPrompt(input: {
  marker: string;
  profileKey: string;
  validationProfileKey: string;
}): string {
  return [
    `Deeply research a small dependency-free Python CRDT library for marker ${input.marker}.`,
    "Use and fetch at least four independent sources exposed through the configured research backend. Reconcile their guidance on state-based G-Counter joins and observed-remove sets, including convergence, idempotence, concurrent add versus remove, and practical validation.",
    "After all four fetches, call create_project_idea_brief exactly once. Compare at least two dependency-free CRDT library directions, select one, and ground it with the exact four fetched source URLs. Treat its returned promotion seed as authoritative and copy every shared title, problem, evidence, proposed-work, non-goal, acceptance-criterion, and risk field byte-for-byte into accepted research publication.",
    "Write accepted research into the initiating note as a concise but substantive implementation brief, then publish that accepted research to exactly one Linear implementation issue in the configured destination.",
    "Keep the issue standalone; do not create a Linear project or initiative.",
    `The accepted package is executable code work for trusted repository key ${input.profileKey} and validation requirement key ${input.validationProfileKey}.`,
    "The issue must carry the source citations and behavioral acceptance contract: a GCounter supports replica-local non-negative increments, value, and convergent pointwise-max merge; an ORSet supports add, observed remove, value, union-style merge, concurrent add survival, and convergence after all tags are observed and removed.",
    `Require the public module crdt_sync.py and README.md to carry proof marker ${input.marker}; leave internal design, workspace identity, and implementation choices to the coding agent. Additional implementation files are allowed only when the accepted contract requires them.`,
    "Do not implement code or publish to GitHub in this phase. Finish only after accepted-research lineage, Linear provider readback, and the note backlink are durable.",
  ].join(" ");
}
