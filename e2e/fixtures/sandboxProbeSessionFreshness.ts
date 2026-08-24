/**
 * What "the boundary probe is fresh" can honestly mean to a lane.
 *
 * `CodeExtensionRuntimeV2.ensureHostProvisionedSandboxReadinessV1` proves the
 * sandbox boundary once per plugin load and then serves that single proof to
 * every later caller for `DEFAULT_SANDBOX_PROBE_MAX_AGE_MS`, without restamping
 * `sandbox.lastProbe.observedAt`. That is the product contract, and
 * `tests/codeExtensionRuntimeV2.test.ts` pins both halves of it.
 *
 * So the only lower bound a lane may assert is the Obsidian session's own
 * origin: a probe replayed from durable history was stamped in an earlier
 * process and is always older, while this session's proof is always newer.
 * Comparing against an instant the lane recorded *after* `startRealAiHarness`
 * returned instead demands a second physical probe the product deliberately
 * never runs, and fails on every host whose load-time probe already succeeded.
 */
export function sandboxProbeProvenInSessionV1(input: {
  observedAt: string | null | undefined;
  sessionStartedAtMs: number;
}): boolean {
  if (!Number.isFinite(input.sessionStartedAtMs)) return false;
  const observedAtMs = Date.parse(String(input.observedAt ?? ""));
  return (
    Number.isFinite(observedAtMs) &&
    observedAtMs >= Math.floor(input.sessionStartedAtMs)
  );
}
