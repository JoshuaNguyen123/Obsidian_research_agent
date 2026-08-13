import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewSource = readFileSync(new URL("../src/AgentView.ts", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const chatCleanupSource = readFileSync(
  new URL("../e2e/fixtures/chatCleanup.ts", import.meta.url),
  "utf8",
);

test("native UI remains prompt-first with one Run Details destination", () => {
  assert.match(viewSource, /text: "Chat"/u);
  assert.match(viewSource, /text: "Run Details"/u);
  assert.doesNotMatch(viewSource, /text: "Activity"/u);
  assert.match(viewSource, /this\.activeTab = "chat"/u);
  assert.doesNotMatch(settingsSource, /runDetailsActiveTab/u);
  assert.doesNotMatch(settingsSource, /runDetailsDiagnosticsExpanded/u);
});

test("Chat exposes one live-run surface and keeps process controls out of conversation", () => {
  assert.equal(
    [...viewSource.matchAll(/data-testid": "live-run-card"/gu)].length,
    1,
  );
  assert.doesNotMatch(viewSource, /data-testid": "lifecycle-stage-strip"/u);
  assert.doesNotMatch(viewSource, /data-testid": "chat-team-strip"/u);
  assert.doesNotMatch(viewSource, /data-testid": "live-workstream"/u);
  assert.match(viewSource, /text: "Open Run Details"/u);
  assert.match(viewSource, /dashboardEl\.appendChild\(this\.steeringEl\)/u);
  assert.match(viewSource, /agentic-researcher-composer-options/u);
  assert.match(
    chatCleanupSource,
    /agentic-researcher-composer-options[\s\S]{0,300}summary[\s\S]{0,300}agentic-researcher-clear/u,
    "the E2E Clear chat path must reveal the secondary Options control first",
  );
});

test("clear chat removes stale blocker attention with the transcript", () => {
  assert.match(
    viewSource,
    /await this\.plugin\.clearConversationHistory\(\);[\s\S]{0,400}this\.clearChatAttention\(\);[\s\S]{0,160}this\.setRunDetailsNeedsAttention\(false\);/u,
  );
});

test("Run Details is summary-first, conditional, and diagnostic-heavy data stays collapsed", () => {
  assert.match(viewSource, /"Acceptance and next action"/u);
  assert.match(viewSource, /"Result and receipts"[\s\S]{0,120}collapseUntilPopulated: true/u);
  assert.match(viewSource, /"Sources and evidence"[\s\S]{0,120}collapseUntilPopulated: true/u);
  assert.match(viewSource, /"Plan and steps"[\s\S]{0,120}collapseUntilPopulated: true/u);
  assert.match(viewSource, /diagnosticsEl\.open = false/u);
  assert.match(viewSource, /"Scorecard dimensions"/u);
  assert.match(
    viewSource,
    /this\.approvalDetailsEl = this\.createDashboardSection\(\s*dashboardEl,[\s\S]{0,180}"Approval required"[\s\S]{0,180}collapseUntilPopulated: true/u,
    "an actionable approval preview must not be trapped inside collapsed Diagnostics",
  );
});

test("the model-call budget is visible in Run Details, not only the Chat live card", () => {
  assert.match(
    viewSource,
    /this\.budgetValueEl = this\.createMetric\(metricsEl, "Budget", "Pending"\)/u,
  );
  // One formatter feeds both surfaces so the tile can never drift from the
  // live-run card.
  assert.match(
    viewSource,
    /refreshLiveRunBudget[\s\S]{0,600}this\.setMetric\(this\.budgetValueEl, label\)/u,
  );
});

test("completed assistant messages use isolated host-only Markdown rendering", () => {
  assert.match(viewSource, /renderSafeAssistantMarkdownV1/u);
  assert.doesNotMatch(viewSource, /MarkdownRenderer\.render/u);
  assert.match(viewSource, /LatestRenderGate<HTMLElement>/u);
  assert.match(viewSource, /chatMessageRawContent/u);
  assert.match(viewSource, /renderCompletedAssistantMarkdown/u);
  assert.doesNotMatch(
    viewSource,
    /renderCompletedAssistantMarkdown[\s\S]{0,1200}isConnected/u,
    "history may render before Obsidian attaches the view DOM",
  );
  assert.match(styles, /\.agentic-researcher-log-message\.is-rendered/u);
  assert.match(styles, /font-family: var\(--font-monospace\)/u);
});

test("empty state and primary mission action use the shared UI system", () => {
  assert.match(viewSource, /What should we work on\?/u);
  assert.match(viewSource, /data-testid": "chat-empty-state"/u);
  assert.match(styles, /\.agentic-researcher-chat-suggestions/u);
  assert.match(styles, /background: var\(--interactive-accent\)/u);
});
