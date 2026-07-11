import test from "node:test";
import assert from "node:assert/strict";
import { createDesignTools } from "../src/tools/designTools";
import { hasReviseDesignIntent } from "../src/agent/codeDesignIntent";

test("design tools include update_design_canvas", () => {
  const names = createDesignTools().map((tool) => tool.name);
  assert.ok(names.includes("create_design_canvas"));
  assert.ok(names.includes("update_design_canvas"));
});

test("update_design_canvas requires revise intent", async () => {
  const tool = createDesignTools().find((item) => item.name === "update_design_canvas");
  assert.ok(tool);
  await assert.rejects(
    () =>
      tool!.execute(
        { path: "Designs/demo.canvas" },
        {
          app: {} as never,
          settings: {} as never,
          originalPrompt: "create a canvas diagram",
          httpTransport: async () => ({
            status: 200,
            headers: {},
            text: "",
          }),
        },
      ),
    /revise|update|edit/i,
  );
  assert.equal(hasReviseDesignIntent("revise the canvas layout"), true);
});
