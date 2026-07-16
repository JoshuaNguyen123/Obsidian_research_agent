import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyDailyUseFailure } from "../e2e/fixtures/dailyUseFailureClassification";

describe("daily-use Playwright failure classification", () => {
  it("binds stable scenario IDs to task families", () => {
    assert.deepEqual(
      classifyDailyUseFailure({
        title: "DU-05 verified push",
        file: "e2e/daily-use-github.spec.ts",
        project: "integration-mock",
        errorMessages: ["Expected remote SHA readback"],
      }),
      {
        scenarioId: "DU-05",
        taskFamily: "github",
        category: "product_assertion",
      },
    );
  });

  it("separates setup, provider competence, lifecycle, mapping, and cleanup failures", () => {
    const cases = [
      ["Protected release vertical missing: E2E_LINEAR_API_KEY", "credential_setup"],
      ["provider_budget_exhausted before usable evidence", "provider_competence"],
      ["Obsidian.exe process did not exit and CDP port remains in use", "process_lifecycle"],
      ["EPERM: main.js has a user-mapped section open", "windows_file_mapping"],
      ["cleanup failed while restoring data.json", "cleanup"],
    ] as const;
    for (const [message, category] of cases) {
      assert.equal(
        classifyDailyUseFailure({
          title: "DU-06 protected vertical",
          file: "e2e/release-vertical.spec.ts",
          project: "release-vertical",
          errorMessages: [message],
        }).category,
        category,
      );
    }
  });

  it("does not persist or return inspected error text", () => {
    const secretLikeMessage = "credential github_pat_DO_NOT_PERSIST_THIS_VALUE";
    const result = classifyDailyUseFailure({
      title: "connection preflight",
      file: "e2e/daily-use-settings.spec.ts",
      project: "daily-use-mock",
      errorMessages: [secretLikeMessage],
    });
    assert.equal(result.taskFamily, "settings");
    assert.equal(result.category, "credential_setup");
    assert.equal(JSON.stringify(result).includes("DO_NOT_PERSIST"), false);
  });
});
