import { defineConfig } from "@playwright/test";

/**
 * Every project here drives the installed production plugin inside real
 * Obsidian. There is no mock-model lane: the deterministic suites were removed
 * because they passed on a host whose plugin could not actually run a mission
 * — they injected the sandbox provider configuration the product never adopted,
 * which is exactly the failure they were supposed to catch. Each lane below
 * calls a real model, a real external service, or both, except for explicit
 * native UI security probes that exercise the installed production renderer.
 * Every lane asserts on items that really exist afterwards.
 */

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
  : activeLanes.has("retained-journey") ||
      activeLanes.has("byok-autonomous-journey")
    ? 165 * 60_000
  : activeLanes.has("daily-use-code-live") ||
      activeLanes.has("desktop-code-delivery-real-live") ||
      activeLanes.has("vault-sibling-code-delivery-real-live") ||
      activeLanes.has("desktop-checkers-delivery-real-live") ||
      activeLanes.has("real-ai-soak") ||
      activeLanes.has("daily-use-research") ||
      activeLanes.has("core-native") ||
      activeLanes.has("obsidian-hello-github-live")
    ? 60 * 60_000
    : activeLanes.has("real-ai-contract")
      ? 15 * 60_000
      : undefined;

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
      // Default product-health proof: reported mission plus a run-owned artifact
      // destination, production model, native Obsidian writes, semantic
      // artifact QA, and atomic acceptance.
      name: "core-native",
      testMatch: /core-native\.spec\.ts/u,
      retries: 0,
      timeout: 900_000,
      expect: { timeout: 180_000 },
      use: {
        trace: protectedLogMode ? "off" : "retain-on-failure",
        screenshot: protectedLogMode ? "off" : "only-on-failure",
        video: protectedLogMode ? "off" : "retain-on-failure",
      },
    },
    {
      // Native UI security proof; no model or external service is required.
      name: "safe-assistant-renderer",
      testMatch: /safe-assistant-renderer\.spec\.ts/u,
      retries: 0,
      timeout: 240_000,
      expect: { timeout: 30_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
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
      name: "daily-use-research",
      testMatch: /daily-use-research\.spec\.ts/u,
      retries: 0,
      timeout: 900_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "retained-journey",
      testMatch: /retained-journey\.spec\.ts/u,
      retries: 0,
      // Attempt 12 measured ~40 min for research + Linear alone on the cheap
      // reasoning model before its 60-minute ceiling; the full six-stage chain
      // needs roughly double that.
      timeout: 7_200_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "byok-autonomous-journey",
      testMatch: /byok-autonomous-journey\.spec\.ts/u,
      retries: 0,
      timeout: 9_000_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "desktop-checkers-delivery-real-live",
      testMatch: /desktop-checkers-delivery-real-live\.spec\.ts/u,
      retries: 0,
      timeout: 2_700_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "desktop-code-delivery-real-live",
      testMatch: /desktop-code-delivery-real-live\.spec\.ts/u,
      retries: 0,
      timeout: 2_700_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "vault-sibling-code-delivery-real-live",
      testMatch: /vault-sibling-code-delivery-real-live\.spec\.ts/u,
      retries: 0,
      timeout: 2_700_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      // Demo footage driver, not a proof lane — see e2e/demo-recording.spec.ts.
      name: "demo-recording",
      testMatch: /demo-recording\.spec\.ts/u,
      retries: 0,
      timeout: 2_700_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      // Researcher footage driver — see e2e/demo-journey-recording.spec.ts.
      name: "demo-journey-recording",
      testMatch: /demo-journey-recording\.spec\.ts/u,
      retries: 0,
      timeout: 7_200_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "daily-use-code-live",
      testMatch: /daily-use-code-live\.spec\.ts/u,
      retries: 0,
      timeout: 2_700_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
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
      name: "release-vertical",
      testMatch: /daily-use-compound\.spec\.ts/u,
      retries: 0,
      timeout: 3_600_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "obsidian-hello-github-live",
      testMatch: /obsidian-hello-github-live\.spec\.ts/u,
      retries: 0,
      timeout: 3_600_000,
      expect: { timeout: 180_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "compound-flow-real-live",
      testMatch: /compound-flow-real-live\.spec\.ts/u,
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
      name: "disposable-live-external",
      testMatch: /disposable-live-external\.spec\.ts/u,
      retries: 0,
      timeout: 600_000,
      expect: { timeout: 30_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "linear-flow-real-cleanup",
      testMatch: /linear-flow-real-cleanup\.spec\.ts/u,
      retries: 0,
      timeout: 900_000,
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
    {
      name: "configured-github-visibility-live",
      testMatch: /configured-github-visibility-live\.spec\.ts/u,
      retries: 0,
      timeout: 600_000,
      expect: { timeout: 30_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "github-askpass-runtime-live",
      testMatch: /github-askpass-runtime-live\.spec\.ts/u,
      retries: 0,
      timeout: 600_000,
      expect: { timeout: 30_000 },
      use: { trace: "off", screenshot: "off", video: "off" },
    },
  ],
});
