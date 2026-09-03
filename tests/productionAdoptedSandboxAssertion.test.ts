import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Page } from "@playwright/test";

import { assertProductionAdoptedSandboxV1 } from "../e2e/fixtures/realAiHarness";
import { sandboxProbeProvenInSessionV1 } from "../e2e/fixtures/sandboxProbeSessionFreshness";

/**
 * `assertProductionAdoptedSandboxV1` is the gate every live code lane passes
 * through, and it runs entirely inside `page.evaluate`. Driving it with a fake
 * page and a fake Code capability proves the gate itself without Obsidian, a
 * real renderer, or the real sandbox — the exact combination that made a
 * permanently unsatisfiable freshness bound look like a sandbox failure.
 * That bound is a `harness:*` pin: the product proves once per load and does
 * not restamp `observedAt` when it serves that proof.
 */

const SESSION_STARTED_AT = Date.parse("2026-08-23T09:00:00.000Z");

function verifiedStatus() {
  return {
    version: 1,
    mode: "sandbox_verified",
    executionAvailable: true,
    editingAvailable: true,
    selectedProvider: "wsl2",
    providers: [
      {
        provider: "wsl2",
        state: "verified",
        diagnostic: "Boundary probe verified.",
        probeFingerprint: `sha256:${"a".repeat(64)}`,
        checkedAt: new Date(SESSION_STARTED_AT).toISOString(),
      },
    ],
    blocker: null,
  };
}

/**
 * A page whose evaluate runs the production callback against a fake renderer.
 * The globals are the only stand-ins; the callback under test is the real one.
 */
function fakeRendererPage(input: {
  observedAt: string | null;
  sessionStartedAtMs: number;
  onReadiness?: () => void;
}): Page {
  const code = {
    async ensureHostProvisionedSandboxReadinessV1() {
      input.onReadiness?.();
      return verifiedStatus();
    },
    readState() {
      return {
        sandbox: {
          providerConfigs: [{ kind: "wsl2" }],
          lastProbe:
            input.observedAt === null
              ? null
              : { version: 1, observedAt: input.observedAt, status: verifiedStatus() },
        },
      };
    },
  };
  const window = {
    app: {
      plugins: {
        plugins: {
          "agentic-researcher": {
            getBundledCapability: (id: string) =>
              id === "agentic-researcher-code" ? code : null,
          },
        },
      },
    },
  };
  return {
    async evaluate(pageFunction: any, arg: unknown) {
      const globals = globalThis as Record<string, unknown>;
      const priorWindow = Object.getOwnPropertyDescriptor(globals, "window");
      const priorPerformance = Object.getOwnPropertyDescriptor(
        globals,
        "performance",
      );
      Object.defineProperty(globals, "window", {
        value: window,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globals, "performance", {
        value: { timeOrigin: input.sessionStartedAtMs },
        configurable: true,
        writable: true,
      });
      try {
        return await pageFunction(arg);
      } finally {
        if (priorWindow) Object.defineProperty(globals, "window", priorWindow);
        else delete globals.window;
        if (priorPerformance) {
          Object.defineProperty(globals, "performance", priorPerformance);
        } else delete globals.performance;
      }
    },
  } as unknown as Page;
}

test("assertProductionAdoptedSandboxV1 accepts the probe the plugin proved at load", async () => {
  // The product proves the boundary once, off the plugin-load critical path,
  // and `startRealAiHarness` only returns well after that. Every lane instant
  // is therefore later than observedAt; only the session origin is earlier.
  let readinessCalls = 0;
  const page = fakeRendererPage({
    observedAt: new Date(SESSION_STARTED_AT + 4_000).toISOString(),
    sessionStartedAtMs: SESSION_STARTED_AT,
    onReadiness: () => {
      readinessCalls += 1;
    },
  });
  const adopted = await assertProductionAdoptedSandboxV1(page);
  assert.equal(readinessCalls, 1);
  assert.equal(adopted.selectedProvider, "wsl2");
  assert.equal(adopted.providerConfigCount, 1);
  assert.equal(adopted.observedAt, new Date(SESSION_STARTED_AT + 4_000).toISOString());
});

test("assertProductionAdoptedSandboxV1 rejects a probe replayed from durable history", async () => {
  // The vault's data.json survives between runs — the native harness restores
  // the pre-run bytes on close — so a plugin that stopped re-proving a stale
  // durable observation would serve one stamped before this session began.
  const page = fakeRendererPage({
    observedAt: new Date(SESSION_STARTED_AT - 4 * 24 * 60 * 60_000).toISOString(),
    sessionStartedAtMs: SESSION_STARTED_AT,
  });
  await assert.rejects(
    () => assertProductionAdoptedSandboxV1(page),
    /proven inside this Obsidian session/u,
  );
});

test("assertProductionAdoptedSandboxV1 rejects a capability that never recorded a probe", async () => {
  const page = fakeRendererPage({
    observedAt: null,
    sessionStartedAtMs: SESSION_STARTED_AT,
  });
  await assert.rejects(
    () => assertProductionAdoptedSandboxV1(page),
    /proven inside this Obsidian session/u,
  );
});

test("live code lanes do not pass a post-startup freshness instant", () => {
  // harness:* — assertProductionAdoptedSandboxV1 used to take notBeforeMs.
  // hello-github (and every other live code lane) passed Date.now() after
  // startRealAiHarness, which is always later than the load-time probe the
  // product actually runs. The gate now has one argument.
  for (const lane of [
    "obsidian-hello-github-live",
    "byok-autonomous-journey",
    "desktop-checkers-delivery-real-live",
    "desktop-code-delivery-real-live",
    "vault-sibling-code-delivery-real-live",
    "daily-use-code-live",
    "daily-use-compound",
    "compound-flow-real-live",
  ]) {
    const spec = readFileSync(
      new URL(`../e2e/${lane}.spec.ts`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      spec,
      /assertProductionAdoptedSandboxV1\(\s*[^,)]+\s*,/u,
      `${lane} still passes a caller-supplied freshness instant`,
    );
  }
  const harness = readFileSync(
    new URL("../e2e/fixtures/realAiHarness.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(harness, /notBeforeMs/u);
  assert.match(harness, /sandboxProbeProvenInSessionV1/u);
  assert.match(harness, /harness:\*/u);
});

test("sandboxProbeProvenInSessionV1 bounds on the session origin, never on a later instant", () => {
  const loadTimeProbe = new Date(SESSION_STARTED_AT + 4_000).toISOString();
  assert.equal(
    sandboxProbeProvenInSessionV1({
      observedAt: loadTimeProbe,
      sessionStartedAtMs: SESSION_STARTED_AT,
    }),
    true,
  );
  // The bound a lane would have supplied by calling Date.now() after startup:
  // satisfying it needs a second physical probe the product never runs.
  assert.equal(
    sandboxProbeProvenInSessionV1({
      observedAt: loadTimeProbe,
      sessionStartedAtMs: SESSION_STARTED_AT + 30_000,
    }),
    false,
  );
  assert.equal(
    sandboxProbeProvenInSessionV1({
      observedAt: "not-a-timestamp",
      sessionStartedAtMs: SESSION_STARTED_AT,
    }),
    false,
  );
  assert.equal(
    sandboxProbeProvenInSessionV1({
      observedAt: loadTimeProbe,
      sessionStartedAtMs: Number.NaN,
    }),
    false,
  );
});
