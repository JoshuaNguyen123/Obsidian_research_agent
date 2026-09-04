import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * A setting that exists, is read at runtime, and has no control anywhere is a
 * capability the user cannot see or change. `adaptiveResearchProgress` was one
 * of those: declared, consumed in three places, and invisible.
 *
 * `src/settings.ts` cannot be imported at runtime here — `obsidian` ships types
 * only, with no runtime module — so this reads the source. That is the point:
 * the guard has to fail when someone adds a setting and forgets the control,
 * which is a source-shape property, not a runtime one.
 */
const SETTINGS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "settings.ts",
);

/**
 * Keys with no control by design. Each one is either persisted evidence, a
 * derived mirror of something the user already controls, or state a control
 * would let the user corrupt. Adding a key here is a claim that the user has
 * no business setting it — say which, in the comment.
 */
const INTENTIONALLY_NOT_USER_FACING: ReadonlyMap<string, string> = new Map([
  ["settingsSchemaVersion", "migration bookkeeping"],
  ["vaultScopeId", "opaque vault-local memory scope"],
  ["modelConnectionVerifiedAt", "evidence from a connection test"],
  ["modelConnectionVerifiedProvider", "evidence from a connection test"],
  ["modelConnectionVerifiedModel", "evidence from a connection test"],
  ["modelConnectionVerifiedBaseUrl", "evidence from a connection test"],
  [
    "modelConnectionVerifiedAgenticCapabilities",
    "evidence from a connection test",
  ],
  ["modelConnectionVerifiedContextLength", "evidence from a connection test"],
  ["specialistConnectionVerifiedAt", "evidence from a connection test"],
  ["specialistConnectionVerifiedProvider", "evidence from a connection test"],
  ["specialistConnectionVerifiedModel", "evidence from a connection test"],
  ["specialistConnectionVerifiedBaseUrl", "evidence from a connection test"],
  ["specialistConnectionVerifiedMode", "evidence from a connection test"],
  ["e2eHarnessAttestationEnabled", "harness attestation, never a user choice"],
  ["utilityApiKey", "schema-4 alias mirroring specialistApiKey"],
  ["researchMemoryEnabled", "derived from the memory mode dropdown"],
  ["experienceMemoryEnabled", "derived from the memory mode dropdown"],
  ["linearEnabled", "derived from whether a Linear credential exists"],
  ["githubEnabled", "derived from whether a GitHub credential exists"],
  ["linearCapabilityGate", "deprecated; pinned on load"],
  ["linearScanIntervalMinutes", "pinned to 15 on load"],
  [
    "orchestratorAutoMergeGreen",
    "hidden: feeds dead runCodeTeamMission only; not rendered",
  ],
]);

function readSettingsSource(): string {
  return readFileSync(SETTINGS_PATH, "utf8");
}

function settingsKeys(source: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith("export interface AgentSettings"),
  );
  assert.ok(start >= 0, "AgentSettings interface not found");
  const keys: string[] = [];
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/.exec(line);
    if (match && depth <= 1) {
      keys.push(match[1]);
    }
    if (index > start && depth === 0) {
      break;
    }
  }
  return keys;
}

/** Everything from the settings tab class onward. */
function settingsTabBody(source: string): string {
  const marker = "export class AgentSettingTab";
  const index = source.indexOf(marker);
  assert.ok(index >= 0, "AgentSettingTab class not found");
  return source.slice(index);
}

describe("settings reachability", () => {
  it("gives every user-facing setting a control in the settings tab", () => {
    const source = readSettingsSource();
    const body = settingsTabBody(source);
    const orphans = settingsKeys(source).filter(
      (key) => !INTENTIONALLY_NOT_USER_FACING.has(key) && !body.includes(key),
    );
    assert.deepEqual(
      orphans,
      [],
      `these settings are read at runtime but have no control: ${orphans.join(", ")}`,
    );
  });

  it("keeps the exemption list honest", () => {
    const keys = new Set(settingsKeys(readSettingsSource()));
    const stale = [...INTENTIONALLY_NOT_USER_FACING.keys()].filter(
      (key) => !keys.has(key),
    );
    assert.deepEqual(
      stale,
      [],
      `these exemptions no longer name a real setting: ${stale.join(", ")}`,
    );
  });

  it("exposes the research-behaviour switches a researcher actually tunes", () => {
    const body = settingsTabBody(readSettingsSource());
    for (const key of [
      "adaptiveResearchProgress",
      "researchEffortCeiling",
      "defaultMinFetchedSources",
      "freeSearchFallbackEnabled",
      "deadLinkRecheckEnabled",
      "semanticSearchEnabled",
      "semanticIndexEnabled",
    ]) {
      assert.ok(body.includes(key), `${key} has no control in the settings tab`);
    }
  });

  it("keeps the capabilities the daily quick actions depend on enabled by default", () => {
    // Cite this / Check citations / Ask my vault are only honest when the
    // machinery behind them ships on. A default flipped to false here turns a
    // menu entry into a dead one.
    const source = readSettingsSource();
    for (const line of [
      "semanticSearchEnabled: true,",
      "semanticIndexEnabled: true,",
      "deadLinkRecheckEnabled: true,",
      "freeSearchFallbackEnabled: true,",
      "adaptiveResearchProgress: true,",
      "researchMemoryEnabled: true,",
    ]) {
      assert.ok(source.includes(line), `DEFAULT_SETTINGS lost: ${line}`);
    }
  });
});
