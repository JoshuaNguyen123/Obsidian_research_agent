import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionContributionV1,
  ExtensionManifestV1,
  ScopedExtensionContextV1,
} from "../packages/core-api/src";
import { CoreApiHost } from "../src/extensions/CoreApiHost";
import {
  readExtensionRuntimeProjection,
} from "../src/extensions/extensionHealthProjection";

test("health projection invokes token-guarded handlers with only scoped context", async () => {
  const observed: ScopedExtensionContextV1[] = [];
  const host = readyHost();
  host.registerExtension(request([
    statusContribution("status", async (context) => {
      observed.push(context);
      return {
        status: "healthy",
        summary: "Ready.\nNo secrets exposed.",
        details: { mode: "fixture" },
        checkedAt: "2026-07-11T12:00:00.000Z",
      };
    }),
    settingsContribution(),
  ]));

  const result = await readExtensionRuntimeProjection({
    snapshot: host.createMissionSnapshot("extension-health-1"),
    revision: 1,
    timeoutMs: 100,
    now: () => new Date("2026-07-11T12:00:01.000Z"),
  });

  assert.ok(result);
  assert.equal(result.health[0].status, "healthy");
  assert.equal(result.health[0].summary, "Ready. No secrets exposed.");
  assert.deepEqual(result.health[0].details, { mode: "fixture" });
  assert.equal(observed.length, 1);
  assert.deepEqual(Object.keys(observed[0]).sort(), [
    "abortSignal",
    "deadlineAt",
    "extensionId",
    "missionId",
    "now",
    "operationId",
    "reportProgress",
    "version",
  ]);
  assert.equal(observed[0].extensionId, "fixture-extension");
  assert.equal(observed[0].operationId, "status");
  assert.equal("app" in observed[0], false);
  assert.equal("settings" in observed[0], false);
  assert.equal("model" in observed[0], false);
  assert.equal("secrets" in observed[0], false);
  assert.equal(result.settings[0].title, "Fixture settings");
  assert.equal(result.settings[0].fields[0].defaultValue, false);
});

test("timeout and handler failure become visible without rejecting core projection", async () => {
  const host = readyHost();
  host.registerExtension(request([
    statusContribution("hang", async (context) => {
      await new Promise<void>((resolve) => {
        context.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        status: "healthy",
        summary: "late",
        checkedAt: new Date().toISOString(),
      };
    }),
    statusContribution("throws", async () => {
      throw new Error("secret-like handler text must not reach the projection");
    }),
  ]));

  const result = await readExtensionRuntimeProjection({
    snapshot: host.createMissionSnapshot("extension-health-2"),
    revision: 2,
    timeoutMs: 10,
    now: () => new Date("2026-07-11T12:00:02.000Z"),
  });

  assert.ok(result);
  assert.equal(result.health[0].status, "degraded");
  assert.equal(result.health[0].failureCode, "timeout");
  assert.match(result.health[0].summary, /timed out after 10ms/u);
  assert.equal(result.health[1].status, "blocked");
  assert.equal(result.health[1].failureCode, "handler_failed");
  assert.doesNotMatch(result.health[1].summary, /secret-like/u);
});

test("superseded or aborted health generations are discarded", async () => {
  const host = readyHost();
  host.registerExtension(request([
    statusContribution("status", async () => ({
      status: "healthy",
      summary: "Ready.",
      checkedAt: "2026-07-11T12:00:00.000Z",
    })),
  ]));
  let current = false;
  const stale = await readExtensionRuntimeProjection({
    snapshot: host.createMissionSnapshot("extension-health-stale"),
    revision: 3,
    timeoutMs: 100,
    isCurrent: () => current,
  });
  assert.equal(stale, null);

  const controller = new AbortController();
  controller.abort("superseded");
  const aborted = await readExtensionRuntimeProjection({
    snapshot: host.createMissionSnapshot("extension-health-aborted"),
    revision: 4,
    timeoutMs: 100,
    signal: controller.signal,
  });
  assert.equal(aborted, null);
});

function readyHost(): CoreApiHost {
  const host = new CoreApiHost({ now: () => new Date("2026-07-11T12:00:00.000Z") });
  host.markReady();
  return host;
}

function request(contributions: ExtensionContributionV1[]) {
  const manifest: ExtensionManifestV1 = {
    id: "fixture-extension",
    displayName: "Fixture Extension",
    version: "1.0.0",
    apiMajor: 1,
    apiMinor: 0,
  };
  return { manifest, contributions };
}

function statusContribution(
  id: string,
  readStatus: (
    context: ScopedExtensionContextV1,
  ) => Promise<{
    status: "healthy" | "degraded" | "blocked" | "disabled";
    summary: string;
    checkedAt: string;
    details?: Record<string, string>;
  }>,
): ExtensionContributionV1 {
  return {
    descriptor: {
      version: 1,
      kind: "status",
      id,
      displayName: id,
    },
    readStatus,
  };
}

function settingsContribution(): ExtensionContributionV1 {
  return {
    descriptor: {
      version: 1,
      kind: "settings",
      id: "settings",
      displayName: "Fixture settings",
    },
    section: {
      id: "fixture",
      title: "Fixture settings",
      fields: [
        {
          id: "enabled",
          type: "boolean",
          label: "Enabled",
          description: "Read-only fixture metadata.",
          defaultValue: false,
        },
      ],
    },
  };
}
