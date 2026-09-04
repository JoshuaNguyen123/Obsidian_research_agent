import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { hasCodeDeliverableIntent } from "../src/agent/codeDeliverableIntent";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS_PATH = path.join(REPO_ROOT, "src", "settings.ts");
const VIEW_PATH = path.join(REPO_ROOT, "src", "AgentView.ts");
const MANIFEST_PATH = path.join(REPO_ROOT, "manifest.json");
const README_PATH = path.join(REPO_ROOT, "README.md");
const E2E_ROOT = path.join(REPO_ROOT, "e2e");

const COMMUNITY_ZIP_FILES = ["main.js", "manifest.json", "styles.css"] as const;
const OPTIONAL_FOURTH_ARTIFACT = "companion-assets.json";
const HONESTY_LINE =
  "Companion and overnight resume are optional and are not included in the community zip.";

function read(relOrAbs: string): string {
  return readFileSync(relOrAbs, "utf8");
}

function settingsTabBody(source: string): string {
  const marker = "export class AgentSettingTab";
  const index = source.indexOf(marker);
  assert.ok(index >= 0, "AgentSettingTab class not found");
  return source.slice(index);
}

function extractQuotedStrings(block: string): string[] {
  return [...block.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/gu)].map((match) =>
    match[1].replace(/\\"/gu, '"'),
  );
}

function extractFirstRunChatSuggestions(settingsSource: string): string[] {
  const match = settingsSource.match(
    /export const FIRST_RUN_CHAT_SUGGESTIONS\s*=\s*\[([\s\S]*?)\]\s*as const/u,
  );
  assert.ok(match, "FIRST_RUN_CHAT_SUGGESTIONS is missing from settings.ts");
  const chips = extractQuotedStrings(match[1]);
  assert.ok(chips.length >= 2, "first-run suggestion list is too short");
  return chips;
}

/**
 * Metric A. The old community chip asked to turn acceptance criteria into a
 * tested tool. That is a code-validation mission even when the current
 * sandbox classifier still returns false for that wording.
 */
function firstRunChipRequiresSandbox(prompt: string): boolean {
  return (
    hasCodeDeliverableIntent(prompt) ||
    /\btested tool\b/iu.test(prompt) ||
    /\bacceptance criteria\b[\s\S]{0,80}\b(?:tool|code|implement)\b/iu.test(
      prompt,
    )
  );
}

function walkFiles(directory: string, suffix: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      files.push(entryPath);
    }
  }
  return files;
}

function countConservativeRouterPins(): { count: number; files: string[] } {
  const files: string[] = [];
  let count = 0;
  for (const filePath of walkFiles(E2E_ROOT, ".ts")) {
    const text = read(filePath);
    const matches = text.match(/modelRouterMode:\s*"conservative"/gu) ?? [];
    if (matches.length > 0) {
      count += matches.length;
      files.push(path.relative(REPO_ROOT, filePath));
    }
  }
  return { count, files };
}

test("Metric A: first-run chips requiring sandbox are 0", () => {
  const settingsSource = read(SETTINGS_PATH);
  const viewSource = read(VIEW_PATH);
  const chips = extractFirstRunChatSuggestions(settingsSource);
  assert.match(viewSource, /FIRST_RUN_CHAT_SUGGESTIONS/u);
  assert.doesNotMatch(viewSource, /tested tool/u);
  assert.doesNotMatch(settingsSource, /tested tool/u);
  const requiring = chips.filter(firstRunChipRequiresSandbox);
  assert.equal(
    requiring.length,
    0,
    `first_run_chips_requiring_sandbox=${requiring.length} (${requiring.join(" | ")})`,
  );
});

test("Metric B: orchestratorAutoMergeGreen is not rendered", () => {
  const tab = settingsTabBody(read(SETTINGS_PATH));
  const renderedName = [...tab.matchAll(/Auto-merge green orchestrator worktrees/gu)];
  const renderedKey = [...tab.matchAll(/orchestratorAutoMergeGreen/gu)];
  assert.equal(
    renderedName.length + (renderedKey.length > 0 ? 1 : 0),
    0,
    `visible_noop_code_team_settings name=${renderedName.length} key=${renderedKey.length}`,
  );
  assert.doesNotMatch(tab, /code-team Lead \+ Worker/u);
  assert.doesNotMatch(tab, /explicit code-team requests use Lead \+ Worker/u);
});

test("Metric C: e2e conservative router pins are 0", () => {
  const { count, files } = countConservativeRouterPins();
  assert.equal(
    count,
    0,
    `e2e_conservative_router_pins=${count} in ${files.join(", ")}`,
  );
});

test("offline community-install assertion: file list and first-run copy", () => {
  const readme = read(README_PATH);
  const installSection = readme.split("## Install For Development")[1] ?? "";
  const manifest = JSON.parse(read(MANIFEST_PATH)) as {
    isDesktopOnly?: boolean;
    description?: string;
  };
  const settingsSource = read(SETTINGS_PATH);
  const viewSource = read(VIEW_PATH);
  const chips = extractFirstRunChatSuggestions(settingsSource);

  assert.equal(manifest.isDesktopOnly, true);
  assert.match(String(manifest.description), /Desktop-only/u);
  assert.match(String(manifest.description), /bring-your-own-key paid cloud/u);
  assert.match(String(manifest.description), /without WSL/u);
  assert.match(String(manifest.description), /fourth optional artifact/u);

  assert.match(installSection, /community zip/iu);
  assert.match(installSection, /Desktop-only/u);
  assert.match(installSection, /bring-your-own-key paid cloud/u);
  assert.match(installSection, /without WSL/u);
  for (const fileName of COMMUNITY_ZIP_FILES) {
    assert.match(
      installSection,
      new RegExp(`^${fileName}$`, "mu"),
      `install section must list community file ${fileName}`,
    );
    assert.equal(existsSync(path.join(REPO_ROOT, fileName)), true, fileName);
    assert.equal(statSync(path.join(REPO_ROOT, fileName)).isFile(), true);
  }
  assert.match(installSection, new RegExp(OPTIONAL_FOURTH_ARTIFACT, "u"));
  assert.match(installSection, /not\*\* in the community zip/iu);

  assert.match(settingsSource, new RegExp(HONESTY_LINE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(viewSource, /COMMUNITY_INSTALL_HONESTY_LINE/u);
  assert.match(viewSource, /data-testid": "community-install-honesty"/u);
  assert.match(settingsSource, /autoResumeOvernightRuns: false/u);
  assert.match(
    settingsTabBody(settingsSource),
    /autoResumeOvernightRuns === true/u,
  );

  for (const chip of chips) {
    assert.equal(firstRunChipRequiresSandbox(chip), false, chip);
  }
});
