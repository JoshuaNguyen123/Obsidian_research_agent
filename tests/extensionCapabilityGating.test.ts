import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";

test("optional extension registration gates compatibility tool catalogs", () => {
  const coreOnly = names({ code: false, integrations: false, companion: false });
  assert.ok(coreOnly.has("read_current_file"));
  assert.ok(coreOnly.has("create_design_canvas"));
  assert.equal(coreOnly.has("run_code_block"), false);
  assert.equal(coreOnly.has("write_workspace_file"), false);
  assert.equal(coreOnly.has("browser_open_page"), false);

  const withCode = names({ code: true, integrations: false, companion: false });
  assert.ok(withCode.has("run_code_block"));
  assert.ok(withCode.has("write_workspace_file"));
  assert.equal(withCode.has("browser_open_page"), false);

  const withCompanion = names({
    code: false,
    integrations: false,
    companion: true,
  });
  assert.ok(withCompanion.has("browser_open_page"));
  assert.equal(withCompanion.has("run_code_block"), false);
});

test("an owner-authorized extension tool replaces its compatibility implementation", () => {
  const replacement = {
    name: "run_code_block",
    description: "extension replacement",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { source: "extension" };
    },
  };
  const registry = createDefaultToolRegistry({
    optionalCapabilities: {
      code: true,
      integrations: false,
      companion: false,
    },
    extensionTools: [replacement],
  });
  const matching = registry
    .getDefinitions()
    .filter((definition) => definition.function.name === "run_code_block");
  assert.equal(matching.length, 1);
  assert.equal(matching[0].function.description, "extension replacement");
});

test("production can retire the code compatibility bridge without a native fallback", () => {
  const registry = createDefaultToolRegistry({
    optionalCapabilities: {
      code: true,
      integrations: false,
      companion: false,
    },
    legacyCompatibility: { code: false },
    extensionTools: [
      {
        name: "code_sandbox_status",
        description: "extension sandbox boundary",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { executionAvailable: false, nativeFallback: false };
        },
      },
    ],
  });
  const toolNames = new Set(
    registry.getDefinitions().map((definition) => definition.function.name),
  );
  assert.ok(toolNames.has("code_sandbox_status"));
  assert.equal(toolNames.has("run_code_block"), false);
  assert.equal(toolNames.has("write_workspace_file"), false);
  assert.equal(toolNames.has("install_code_dependency"), false);
});

test("captured compatibility tools fail closed after live extension revocation", async () => {
  let codeAvailable = true;
  const registry = createDefaultToolRegistry({
    optionalCapabilities: {
      code: true,
      integrations: false,
      companion: false,
    },
    isOptionalCapabilityAvailable(capability) {
      return capability !== "code" || codeAvailable;
    },
  });
  assert.ok(
    registry
      .getDefinitions()
      .some((definition) => definition.function.name === "run_code_block"),
  );

  codeAvailable = false;
  const result = await registry.execute(
    { name: "run_code_block", arguments: {} },
    {} as never,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "extension_unavailable");
  assert.equal(result.mutationState, "not_applied");
});

function names(capabilities: {
  code: boolean;
  integrations: boolean;
  companion: boolean;
}): Set<string> {
  return new Set(
    createDefaultToolRegistry({ optionalCapabilities: capabilities })
      .getDefinitions()
      .map((definition) => definition.function.name),
  );
}
