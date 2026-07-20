import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSettings } from "../src/settings";
import type { ModelThink } from "../src/model/types";
import {
  coerceThinkForModel,
  resolveThinkForCall,
  resolveThinkProfile,
  resolveThinkingMode,
} from "../src/agent/thinkPolicy";

function settings(
  partial: Partial<AgentSettings> & { model: string },
): AgentSettings {
  return {
    thinkingMode: "auto",
    ...partial,
    model: partial.model,
  } as AgentSettings;
}

function assertNeverBoolean(value: ModelThink | undefined): void {
  if (value !== undefined) {
    assert.notEqual(typeof value, "boolean");
  }
}

describe("coerceThinkForModel matrix", () => {
  it("gpt-oss never returns boolean and maps effort levels", () => {
    const model = "gpt-oss:120b-cloud";
    assert.equal(resolveThinkProfile(model), "gpt_oss_levels");

    for (const desired of [true, "low", "medium", "high", "max"] as const) {
      const coerced = coerceThinkForModel(model, desired);
      assertNeverBoolean(coerced);
    }

    assert.equal(coerceThinkForModel(model, true), "medium");
    assert.equal(coerceThinkForModel(model, "max"), "high");
    assert.equal(coerceThinkForModel(model, "off"), "low");
    assert.equal(coerceThinkForModel(model, false), "low");
    assert.equal(coerceThinkForModel(model, undefined), undefined);
  });

  it("deepseek-v4-pro preserves max when desired max", () => {
    const model = "deepseek-v4-pro:671b";
    assert.equal(resolveThinkProfile(model), "deepseek_v4_modes");
    assert.equal(coerceThinkForModel(model, "max"), "max");
    assert.equal(coerceThinkForModel(model, "high"), "high");
    assert.equal(coerceThinkForModel(model, true), true);
    assert.equal(coerceThinkForModel(model, "off"), false);
  });

  it("qwen3.6 accepts bool or level passthrough", () => {
    const model = "qwen3.6:32b";
    assert.equal(resolveThinkProfile(model), "bool_or_levels");
    assert.equal(coerceThinkForModel(model, true), true);
    assert.equal(coerceThinkForModel(model, "low"), "low");
    assert.equal(coerceThinkForModel(model, "max"), "max");
    assert.equal(coerceThinkForModel(model, "off"), false);
  });

  it("gemma4 accepts bool or level passthrough", () => {
    const model = "gemma4:27b";
    assert.equal(resolveThinkProfile(model), "bool_or_levels");
    assert.equal(coerceThinkForModel(model, true), true);
    assert.equal(coerceThinkForModel(model, "medium"), "medium");
    assert.equal(coerceThinkForModel(model, false), false);
  });

  it("kimi-k2.6 accepts bool or level passthrough", () => {
    const model = "kimi-k2.6:cloud";
    assert.equal(resolveThinkProfile(model), "bool_or_levels");
    assert.equal(coerceThinkForModel(model, true), true);
    assert.equal(coerceThinkForModel(model, "high"), "high");
  });

  it("unknown models omit off/false and pass explicit levels", () => {
    const model = "llama3.1:8b";
    assert.equal(resolveThinkProfile(model), "unknown");
    assert.equal(coerceThinkForModel(model, undefined), undefined);
    assert.equal(coerceThinkForModel(model, "off"), undefined);
    assert.equal(coerceThinkForModel(model, false), undefined);
    assert.equal(coerceThinkForModel(model, "high"), "high");
  });
});

describe("resolveThinkingMode", () => {
  it("auto defaults by model family", () => {
    assert.equal(
      resolveThinkingMode(settings({ model: "gpt-oss:120b" })),
      "medium",
    );
    assert.equal(
      resolveThinkingMode(settings({ model: "deepseek-v4-pro:671b" })),
      "high",
    );
    assert.equal(
      resolveThinkingMode(settings({ model: "qwen3.6:32b" })),
      true,
    );
    assert.equal(
      resolveThinkingMode(settings({ model: "llama3.1:8b" })),
      undefined,
    );
  });

  it("respects explicit settings and off", () => {
    assert.equal(
      resolveThinkingMode(
        settings({ model: "gpt-oss:120b", thinkingMode: "high" }),
      ),
      "high",
    );
    assert.equal(
      resolveThinkingMode(
        settings({ model: "gpt-oss:120b", thinkingMode: "off" }),
      ),
      "low",
    );
    assert.equal(
      resolveThinkingMode(
        settings({ model: "deepseek-v4-pro:671b", thinkingMode: "max" }),
      ),
      "max",
    );
  });
});

describe("resolveThinkForCall", () => {
  it("writeback desired off coerces gpt-oss to low", () => {
    const think = resolveThinkForCall({
      role: "lead",
      phase: "streaming",
      route: "direct_writeback",
      model: "gpt-oss:120b",
      settings: settings({ model: "gpt-oss:120b", thinkingMode: "max" }),
    });
    assert.equal(think, "low");
    assertNeverBoolean(think);
  });

  it("deepseek-v4 lead on long research can resolve max when settings allow", () => {
    const think = resolveThinkForCall({
      role: "lead",
      route: "grounded_workflow",
      expectedTimeClass: "long",
      model: "deepseek-v4-pro:671b",
      settings: settings({ model: "deepseek-v4-pro:671b", thinkingMode: "max" }),
    });
    assert.equal(think, "max");
  });

  it("router and planner calls stay off", () => {
    assert.equal(
      resolveThinkForCall({
        role: "lead",
        phase: "router",
        model: "qwen3.6:32b",
        settings: settings({ model: "qwen3.6:32b", thinkingMode: "high" }),
      }),
      false,
    );
    assert.equal(
      resolveThinkForCall({
        role: "lead",
        phase: "graph_planner",
        model: "qwen3.6:32b",
        settings: settings({ model: "qwen3.6:32b", thinkingMode: "high" }),
      }),
      false,
    );
  });
});
