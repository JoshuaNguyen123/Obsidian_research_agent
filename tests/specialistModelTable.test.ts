import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  OLLAMA_CLOUD_CODE_WORKER_MODEL_V1,
  OLLAMA_CLOUD_DEEP_RESEARCH_MODEL_V1,
  SPECIALIST_MODEL_TABLE_V1,
  isDirectCloudTransportV1,
  resolveSpecialistModelV1,
  specialistModelRowV1,
} from "../src/orchestrator/specialistModelTableV1";
import type { SpecialistMode } from "../src/orchestrator/types";
import type { ModelClientDescriptor } from "../src/model/types";

/*
 * Two workers each held a private answer to "which model does this role run
 * on", and the two answers had already drifted into different shapes: the code
 * worker swapped unconditionally, the research worker only at deep effort.
 * Three of the five specialist modes had no answer at all. These tests pin the
 * table as the single place that decides, and — the part that actually
 * prevents the next drift — that a new specialist mode cannot be added without
 * a row.
 */

/**
 * `satisfies` makes this a compile-time census: adding a member to
 * `SpecialistMode` without listing it here fails the typecheck, which is the
 * only way to enumerate a TypeScript union at runtime.
 */
const ALL_SPECIALIST_MODES = {
  researcher: true,
  linear_planner: true,
  code_builder: true,
  code_reviewer: true,
  recovery_verifier: true,
} satisfies Record<SpecialistMode, true>;

const CLOUD: ModelClientDescriptor = {
  provider: "ollama",
  endpointCategory: "ollama_cloud",
} as ModelClientDescriptor;
const LOCAL: ModelClientDescriptor = {
  provider: "ollama",
  endpointCategory: "ollama_local",
} as ModelClientDescriptor;

test("every specialist mode has exactly one row, with a stated reason", () => {
  const modes = Object.keys(ALL_SPECIALIST_MODES) as SpecialistMode[];
  assert.equal(SPECIALIST_MODEL_TABLE_V1.length, modes.length);
  for (const mode of modes) {
    const matching = SPECIALIST_MODEL_TABLE_V1.filter((row) => row.mode === mode);
    assert.equal(matching.length, 1, `${mode} must have exactly one row`);
    // A row whose model is null is a decision ("inherit the configured one"),
    // not an omission, and has to say which.
    assert.ok(
      (matching[0]!.rationale ?? "").length > 40,
      `${mode} needs a rationale a reader can act on`,
    );
  }
  assert.throws(
    () => specialistModelRowV1("not_a_mode" as SpecialistMode),
    /No specialist model row/u,
  );
});

test("the two shipped overrides keep the behaviour their workers had", () => {
  // code_builder: unconditional on the cloud transport, thinking pinned on.
  for (const tier of ["quick", "standard", "deep", "extended"] as const) {
    assert.deepEqual(
      resolveSpecialistModelV1({ mode: "code_builder", descriptor: CLOUD, researchEffortTier: tier }),
      { model: OLLAMA_CLOUD_CODE_WORKER_MODEL_V1, think: true },
      tier,
    );
  }
  // researcher: deep and extended only.
  for (const tier of ["deep", "extended"] as const) {
    assert.deepEqual(
      resolveSpecialistModelV1({ mode: "researcher", descriptor: CLOUD, researchEffortTier: tier }),
      { model: OLLAMA_CLOUD_DEEP_RESEARCH_MODEL_V1, think: "inherit" },
      tier,
    );
  }
  for (const tier of ["quick", "standard"] as const) {
    assert.equal(
      resolveSpecialistModelV1({ mode: "researcher", descriptor: CLOUD, researchEffortTier: tier }),
      null,
      tier,
    );
  }
  // An effort-gated row with no tier supplied does not fire: the gate is not
  // satisfied by silence.
  assert.equal(
    resolveSpecialistModelV1({ mode: "researcher", descriptor: CLOUD }),
    null,
  );
});

test("no override reaches a transport that does not have these models", () => {
  assert.equal(isDirectCloudTransportV1(CLOUD), true);
  assert.equal(isDirectCloudTransportV1(LOCAL), false);
  assert.equal(isDirectCloudTransportV1(undefined), false);
  assert.equal(isDirectCloudTransportV1(null), false);
  for (const mode of Object.keys(ALL_SPECIALIST_MODES) as SpecialistMode[]) {
    for (const descriptor of [LOCAL, undefined, null]) {
      assert.equal(
        resolveSpecialistModelV1({ mode, descriptor, researchEffortTier: "deep" }),
        null,
        `${mode} must not name a cloud model off the cloud transport`,
      );
    }
  }
});

test("the modes with no override say so rather than being absent", () => {
  for (const mode of ["code_reviewer", "linear_planner", "recovery_verifier"] as const) {
    assert.equal(specialistModelRowV1(mode).cloudModel, null);
    assert.equal(
      resolveSpecialistModelV1({ mode, descriptor: CLOUD, researchEffortTier: "deep" }),
      null,
    );
  }
});

test("no worker re-inlines the transport check or a bare model id", () => {
  // The failure this table exists to prevent is a third private copy. Model
  // ids and the endpoint check belong in exactly one file.
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const file of ["codeWorker.ts", "researchWorker.ts"]) {
    const source = readFileSync(path.join(root, "src", "orchestrator", file), "utf8");
    assert.ok(
      !/endpointCategory\s*===\s*"ollama_cloud"/u.test(source),
      `${file} must ask isDirectCloudTransportV1, not re-derive the transport`,
    );
    assert.ok(
      !/["'](?:kimi-|nemotron-)/u.test(source),
      `${file} must not name a model id; the table does`,
    );
  }
});
