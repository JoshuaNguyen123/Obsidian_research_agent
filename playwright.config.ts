import { defineConfig } from "@playwright/test";

const activeLanes = new Set(
  (process.env.E2E_PLAYWRIGHT_LANE ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const protectedLogMode = process.env.E2E_PROTECTED_LOG_MODE === "1";
const liveGlobalTimeout = activeLanes.has("release-vertical") ||
    activeLanes.has("daily-use-compound")
  ? 120 * 60_000
  : activeLanes.has("daily-use-code-live") ||
      activeLanes.has("real-ai-soak")
    ? 60 * 60_000
    : activeLanes.has("real-ai-contract") ||
        activeLanes.has("daily-use-research")
      ? 15 * 60_000
      : undefined;

// These native UI/approval cases still share the monolithic harness.
// New Phase 6/7 integration coverage is routed by dedicated spec file below.
const legacyIntegrationMockTitles =
  /(?:Linear settings start sanitized|explicit GitHub review repair uses the native exact approval surface)/iu;
const companionRestartTitles =
  /(?:phase-3 authenticated companion continuation|companion-owned Linear queue polling|background Code companion continuation|background GitHub companion continuation)/iu;
const realAiTitles = /real ai generated output/iu;
const dailyUseNoteTitles =
  /DU-01 automatic mode creates one collision-free note when no markdown note is active/iu;
const dailyUseMemoryReflexTitles =
  /(?:agentic reflex routes ambiguous semantic prompt|small context budget compacts loop messages mid-run|research memory save clear reload recall|vault-scoped research memory isolation|canonical continuation handoff|reflex safety and unchanged-loop control)/iu;
const protectedDailyUseCodeTitles =
  /DU-03 protected real-model TypeScript project creation, validation, README, commit, and readback/iu;
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
  reporter: protectedLogMode
    ? [["./e2e/reporters/dailyUseReporter.ts"]]
    : [
        ["list"],
        ["html", { open: "never" }],
        ["./e2e/reporters/dailyUseReporter.ts"],
      ],
  use: {
    screenshot: protectedLogMode ? "off" : "only-on-failure",
    trace: protectedLogMode ? "off" : "retain-on-failure",
    video: protectedLogMode ? "off" : "retain-on-failure",
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
      testMatch: /(?:daily-use-linear|daily-use-github)\.spec\.ts/u,
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
      testMatch: /daily-use-code\.spec\.ts/u,
      grepInvert: protectedDailyUseCodeTitles,
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
      testMatch: /daily-use-research\.spec\.ts/u,
      retries: 0,
      timeout: 900_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "daily-use-mock",
      testMatch: /daily-use-connections\.spec\.ts/u,
      timeout: 240_000,
      expect: { timeout: 20_000 },
    },
    {
      name: "daily-use-connections",
      testMatch: /daily-use-connections\.spec\.ts/u,
      timeout: 240_000,
      expect: { timeout: 20_000 },
    },
    {
      name: "daily-use-note",
      testMatch: /daily-use-note\.spec\.ts/u,
      grep: dailyUseNoteTitles,
      timeout: 300_000,
      expect: { timeout: 20_000 },
    },
    {
      name: "daily-use-memory-reflex",
      testMatch: /daily-use-memory-reflex\.spec\.ts/u,
      grep: dailyUseMemoryReflexTitles,
      timeout: 420_000,
      expect: { timeout: 30_000 },
    },
    {
      name: "daily-use-research",
      testMatch: /daily-use-research\.spec\.ts/u,
      retries: 0,
      timeout: 900_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "daily-use-code",
      testMatch: /daily-use-code\.spec\.ts/u,
      grepInvert: protectedDailyUseCodeTitles,
      timeout: 420_000,
      expect: { timeout: 30_000 },
    },
    {
      name: "daily-use-code-live",
      testMatch: /daily-use-code\.spec\.ts/u,
      grep: protectedDailyUseCodeTitles,
      retries: 0,
      timeout: 2_700_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "daily-use-linear",
      testMatch: /daily-use-linear\.spec\.ts/u,
      timeout: 420_000,
      expect: { timeout: 30_000 },
    },
    {
      name: "daily-use-github",
      testMatch: /daily-use-github\.spec\.ts/u,
      timeout: 420_000,
      expect: { timeout: 30_000 },
    },
    {
      name: "daily-use-compound",
      testMatch: /daily-use-compound\.spec\.ts/u,
      retries: 0,
      timeout: 3_600_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "real-ai-soak",
      testMatch: /real-ai-soak\.spec\.ts/u,
      retries: 0,
      timeout: 3_600_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "provider-canary",
      testMatch: /provider-canary\.spec\.ts/u,
      retries: 0,
      timeout: 900_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "release-vertical",
      testMatch: /daily-use-compound\.spec\.ts/u,
      retries: 0,
      timeout: 3_600_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "disposable-live-external",
      testMatch: /disposable-live-external\.spec\.ts/u,
      retries: 0,
      timeout: 600_000,
      expect: { timeout: 30_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "configured-linear-live",
      testMatch: /configured-linear-live\.spec\.ts/u,
      retries: 0,
      timeout: 600_000,
      expect: { timeout: 30_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
  ],
});
