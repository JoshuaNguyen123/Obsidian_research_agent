import { defineConfig } from "@playwright/test";

const activeLanes = new Set(
  (process.env.E2E_PLAYWRIGHT_LANE ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const liveGlobalTimeout = activeLanes.has("real-ai-contract")
  ? 15 * 60_000
  : activeLanes.has("real-ai-soak")
    ? 60 * 60_000
    : activeLanes.has("release-vertical")
      ? 120 * 60_000
      : undefined;

// These native UI/approval cases still share the monolithic harness.
// New Phase 6/7 integration coverage is routed by dedicated spec file below.
const legacyIntegrationMockTitles =
  /(?:Linear settings start sanitized|explicit GitHub review repair uses the native exact approval surface)/iu;
const companionRestartTitles =
  /(?:phase-3 authenticated companion continuation|companion-owned Linear queue polling|background Code companion continuation|background GitHub companion continuation)/iu;
const realAiTitles = /real ai generated output/iu;
// These historical core-host execution scenarios use the removed inline/native
// run_code_block contract. Phase 4 owns the replacement coverage against the
// production Code extension: durable workspaces, sandbox fail-closed behavior,
// isolated repair/validation/commit, and extension disablement.
const supersededCoreCodeTitles =
  /(?:code workspace multi-file run|code workflow runs javascript with streamed output and exit-code proof|approval card gates long code runs through deny and approve)/iu;
const nonCoreTitles = new RegExp(
  [
    legacyIntegrationMockTitles,
    companionRestartTitles,
    realAiTitles,
    supersededCoreCodeTitles,
  ]
    .map((pattern) => pattern.source)
    .join("|"),
  "iu",
);

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  globalTimeout: liveGlobalTimeout,
  retries: process.env.CI ? 2 : 0,
  timeout: 120_000,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["./e2e/reporters/dailyUseReporter.ts"],
  ],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "deterministic-core-mock",
      testMatch: /obsidian-agent\.spec\.ts/u,
      grepInvert: nonCoreTitles,
      timeout: 180_000,
      expect: { timeout: 15_000 },
    },
    {
      name: "integration-mock",
      testMatch: /(?:phase6-linear|phase7-github)\.spec\.ts/u,
      timeout: 420_000,
      expect: { timeout: 20_000 },
    },
    {
      name: "integration-mock-legacy",
      testMatch: /obsidian-agent\.spec\.ts/u,
      grep: legacyIntegrationMockTitles,
      timeout: 420_000,
      expect: { timeout: 20_000 },
    },
    {
      name: "sandbox",
      testMatch: /phase4-code\.spec\.ts/u,
      timeout: 420_000,
      expect: { timeout: 30_000 },
    },
    {
      name: "companion-restart",
      testMatch:
        /(?:obsidian-agent|phase3-effectful-companion|companion-linear-queue|background-code-companion|background-github-companion)\.spec\.ts/u,
      grep: companionRestartTitles,
      timeout: 600_000,
      expect: { timeout: 30_000 },
    },
    {
      name: "real-ai-contract",
      testMatch: /real-ai-contract\.spec\.ts/u,
      retries: 0,
      timeout: 900_000,
      expect: { timeout: 180_000 },
    },
    {
      name: "daily-use-mock",
      testMatch: /daily-use-.*\.spec\.ts/u,
      timeout: 240_000,
      expect: { timeout: 20_000 },
    },
    {
      name: "real-ai-soak",
      testMatch: /real-ai-soak\.spec\.ts/u,
      retries: 0,
      timeout: 3_600_000,
      expect: { timeout: 180_000 },
    },
    {
      name: "provider-canary",
      testMatch: /provider-canary\.spec\.ts/u,
      retries: 0,
      timeout: 900_000,
      expect: { timeout: 180_000 },
    },
    {
      name: "release-vertical",
      testMatch: /release-vertical\.spec\.ts/u,
      retries: 0,
      timeout: 3_600_000,
      expect: { timeout: 180_000 },
    },
    {
      name: "disposable-live-external",
      testMatch: /disposable-live-external\.spec\.ts/u,
      retries: 0,
      timeout: 600_000,
      expect: { timeout: 30_000 },
    },
    {
      name: "configured-linear-live",
      testMatch: /configured-linear-live\.spec\.ts/u,
      retries: 0,
      timeout: 600_000,
      expect: { timeout: 30_000 },
    },
  ],
});
