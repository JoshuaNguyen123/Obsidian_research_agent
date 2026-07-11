import assert from "node:assert/strict";
import test from "node:test";
import { ScopedToolRegistry } from "../src/tools/ScopedToolRegistry";
import type { ToolDescriptor } from "../src/agent/actions";
import type { ToolRegistry } from "../src/tools/types";

const readDescriptor: ToolDescriptor = {
  version: 1,
  name: "safe_read",
  capability: { system: "vault", resourceType: "note", action: "read" },
  effect: "read",
  risk: "low",
  approval: { allowPromptGrant: true, allowPersistentGrant: true, fallback: "none" },
  execution: { preparation: "optional", cacheable: false, parallelSafe: true },
  durability: { journal: false, receipt: false, readback: "none", reconciliation: "none" },
  allowedPrincipals: ["researcher"],
};

const writeDescriptor: ToolDescriptor = {
  ...readDescriptor,
  name: "unsafe_write",
  capability: { system: "vault", resourceType: "note", action: "replace" },
  effect: "reversible_mutation",
};

test("ScopedToolRegistry hides and re-blocks tools outside the host role scope", async () => {
  const calls: string[] = [];
  const base: ToolRegistry = {
    getDefinitions: () => [readDescriptor, writeDescriptor].map((descriptor) => ({
      type: "function" as const,
      function: {
        name: descriptor.name,
        description: descriptor.name,
        parameters: { type: "object" as const, properties: {} },
      },
    })),
    getDescriptor: (name) =>
      name === readDescriptor.name
        ? readDescriptor
        : name === writeDescriptor.name
          ? writeDescriptor
          : null,
    execute: async (call) => {
      calls.push(call.name);
      return { ok: true, toolName: call.name, output: "ok" };
    },
  };
  const scoped = new ScopedToolRegistry(
    base,
    (_name, descriptor) => descriptor?.effect === "read",
  );

  assert.deepEqual(
    scoped.getDefinitions().map((definition) => definition.function.name),
    ["safe_read"],
  );
  assert.equal(scoped.getDescriptor("unsafe_write"), null);
  assert.equal(
    (await scoped.execute(
      { id: "call-1", name: "unsafe_write", arguments: {} },
      {} as never,
    )).error?.code,
    "tool_outside_role_scope",
  );
  assert.deepEqual(calls, []);
  assert.equal(
    (await scoped.execute(
      { id: "call-2", name: "safe_read", arguments: {} },
      {} as never,
    )).ok,
    true,
  );
  assert.deepEqual(calls, ["safe_read"]);
});
