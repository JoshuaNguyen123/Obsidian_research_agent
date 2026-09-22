import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeAgentSettings } from "../src/agent/settingsNormalize";

/**
 * `src/settings.ts` and `src/agent/settingsNormalize.ts` each carry a default
 * table. They drifted once — `autoResumeOvernightRuns` was `false` in one and
 * `true` in the other — and the shipped behavior silently followed whichever
 * table the host happened to spread last. Every scalar key the shipped table
 * defines must resolve to the same value for a fresh install.
 *
 * The shipped table is read from source rather than imported: `settings.ts`
 * requires the `obsidian` module at load, which has no runtime outside the
 * app, so a value import can never resolve in this runner.
 */
function readShippedScalarDefaults(): Map<string, unknown> {
  const source = readFileSync(
    new URL("../src/settings.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export const DEFAULT_SETTINGS: AgentSettings = {");
  assert.ok(start >= 0, "DEFAULT_SETTINGS literal not found in src/settings.ts");
  // The literal ends at the first line that is exactly `};` after its start.
  const end = source.indexOf("\n};", start);
  assert.ok(end > start, "DEFAULT_SETTINGS literal has no closing brace");
  const body = source.slice(start, end);
  const defaults = new Map<string, unknown>();
  for (const line of body.split("\n")) {
    const match = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*(true|false|-?\d+(?:_\d+)*(?:\.\d+)?|"[^"]*"|null),\s*(?:\/\/.*)?$/u.exec(
      line,
    );
    if (!match) continue;
    const [, key, raw] = match;
    defaults.set(
      key,
      raw === "true"
        ? true
        : raw === "false"
          ? false
          : raw === "null"
            ? null
            : raw.startsWith('"')
              ? raw.slice(1, -1)
              : Number(raw.replace(/_/g, "")),
    );
  }
  assert.ok(defaults.size > 20, `only ${defaults.size} scalar defaults parsed`);
  return defaults;
}

/**
 * Keys the normalizer derives rather than defaults. `specialistModel` is
 * `data.specialistModel || legacy utilityModel`: the normalizer never invents
 * a model name (tests/settingsNormalize.test.ts pins "" for a fresh install),
 * while the shipped table seeds the shipped specialist. Both are deliberate.
 */
const DERIVED_KEYS = new Set(["specialistModel"]);

test("the shipped defaults and the normalizer agree on every shared scalar key", () => {
  const shipped = readShippedScalarDefaults();
  const normalized = normalizeAgentSettings({}, "new_install") as Record<
    string,
    unknown
  >;
  const disagreements: string[] = [];
  for (const [key, value] of shipped) {
    if (!(key in normalized) || DERIVED_KEYS.has(key)) continue;
    if (normalized[key] !== value) {
      disagreements.push(
        `${key}: settings.ts=${JSON.stringify(value)} normalize=${JSON.stringify(normalized[key])}`,
      );
    }
  }
  assert.deepEqual(disagreements, []);
  // The key that drifted is present on both sides, so the check has teeth.
  assert.ok(shipped.has("autoResumeOvernightRuns"));
  assert.ok("autoResumeOvernightRuns" in normalized);
});

test("auto-resume after reload is opt-in on both tables and survives an explicit opt-in", () => {
  // The community install promises no background resume without consent
  // (tests/communityInstallHonesty.test.ts); the normalizer used to say the
  // opposite, so a fresh install's behavior depended on spread order.
  assert.equal(readShippedScalarDefaults().get("autoResumeOvernightRuns"), false);
  assert.equal(
    normalizeAgentSettings({}, "new_install").autoResumeOvernightRuns,
    false,
  );
  assert.equal(
    normalizeAgentSettings({ autoResumeOvernightRuns: true }, "existing_install")
      .autoResumeOvernightRuns,
    true,
  );
});

test("vault triggers are opt-in and the approval timeout is bounded", () => {
  const fresh = normalizeAgentSettings({}, "new_install");
  assert.equal(fresh.vaultTriggersEnabled, false);
  assert.equal(fresh.approvalTimeoutMs, 120_000);
  assert.equal(
    normalizeAgentSettings({ approvalTimeoutMs: 5 }, "existing_install").approvalTimeoutMs,
    1_000,
  );
  assert.equal(
    normalizeAgentSettings({ approvalTimeoutMs: 999_999_999 }, "existing_install")
      .approvalTimeoutMs,
    30 * 60_000,
  );
  assert.equal(
    normalizeAgentSettings({ approvalTimeoutMs: Number.NaN }, "existing_install")
      .approvalTimeoutMs,
    120_000,
  );
});
