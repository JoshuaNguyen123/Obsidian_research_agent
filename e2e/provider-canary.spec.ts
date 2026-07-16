import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startRealAiHarness, type RealAiHarness } from "./fixtures/realAiHarness";

test("optional provider canary performs a real note write", async () => {
  test.setTimeout(900_000);
  const canaryModel = process.env.E2E_CANARY_MODEL?.trim();
  if (!canaryModel) throw new Error("E2E_CANARY_MODEL is required for the provider-canary project.");
  let harness: RealAiHarness | null = null;
  try {
    harness = await startRealAiHarness("provider-canary", { model: canaryModel });
    await harness.submitMission(`Append one sentence containing ${harness.marker} to this current note.`);
    expect(await readFile(harness.noteFilePath, "utf8")).toContain(harness.marker);
    await harness.attestProductionRun();
  } finally {
    await harness?.close();
  }
});
