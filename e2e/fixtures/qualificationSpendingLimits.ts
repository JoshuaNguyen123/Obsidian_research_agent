/** A qualification run may narrow the installed limits, never increase them. */
export function constrainQualificationSpendingLimits(
  configured: Record<string, unknown>, overrides: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const bounded = { ...overrides };
  for (const key of ["maxAgentSteps", "maxRunMinutes", "maxLongRunSegments", "maxCompletionSegments",
    "overnightRunHours", "overnightMaxSegments", "orchestratorWorkerMaxSteps", "orchestratorWorkerMaxToolCalls", "orchestratorWorkerMaxMinutes"]) {
    const limit = configured[key];
    const proposed = overrides[key];
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      bounded[key] = typeof proposed === "number" && Number.isFinite(proposed) && proposed > 0
        ? Math.min(limit, proposed) : limit;
    }
  }
  return bounded;
}
