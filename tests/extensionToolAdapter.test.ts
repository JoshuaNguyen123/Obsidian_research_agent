import test from "node:test";
import assert from "node:assert/strict";
import type {
  ExtensionToolContributionV1,
  ScopedExtensionContextV1,
  ToolDescriptorV1,
} from "../packages/core-api/src";
import { CoreApiHost } from "../src/extensions/CoreApiHost";
import { adaptExtensionToolContribution } from "../src/extensions/extensionToolAdapter";
import { DefaultToolRegistry } from "../src/tools/ToolRegistry";
import type { ToolExecutionContext } from "../src/tools/types";

test("extension tool adapter exposes only the scoped execution context", async () => {
  const observed: Array<{ keys: string[]; context: ScopedExtensionContextV1 }> = [];
  const host = readyHost();
  host.registerExtension({
    manifest: manifest("agentic-researcher-code"),
    contributions: [
      toolContribution("extension_echo", async (args, context) => {
        observed.push({ keys: Object.keys(context).sort(), context });
        context.reportProgress("extension progress");
        return { echoed: args.value };
      }),
    ],
  });
  const snapshot = host.createMissionSnapshot("mission-adapter");
  const tool = adaptExtensionToolContribution(snapshot.tools[0], {
    isTokenActive: (token) => host.isTokenActive(token),
  });
  const registry = new DefaultToolRegistry([tool]);
  const progress: string[] = [];
  const context = toolContext({ reportProgress: (message) => progress.push(message) });
  const result = await registry.execute(
    { id: "call-1", name: "extension_echo", arguments: { value: "hello" } },
    context,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { echoed: "hello" });
  assert.deepEqual(progress, ["extension progress"]);
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].keys, [
    "abortSignal",
    "deadlineAt",
    "extensionId",
    "missionId",
    "now",
    "operationId",
    "originalPrompt",
    "reportProgress",
    "rootMissionId",
    "version",
  ]);
  for (const forbidden of [
    "app",
    "vault",
    "settings",
    "rawSettings",
    "modelClient",
    "secrets",
    "httpTransport",
  ]) {
    assert.equal(forbidden in observed[0].context, false, `${forbidden} must stay host-owned`);
  }
  assert.equal(observed[0].context.extensionId, "agentic-researcher-code");
  assert.equal(observed[0].context.missionId, "run-1");
  assert.equal(observed[0].context.rootMissionId, "root-run-1");
  assert.equal(observed[0].context.operationId, "operation-1");
  assert.equal(observed[0].context.originalPrompt, "Run the extension tool.");
  assert.equal(observed[0].context.deadlineAt, 2_000_000_000_000);
  assert.notEqual(observed[0].context, context);
});

test("stale extension tool wrapper fails closed with not_applied mutation state", async () => {
  let calls = 0;
  const host = readyHost();
  const token = host.registerExtension({
    manifest: manifest("agentic-researcher-code"),
    contributions: [
      toolContribution("extension_echo", async () => {
        calls += 1;
        return { ok: true };
      }),
    ],
  });
  const snapshot = host.createMissionSnapshot("mission-stale-adapter");
  const registry = new DefaultToolRegistry([
    adaptExtensionToolContribution(snapshot.tools[0], {
      isTokenActive: (candidate) => host.isTokenActive(candidate),
    }),
  ]);
  host.unregisterExtension(token);

  const result = await registry.execute(
    { id: "call-stale", name: "extension_echo", arguments: {} },
    toolContext(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "extension_unavailable");
  assert.equal(result.mutationState, "not_applied");
  assert.equal(calls, 0);
});

test("unregister aborts an in-flight scoped tool and discards its result", async () => {
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const host = readyHost();
  const token = host.registerExtension({
    manifest: manifest("agentic-researcher-code"),
    contributions: [
      toolContribution("extension_wait", async (_args, context) => {
        startedResolve();
        await new Promise<void>((resolve) => {
          if (context.abortSignal.aborted) {
            resolve();
            return;
          }
          context.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { shouldNotCommit: true };
      }),
    ],
  });
  const snapshot = host.createMissionSnapshot("mission-abort-adapter");
  const registry = new DefaultToolRegistry([
    adaptExtensionToolContribution(snapshot.tools[0], {
      isTokenActive: (candidate) => host.isTokenActive(candidate),
    }),
  ]);

  const pending = registry.execute(
    { id: "call-wait", name: "extension_wait", arguments: {} },
    toolContext(),
  );
  await started;
  host.unregisterExtension(token, "extension_disabled");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "extension_unavailable");
  assert.equal(result.mutationState, "not_applied");
  assert.equal(token.signal.aborted, true);
});

function readyHost(): CoreApiHost {
  const host = new CoreApiHost({
    now: () => new Date("2026-07-11T12:00:00.000Z"),
  });
  host.markReady();
  return host;
}

function manifest(id: string) {
  return {
    id,
    displayName: id,
    version: "0.1.0",
    apiMajor: 1,
    apiMinor: 0,
  };
}

function toolContribution(
  name: string,
  execute: ExtensionToolContributionV1["tool"]["execute"],
): ExtensionToolContributionV1 {
  return {
    descriptor: {
      version: 1,
      kind: "tool",
      id: name,
      displayName: name,
    },
    tool: {
      name,
      description: "Fixture extension tool.",
      parameters: { type: "object", additionalProperties: true },
      descriptor: descriptor(name),
      execute,
    },
  };
}

function descriptor(name: string): ToolDescriptorV1 {
  return {
    version: 1,
    name,
    capability: { system: "workspace", resourceType: "fixture", action: "read" },
    effect: "read",
    risk: "low",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "none",
    },
    execution: { preparation: "none", cacheable: true, parallelSafe: true },
    durability: {
      journal: false,
      receipt: false,
      readback: "none",
      reconciliation: "none",
    },
    allowedPrincipals: ["single_agent", "lead"],
  };
}

function toolContext(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    app: {} as never,
    settings: {} as never,
    originalPrompt: "Run the extension tool.",
    runId: "run-1",
    rootMissionId: "root-run-1",
    operationId: "operation-1",
    deadlineAt: 2_000_000_000_000,
    abortSignal: new AbortController().signal,
    httpTransport: async () => ({ status: 200, headers: {}, text: "" }),
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    ...overrides,
  };
}
