import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRealAiLaneNonMock,
  RealAiConnectionAttestationRegistry,
  verifyWithWorkerConnectionAttestation,
  type RealAiConnectionTarget,
} from "../e2e/fixtures/realAiConnectionAttestation";

const TARGET: RealAiConnectionTarget = {
  provider: "ollama",
  baseUrl: "https://ollama.com/api",
  model: "glm-5.2",
};

test("worker connection attestation requires one fresh proof before exact reuse", async () => {
  const registry = new RealAiConnectionAttestationRegistry();
  const modes: boolean[] = [];
  const run = () =>
    verifyWithWorkerConnectionAttestation({
      registry,
      target: TARGET,
      verify: async ({ reuseWorkerAttestation }) => {
        modes.push(reuseWorkerAttestation);
        return { ready: true };
      },
      validate: (state) => assert.equal(state.ready, true),
    });

  await run();
  await run();
  assert.deepEqual(modes, [false, true]);
});

test("provider, base URL, and model changes each require a fresh proof", async () => {
  const registry = new RealAiConnectionAttestationRegistry();
  const targets: RealAiConnectionTarget[] = [
    TARGET,
    { ...TARGET, provider: "openai_compatible" },
    { ...TARGET, baseUrl: "https://example.invalid/v1" },
    { ...TARGET, model: "kimi-k2.6" },
  ];

  for (const target of targets) {
    let reused = true;
    await verifyWithWorkerConnectionAttestation({
      registry,
      target,
      verify: async (input) => {
        reused = input.reuseWorkerAttestation;
        return null;
      },
      validate: () => undefined,
    });
    assert.equal(reused, false);
  }
});

test("Tier A real-AI attestation fails closed on mock model or non-production transport", () => {
  assert.throws(
    () => assertRealAiLaneNonMock({ mockInstalled: true }),
    /mock model is still installed/u,
  );
  assert.throws(
    () => assertRealAiLaneNonMock({ viewMocks: [false, true] }),
    /AgentView still has the Playwright mock/u,
  );
  assert.throws(
    () =>
      assertRealAiLaneNonMock({
        mockInstalled: false,
        descriptorTransportKind: "mock",
      }),
    /transport is mock/u,
  );
  assert.throws(
    () =>
      assertRealAiLaneNonMock({
        mockInstalled: false,
        descriptorTransportKind: "production",
        settingsModel: "playwright-e2e-mock",
        expectedModel: "glm-5.2",
      }),
    /does not match expected/u,
  );
  assert.doesNotThrow(() =>
    assertRealAiLaneNonMock({
      mockInstalled: false,
      viewMocks: [false],
      descriptorTransportKind: "production",
      settingsModel: "glm-5.2",
      expectedModel: "glm-5.2",
    }),
  );
});

test("failed transport or validation never populates the worker cache", async () => {
  for (const failure of ["transport", "validation"] as const) {
    const registry = new RealAiConnectionAttestationRegistry();
    await assert.rejects(
      verifyWithWorkerConnectionAttestation({
        registry,
        target: TARGET,
        verify: async () => {
          if (failure === "transport") throw new Error("transport failed");
          return { ready: false };
        },
        validate: () => {
          if (failure === "validation") throw new Error("validation failed");
        },
      }),
      new RegExp(`${failure} failed`, "u"),
    );

    let reused = true;
    await verifyWithWorkerConnectionAttestation({
      registry,
      target: TARGET,
      verify: async (input) => {
        reused = input.reuseWorkerAttestation;
        return { ready: true };
      },
      validate: () => undefined,
    });
    assert.equal(reused, false);
  }
});

test("connection attestation times out before a stalled provider can consume a mission test", async () => {
  const registry = new RealAiConnectionAttestationRegistry();
  await assert.rejects(
    verifyWithWorkerConnectionAttestation({
      registry,
      target: TARGET,
      timeoutMs: 20,
      verify: async () => new Promise<never>(() => undefined),
      validate: () => undefined,
    }),
    /connection attestation timed out after 20 ms/iu,
  );
  assert.equal(registry.has(TARGET), false);
});
