import assert from "node:assert/strict";
import test from "node:test";

import {
  liveInfrastructureAction,
  liveProviderConfiguration,
  resolveSandboxBoundaryCiMode,
} from "../scripts/ci-sandbox-boundary";

const DIGEST = `sha256:${"a".repeat(64)}`;

test("sandbox CI defaults to deterministic mode and live execution is exact opt-in", () => {
  assert.equal(resolveSandboxBoundaryCiMode({}), "deterministic");
  assert.equal(
    resolveSandboxBoundaryCiMode({ AGENTIC_SANDBOX_CI_LIVE: "0" }),
    "deterministic",
  );
  assert.equal(
    resolveSandboxBoundaryCiMode({ AGENTIC_SANDBOX_CI_LIVE: "1" }),
    "live",
  );
  assert.throws(
    () => resolveSandboxBoundaryCiMode({ AGENTIC_SANDBOX_CI_LIVE: "true" }),
    /must be exactly 0 or 1/u,
  );
});

test("live sandbox CI requires explicit provider runtime configuration", () => {
  assert.deepEqual(
    liveProviderConfiguration("wsl2", {
      AGENTIC_SANDBOX_CI_EXECUTABLE: "wsl.exe",
      AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE: "agentic-runtime",
      AGENTIC_SANDBOX_CI_RUNTIME_DIGEST: DIGEST,
      AGENTIC_SANDBOX_CI_WSL_DISTRIBUTION: "AgenticResearcherSandbox",
      AGENTIC_SANDBOX_CI_RUNTIME_ROOT: "/opt/agentic/runtime",
    }),
    {
      version: 1,
      kind: "wsl2",
      executable: "wsl.exe",
      priority: 1,
      runtimeReference: "agentic-runtime",
      runtimeDigest: DIGEST,
      wslDistribution: "AgenticResearcherSandbox",
      runtimeRoot: "/opt/agentic/runtime",
    },
  );
  assert.deepEqual(
    liveProviderConfiguration("podman", {
      AGENTIC_SANDBOX_CI_EXECUTABLE: "podman",
      AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE: "registry.example/agentic/runtime",
      AGENTIC_SANDBOX_CI_RUNTIME_DIGEST: DIGEST,
    }),
    {
      version: 1,
      kind: "podman",
      executable: "podman",
      priority: 1,
      runtimeReference: "registry.example/agentic/runtime",
      runtimeDigest: DIGEST,
      wslDistribution: null,
      runtimeRoot: null,
    },
  );
  assert.deepEqual(
    liveProviderConfiguration("bubblewrap", {
      AGENTIC_SANDBOX_CI_EXECUTABLE: "bwrap",
      AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE: "agentic-runtime",
      AGENTIC_SANDBOX_CI_RUNTIME_DIGEST: DIGEST,
      AGENTIC_SANDBOX_CI_RUNTIME_ROOT: "/opt/agentic/runtime",
    }),
    {
      version: 1,
      kind: "bubblewrap",
      executable: "bwrap",
      priority: 1,
      runtimeReference: "agentic-runtime",
      runtimeDigest: DIGEST,
      wslDistribution: null,
      runtimeRoot: "/opt/agentic/runtime",
    },
  );
});

test("missing live infrastructure fails with the exact remediation action", () => {
  assert.throws(
    () =>
      liveProviderConfiguration("podman", {
        AGENTIC_SANDBOX_CI_EXECUTABLE: "podman",
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.startsWith("LIVE_SANDBOX_INFRASTRUCTURE_REQUIRED:") &&
      error.message.includes("install and start Podman") &&
      error.message.includes("AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE"),
  );
  assert.match(
    liveInfrastructureAction("bubblewrap"),
    /install bubblewrap.*user namespaces.*read-only runtime root/iu,
  );
});
