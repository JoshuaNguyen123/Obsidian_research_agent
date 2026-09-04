import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The settings tab is a hundred-odd rows spread across six collapsed
 * accordions, and until now the only way to reach one was to know which
 * accordion it lived in. Worse, rows a preset owns were not rendered at all:
 * under the balanced preset the eight semantic values existed in the file, were
 * read at runtime, and could not be found by any amount of looking.
 *
 * `src/settings.ts` cannot be imported here (`obsidian` ships types only, no
 * runtime module), so these are source-shape guards — which is the right shape
 * anyway: what must not regress is that the search exists, runs on every
 * render, and that preset-owned rows stay in the document where it can find
 * them.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS = readFileSync(path.join(ROOT, "src", "settings.ts"), "utf8");
const STYLES = readFileSync(path.join(ROOT, "styles.css"), "utf8");

describe("settings search", () => {
  it("runs on every render, not only when the box is typed into", () => {
    // A re-render is triggered by a preset toggle or a connection test while a
    // filter is active; if display() did not re-apply it, the tab would silently
    // repopulate with rows the user had filtered away.
    assert.match(SETTINGS, /private applySettingsFilter\(\): void \{/);
    assert.match(SETTINGS, /private renderSettingsSearch\(containerEl: HTMLElement\): void \{/);
    const display = SETTINGS.slice(
      SETTINGS.indexOf("  display() {"),
      SETTINGS.indexOf("  hide(): void {"),
    );
    assert.ok(display.includes("this.renderSettingsSearch(containerEl);"), display);
    assert.ok(display.includes("this.applySettingsFilter();"), display);
  });

  it("hides rows with a class instead of removing them", () => {
    // Rows must stay in the DOM: pinned e2e selectors and assistive technology
    // both walk this document, and a filter is a view, not a deletion.
    assert.match(SETTINGS, /classList\.toggle\("is-filtered-out"/);
    assert.ok(
      /\.setting-item\.is-filtered-out[\s\S]{0,200}display: none;/.test(STYLES),
      "styles.css must hide filtered rows",
    );
    assert.ok(
      !/removeChild|\.remove\(\)/.test(
        SETTINGS.slice(
          SETTINGS.indexOf("private applySettingsFilter"),
          SETTINGS.indexOf("private renderSettingsSearch"),
        ),
      ),
      "the filter must not detach rows",
    );
  });

  it("keeps preset-owned rows in the document so they can be found", () => {
    // The old idiom rendered them into a detached div, which is indistinguishable
    // from not existing. Two hosts moved to the searchable form; the two that
    // remain detached are children of a capability the user switched off, where
    // the rows genuinely do not apply.
    assert.match(SETTINGS, /private createPresetHiddenHost\(/);
    assert.ok(
      SETTINGS.includes('this.createPresetHiddenHost(section, "Custom limits")'),
      "safety-ceiling limits must be searchable",
    );
    assert.ok(
      SETTINGS.includes('this.createPresetHiddenHost(section, "Custom values")'),
      "semantic tuning values must be searchable",
    );
    const detached = SETTINGS.match(/: document\.createElement\("div"\)/gu) ?? [];
    assert.equal(
      detached.length,
      2,
      `only the two switched-off-capability hosts may stay detached; found ${detached.length}`,
    );
  });

  it("says why a revealed preset row cannot be edited from the search", () => {
    // Revealing a row the preset overwrites, and letting it be edited, would
    // make the preset label lie. It is shown inert, with the option that
    // unlocks it named.
    assert.match(SETTINGS, /Shown by search\. The preset above sets these; choose/);
    assert.ok(
      /is-search-revealed[\s\S]{0,160}pointer-events: none;/.test(STYLES),
      "revealed preset rows must be inert",
    );
  });

  it("opens a collapsed section that contains a match", () => {
    const filter = SETTINGS.slice(
      SETTINGS.indexOf("private applySettingsFilter"),
      SETTINGS.indexOf("private renderSettingsSearch"),
    );
    assert.ok(filter.includes("section.open = true"), filter);
    assert.ok(filter.includes("agentic-settings-advanced-section"), filter);
  });
});
