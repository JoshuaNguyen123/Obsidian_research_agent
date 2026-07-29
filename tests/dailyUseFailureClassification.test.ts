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
    assert.deepEqual(
      classifyDailyUseFailure({
        title: "BYOK-01 autonomous lifecycle",
        file: "e2e/byok-autonomous-journey.spec.ts",
        project: "byok-autonomous-journey",
        errorMessages: [],
      }),
      {
        scenarioId: "BYOK-01",
        taskFamily: "compound",
        category: "product_assertion",
      },
    );
    assert.deepEqual(
      classifyDailyUseFailure({
        title: "DESKTOP-01 bare-prompt scratch delivery",
        file: "e2e/desktop-checkers-delivery-real-live.spec.ts",
        project: "desktop-checkers-delivery-real-live",
        errorMessages: [],
      }),
      {
        scenarioId: "DESKTOP-01",
        taskFamily: "code",
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

  it("keeps structured path-scope and harness assertion failures in product triage", () => {
    const structuredPathScopeDiagnostic = JSON.stringify({
      stopReason: "no_progress",
      modelCallEvidence: {
        providerUsage: {
          successfulCallCount: 101,
          failedCallCount: 0,
        },
      },
      lastFailure: {
        code: "repository_path_out_of_scope",
        path: "pyproject.toml",
      },
    });
    assert.equal(
      classifyDailyUseFailure({
        title: "BYOK-01 autonomous lifecycle",
        file: "e2e/byok-autonomous-journey.spec.ts",
        project: "byok-autonomous-journey",
        errorMessages: [structuredPathScopeDiagnostic],
      }).category,
      "product_assertion",
    );

    const harnessAssertionDiagnostic = JSON.stringify({
      code: "harness_assertion_failed",
      modelCallEvidence: {
        providerUsage: {
          failedCallCount: 1,
        },
      },
    });
    assert.equal(
      classifyDailyUseFailure({
        title: "BYOK-01 independent verifier",
        file: "e2e/byok-autonomous-journey.spec.ts",
        project: "byok-autonomous-journey",
        errorMessages: [harnessAssertionDiagnostic],
      }).category,
      "product_assertion",
    );
  });

  it("still recognizes actual provider request and call failures", () => {
    for (const message of [
      "Provider request failed before a usable response.",
      JSON.stringify({
        code: "model_call_failed",
        providerUsage: { failedCallCount: 1 },
      }),
    ]) {
      assert.equal(
        classifyDailyUseFailure({
          title: "BYOK-01 autonomous lifecycle",
          file: "e2e/byok-autonomous-journey.spec.ts",
          project: "byok-autonomous-journey",
          errorMessages: [message],
        }).category,
        "provider_competence",
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
