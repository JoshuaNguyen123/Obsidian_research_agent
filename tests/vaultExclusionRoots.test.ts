import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isGeneratedOrCachePath,
  isVaultPathExcluded,
  vaultExclusionRootsFromSettingsV1,
} from "../src/tools/vaultExclusions";

test("research memory is excluded on a stock install", () => {
  // The agent writes these notes itself and reads them back through
  // search_research_memory / read_research_memory. Leaving them in general
  // vault search let a run retrieve its own earlier summary and cite it as if
  // the user had written it.
  assert.ok(isGeneratedOrCachePath("Agent Research Memory/transformers.md"));
  assert.ok(isVaultPathExcluded("Agent Research Memory/transformers.md"));
  assert.ok(!isVaultPathExcluded("Research/transformers.md"));
});

test("the configured folders are excluded, not just the default names", () => {
  const settings = {
    semanticIndexFolder: "Meta/Index",
    researchMemoryFolder: "Meta/Agent Memory Notes",
  };
  const extraRoots = vaultExclusionRootsFromSettingsV1(settings);
  assert.deepEqual(extraRoots, ["Meta/Index", "Meta/Agent Memory Notes"]);
  assert.ok(isVaultPathExcluded("Meta/Index/shard-1.md", { extraRoots }));
  assert.ok(
    isVaultPathExcluded("Meta/Agent Memory Notes/topic.md", { extraRoots }),
  );
  // Without the roots — the old behavior — the plugin's own output looked
  // exactly like a user note.
  assert.ok(!isVaultPathExcluded("Meta/Index/shard-1.md"));
  // A sibling folder that merely shares a prefix is still the user's.
  assert.ok(!isVaultPathExcluded("Meta/Indexing notes.md", { extraRoots }));
});

test("blank or missing folder settings add no roots", () => {
  assert.deepEqual(vaultExclusionRootsFromSettingsV1(undefined), []);
  assert.deepEqual(vaultExclusionRootsFromSettingsV1({}), []);
  assert.deepEqual(
    vaultExclusionRootsFromSettingsV1({
      semanticIndexFolder: "   ",
      researchMemoryFolder: "",
    }),
    [],
  );
});

/**
 * `isVaultPathExcluded` has always taken `extraRoots` and, until this change,
 * no caller passed any: the parameter existed and did nothing. A call site
 * that drops them again re-opens exactly that hole, and no behavioural test
 * covering the default folder names would notice.
 */
test("every exclusion call site passes the configured roots", () => {
  const callers = [
    "src/embeddings/semanticIndex.ts",
    "src/tools/graphTools.ts",
    "src/tools/semanticSearchTools.ts",
    "src/tools/vaultTools.ts",
  ];
  for (const file of callers) {
    const source = readFileSync(file, "utf8");
    const calls = source.match(/isVaultPathExcluded\([^)]*\)/gu) ?? [];
    assert.ok(calls.length > 0, `${file} no longer filters excluded paths`);
    for (const call of calls) {
      assert.ok(
        call.includes("extraRoots"),
        `${file} calls isVaultPathExcluded without the configured roots: ${call}`,
      );
    }
    assert.ok(
      source.includes("vaultExclusionRootsFromSettingsV1"),
      `${file} must derive its roots from settings`,
    );
  }
});
