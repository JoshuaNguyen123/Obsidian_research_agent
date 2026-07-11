import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import { descriptorFor } from "../src/tools/toolDescriptors";

test("every default tool has an explicit descriptor", () => {
  const registry = createDefaultToolRegistry();
  for (const definition of registry.getDefinitions()) {
    const name = definition.function.name;
    const descriptor = registry.getDescriptor?.(name);
    assert.ok(descriptor, `missing descriptor for ${name}`);
    assert.equal(descriptor.name, name);
  }
});

test("destructive vault tools require prepared execution", () => {
  for (const name of ["replace_current_file", "replace_file"] as const) {
    assert.equal(descriptorFor(name).execution.preparation, "required");
    assert.equal(descriptorFor(name).approval.fallback, "exact");
  }
  for (const name of [
    "delete_current_file",
    "delete_path",
    "delete_research_memory_entry",
  ] as const) {
    assert.equal(descriptorFor(name).execution.preparation, "required");
    assert.equal(descriptorFor(name).approval.fallback, "double_exact");
  }
});

test("unknown legacy tools fail closed during descriptor construction", () => {
  assert.throws(() => descriptorFor("linear_magic_graphql"), /Missing explicit/);
});

