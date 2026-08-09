import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsSource = readFileSync(
  new URL("../src/settings.ts", import.meta.url),
  "utf8",
);
const mainSource = readFileSync(new URL("../main.ts", import.meta.url), "utf8");

test("settings expose explicit Lead and Specialist model slots", () => {
  assert.match(settingsSource, /text: "Agent 1 — Lead"/u);
  assert.match(settingsSource, /text: "Agent 2 — Specialist"/u);
  assert.match(settingsSource, /setName\("Specialist model"\)/u);
  assert.match(settingsSource, /Share Agent 1 connection/u);
  assert.match(settingsSource, /Use separate connection/u);
  assert.match(settingsSource, /setName\("Specialist API key"\)/u);
  assert.match(settingsSource, /Test both agents/u);
  assert.doesNotMatch(settingsSource, /setName\("Utility model"\)/u);
  assert.doesNotMatch(settingsSource, /blank = reuse provider key/u);
  assert.doesNotMatch(
    settingsSource,
    /setValue\(settings\.specialistApiKey/u,
  );
  assert.doesNotMatch(
    settingsSource,
    /setValue\(this\.plugin\.settings\.(?:ollamaApiKey|openAiCompatibleApiKey)/u,
  );
});

test("plugin persistence strips both current and legacy Agent 2 plaintext keys", () => {
  assert.match(mainSource, /specialistApiKey: _specialistApiKey/u);
  assert.match(mainSource, /utilityApiKey: _utilityApiKey/u);
  assert.match(
    mainSource,
    /specialist: this\.settings\.specialistApiKey \?\? ""/u,
  );
  assert.match(mainSource, /Lead key is never inherited/iu);
  assert.match(mainSource, /missing_specialist_credential/u);
});
