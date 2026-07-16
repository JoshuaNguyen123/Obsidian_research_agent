import { expect, test } from "@playwright/test";
import { startRealAiHarness, type RealAiHarness } from "./fixtures/realAiHarness";

test("DU-06 protected release vertical is bound to one commit and real providers", async () => {
  test.setTimeout(3_600_000);
  const required = [
    "E2E_RELEASE_COMMIT_SHA",
    "E2E_LINEAR_API_KEY",
    "E2E_GITHUB_TOKEN",
    "E2E_RELEASE_LINEAR_PROJECT_ID",
    "E2E_RELEASE_GITHUB_REPOSITORY",
    "E2E_REAL_SANDBOX_PROVIDER",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Protected release vertical missing: ${missing.join(", ")}`);
  expect(process.env.GITHUB_SHA || process.env.E2E_RELEASE_COMMIT_SHA).toContain(
    process.env.E2E_RELEASE_COMMIT_SHA!,
  );

  let harness: RealAiHarness | null = null;
  try {
    harness = await startRealAiHarness("release-vertical-artifact");
    await harness.installOwnedWebBackend();
    await harness.submitMission(
      `Perform sourced research from the owned provider fixture and write a verified release artifact containing ${harness.marker}. This artifact will be consumed by the disposable Linear, sandbox, and GitHub release stages.`,
      { timeoutMs: 1_200_000 },
    );
    const snapshot = await harness.attestProductionRun({ requireStructuredRouting: true });
    expect(snapshot.lastReceipts.length).toBeGreaterThan(0);
    expect(snapshot.lastComplete.stopReason).not.toBe("error");
  } finally {
    await harness?.close();
  }
});
