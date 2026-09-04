import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewSource = readFileSync(new URL("../src/AgentView.ts", import.meta.url), "utf8");
const developerMissionProgressSource = readFileSync(
  new URL("../src/ui/developerMissionProgress.ts", import.meta.url),
  "utf8",
);
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

test("Chat exposes one live-run surface with compact developer progress", () => {
  assert.equal(
    [...viewSource.matchAll(/data-testid": "live-run-card"/gu)].length,
    1,
  );
  assert.match(viewSource, /data-testid": "developer-mission-stage-strip"/u);
  assert.match(viewSource, /data-testid": "developer-mission-completion"/u);
  assert.match(
    developerMissionProgressSource,
    /Research[\s\S]{0,180}Linear plan[\s\S]{0,180}Implement[\s\S]{0,180}Test[\s\S]{0,180}GitHub[\s\S]{0,180}Reflect/u,
  );
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
  assert.match(viewSource, /FIRST_RUN_CHAT_SUGGESTIONS/u);
  assert.match(viewSource, /COMMUNITY_INSTALL_HONESTY_LINE/u);
  assert.match(viewSource, /data-testid": "community-install-honesty"/u);
  assert.doesNotMatch(viewSource, /tested tool/u);
  assert.match(styles, /\.agentic-researcher-chat-suggestions/u);
  assert.match(styles, /background: var\(--interactive-accent\)/u);
});

test("Stop is reachable from the composer, not only from the live-run card", () => {
  // The live-run card is a different region of the tab and can be dismissed;
  // when it was the only Stop, a running mission left the composer showing a
  // disabled Run Mission button and no way to stop what it started.
  assert.match(viewSource, /data-testid": "composer-stop"/u);
  assert.match(viewSource, /data-testid": "live-run-stop"/u);
  // Both call the same path: two stop buttons must never mean two stop
  // semantics.
  assert.equal([...viewSource.matchAll(/this\.requestStop\(\);/gu)].length >= 2, true);
  assert.match(
    viewSource,
    /composerStopButtonEl\.hidden = !this\.isRunning/u,
    "the composer Stop must be visible exactly while a run is stoppable",
  );
  assert.doesNotMatch(
    viewSource,
    /use Stop in the live-run card/u,
    "the aria-label must not send the user to the card any more",
  );
});

test("Run Details can be navigated and filtered without losing a section", () => {
  // Eight tiles, seven sections, and thirteen more behind Diagnostics: the tab
  // holds everything it always did, but finding one row no longer means
  // scrolling past the other twenty.
  assert.match(viewSource, /data-testid": "run-details-nav"/u);
  assert.match(viewSource, /data-testid": "run-details-filter"/u);
  assert.match(viewSource, /RUN_DETAILS_JUMP_TARGETS_V1/u);
  // Jumping into Diagnostics has to open it, or the chip scrolls to a closed
  // expander and appears to do nothing.
  assert.match(viewSource, /diagnostics\.open = true/u);
  // Rows are hidden, never removed: pinned selectors keep resolving.
  assert.match(viewSource, /classList\.toggle\("is-filtered-out", !hit\)/u);
  assert.match(
    styles,
    /\.agentic-researcher-dashboard \.is-filtered-out[\s\S]{0,80}display: none;/u,
  );
  // The filter deliberately leaves prose sections alone.
  assert.match(
    viewSource,
    /RUN_DETAILS_FILTERABLE_ROW_SELECTOR_V1 =\s*\n?\s*"\.agentic-researcher-config-line/u,
  );
});
