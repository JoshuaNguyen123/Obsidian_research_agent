/**
 * Lane selection for spec-level skip guards.
 *
 * `scripts/run-e2e-exclusive.mjs` sets `E2E_PLAYWRIGHT_LANE` to the
 * comma-joined list of selected projects. Guards written as
 * `process.env.E2E_PLAYWRIGHT_LANE !== LANE` therefore skipped themselves
 * whenever more than one project was selected — and Playwright still exited 0,
 * so a multi-project run reported success while silently running nothing.
 *
 * `scripts/run-e2e-exclusive.mjs` now fails a run in which a selected project
 * executed no test, so a guard mistake is loud. This helper removes the
 * mistake at the source.
 */
export function laneSelectedV1(lane: string): boolean {
  return (process.env.E2E_PLAYWRIGHT_LANE ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .includes(lane);
}
