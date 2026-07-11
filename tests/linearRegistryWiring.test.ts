import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";

test("default registry injects only gate-bounded fixed Linear tools when host configured", () => {
  const withoutLinear = createDefaultToolRegistry();
  assert.equal(
    withoutLinear.getDefinitions().some((tool) =>
      tool.function.name.startsWith("linear_"),
    ),
    false,
  );

  const withGateOne = createDefaultToolRegistry({
    linear: {
      gate: 1,
      client: {
        execute: async () => {
          throw new Error("not executed");
        },
      },
    },
  });
  const names = new Set(
    withGateOne.getDefinitions().map((tool) => tool.function.name),
  );
  assert.equal(names.has("linear_get_issue"), true);
  assert.equal(names.has("linear_create_issue"), true);
  assert.equal(names.has("linear_create_project"), false);
  assert.equal(
    withGateOne.getDescriptor?.("linear_create_issue")?.execution.preparation,
    "required",
  );
});
