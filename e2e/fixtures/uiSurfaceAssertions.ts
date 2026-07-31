import { expect, type Page } from "@playwright/test";

/**
 * Assertions over the UI surfaces a real mission passes through.
 *
 * There is no selector drift in this suite — every class the e2e used already
 * exists in `src/AgentView.ts`. The gap was coverage: the specs drove seven
 * selectors against a view that renders sixty-plus classes, so the approval
 * card's contents, the acceptance rows, the Run Details panel, and the chat
 * transcript were never actually asserted. A mission could render a card
 * naming the wrong destination, or an empty Run Details panel, and every lane
 * stayed green.
 *
 * These helpers assert what the user is shown, not merely that an element
 * appeared. They are read-only: nothing here clicks, approves, or mutates.
 */

export interface ApprovalSurfaceObservationV1 {
  toolName: string;
  destination: string;
  summary: string;
  /** The `target=<system:resourceType> <id> <url>` meta line, or "". */
  targetLine: string;
  /** The `fingerprint=sha256:… outbound=…B confirmation=i/n` meta line, or "". */
  fingerprintLine: string;
  hasApprove: boolean;
  hasDeny: boolean;
}

/**
 * Read the visible approval card. `destination` is the string the user is
 * asked to authorize, so a lane can assert the card names the same target the
 * prepared action carries rather than trusting that a card exists.
 */
export async function readApprovalSurfaceV1(
  page: Page,
): Promise<ApprovalSurfaceObservationV1 | null> {
  const card = page.locator(".agentic-researcher-approval-card").last();
  if ((await card.count()) === 0) return null;
  const text = async (selector: string): Promise<string> => {
    const node = card.locator(selector);
    return (await node.count()) > 0
      ? ((await node.first().textContent()) ?? "").trim()
      : "";
  };
  // The meta rows are positional (policy, target, fingerprint, decision), so
  // read them all and pick lines by their stable prefixes.
  const metaLines: string[] = [];
  const metaNodes = card.locator(".agentic-researcher-approval-meta");
  const metaCount = await metaNodes.count();
  for (let index = 0; index < metaCount; index += 1) {
    metaLines.push(((await metaNodes.nth(index).textContent()) ?? "").trim());
  }
  return {
    toolName: await text(".agentic-researcher-approval-title"),
    destination: await text(".agentic-researcher-approval-destination"),
    summary: await text(".agentic-researcher-approval-summary"),
    targetLine: metaLines.find((line) => line.startsWith("target=")) ?? "",
    fingerprintLine:
      metaLines.find((line) => line.startsWith("fingerprint=")) ?? "",
    hasApprove:
      (await card.locator(".agentic-researcher-approval-approve").count()) > 0,
    hasDeny:
      (await card.locator(".agentic-researcher-approval-deny").count()) > 0,
  };
}

/**
 * A prepared approval must show the user a real destination and both
 * decisions. An approval card offering no way to deny is not a choice.
 */
export async function assertApprovalSurfaceUsableV1(
  page: Page,
): Promise<ApprovalSurfaceObservationV1> {
  const observed = await readApprovalSurfaceV1(page);
  expect(observed, "no approval card was rendered").not.toBeNull();
  const surface = observed!;
  expect(surface.toolName, "the card must name the tool being authorized").not.toBe("");
  expect(
    surface.destination,
    "the card must show the destination the user is authorizing",
  ).not.toBe("");
  expect(surface.hasApprove && surface.hasDeny, "both decisions must be offered").toBe(
    true,
  );
  // A prepared card (one with a destination) must also carry its provenance:
  // the target it will mutate and the payload fingerprint the user is
  // approving. These are what make an approval auditable after the fact.
  expect(
    surface.targetLine,
    "the card must name the exact target resource",
  ).toMatch(/^target=\S/u);
  expect(
    surface.fingerprintLine,
    "the card must carry the payload fingerprint being authorized",
  ).toMatch(/^fingerprint=sha256:/u);
  return surface;
}

/**
 * The Run Details panel is where a blocked or finished mission explains
 * itself. An empty panel after a mission is a real defect the suite could not
 * previously see.
 */
export async function assertRunDetailsPopulatedV1(page: Page): Promise<string> {
  await page.getByRole("tab", { name: "Activity" }).click();
  const panel = page.locator(".agentic-researcher-details-panel");
  await expect(panel).toHaveCount(1);
  const configLines = panel.locator(".agentic-researcher-config-line");
  expect(
    await configLines.count(),
    "Run Details rendered no configuration lines for a completed mission",
  ).toBeGreaterThan(0);
  return ((await panel.textContent()) ?? "").trim();
}

/** Acceptance rows are the mission's own verdict, keyed and valued. */
export async function readAcceptanceRowsV1(
  page: Page,
): Promise<Array<{ key: string; value: string }>> {
  const rows = page.locator(".agentic-researcher-acceptance-row");
  const count = await rows.count();
  const observed: Array<{ key: string; value: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const key = row.locator(".agentic-researcher-acceptance-key");
    const value = row.locator(".agentic-researcher-acceptance-value");
    observed.push({
      key: (await key.count()) > 0 ? ((await key.first().textContent()) ?? "").trim() : "",
      value:
        (await value.count()) > 0
          ? ((await value.first().textContent()) ?? "").trim()
          : "",
    });
  }
  return observed;
}

/** The last assistant message the user actually sees in the chat transcript. */
export async function readAssistantReplyV1(page: Page): Promise<string> {
  const message = page
    .locator(
      ".agentic-researcher-log-assistant .agentic-researcher-log-message",
    )
    .last();
  if ((await message.count()) === 0) return "";
  return ((await message.textContent()) ?? "").trim();
}

export interface ChatTranscriptObservationV1 {
  userMessages: number;
  assistantMessages: number;
  systemMessages: number;
}

/**
 * A mission must leave a readable conversation behind. The log item class is
 * built as `agentic-researcher-log-${kind}` at `AgentView.ts:3489`.
 */
export async function readChatTranscriptV1(
  page: Page,
): Promise<ChatTranscriptObservationV1> {
  const countOf = async (kind: string): Promise<number> =>
    page.locator(`.agentic-researcher-log-item.agentic-researcher-log-${kind}`).count();
  return {
    userMessages: await countOf("user"),
    assistantMessages: await countOf("assistant"),
    systemMessages: await countOf("system"),
  };
}

/**
 * One call covering every surface a completed mission should have populated.
 * Returns the observations so a lane can make its own stronger assertions.
 */
export async function assertMissionUiSurfacesV1(page: Page): Promise<{
  runDetails: string;
  acceptance: Array<{ key: string; value: string }>;
  transcript: ChatTranscriptObservationV1;
  assistantReply: string;
}> {
  const runDetails = await assertRunDetailsPopulatedV1(page);
  const acceptance = await readAcceptanceRowsV1(page);
  await page.getByRole("tab", { name: "Chat" }).click();
  const transcript = await readChatTranscriptV1(page);
  const assistantReply = await readAssistantReplyV1(page);

  expect(
    transcript.userMessages,
    "the chat must retain the mission prompt the user submitted",
  ).toBeGreaterThan(0);
  expect(
    transcript.assistantMessages,
    "the chat must retain at least one assistant reply",
  ).toBeGreaterThan(0);
  expect(assistantReply, "the final assistant reply must not be empty").not.toBe("");

  return { runDetails, acceptance, transcript, assistantReply };
}
