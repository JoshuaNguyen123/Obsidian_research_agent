import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ApprovalRequest } from "../src/agent/approvalBroker";
import type { ClarificationRequest } from "../src/agent/clarificationBroker";
import {
  renderChatApprovalCard,
  renderChatFollowupsCard,
  renderClarificationCard,
} from "../src/ui/chatAttentionCards";
import {
  CHAT_ATTENTION_CARD_ORDER,
  clearAllChatAttentionCards,
  clearChatAttentionCard,
  findChatAttentionCard,
  listChatAttentionKeys,
  upsertChatAttentionCard,
} from "../src/ui/chatAttentionStack";
import {
  buildMissionReadinessCardModelV1,
  renderMissionReadinessCard,
} from "../src/ui/MissionReadinessCard";

/**
 * Minimal element shim: the standard DOM surface the stack module uses plus
 * the Obsidian helper methods (createDiv/createEl/createSpan/addClass/...)
 * the card renderers rely on. Nothing here is Obsidian-specific beyond the
 * helper names, so the cards are exercised the way the view mounts them.
 */
interface CreateOptions {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
}

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}
  private read(): Set<string> {
    return new Set(this.owner.className.split(/\s+/u).filter(Boolean));
  }
  private write(classes: Set<string>): void {
    this.owner.className = [...classes].join(" ");
  }
  add(...names: string[]): void {
    const classes = this.read();
    for (const name of names) classes.add(name);
    this.write(classes);
  }
  remove(...names: string[]): void {
    const classes = this.read();
    for (const name of names) classes.delete(name);
    this.write(classes);
  }
  contains(name: string): boolean {
    return this.read().has(name);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  className = "";
  ownText = "";
  value = "";
  disabled = false;
  focused = false;
  readonly style: { display: string } = { display: "" };
  readonly classList = new FakeClassList(this);
  readonly ownerDocument: { createElement: (tag: string) => FakeElement };
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly tagName: string) {
    this.ownerDocument = { createElement: (tag) => new FakeElement(tag) };
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  appendChild(child: FakeElement): FakeElement {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child: FakeElement, reference: FakeElement | null): FakeElement {
    child.remove();
    child.parentNode = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  remove(): void {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentNode = null;
  }

  /** Supports the two selector shapes the tests need: `[attr="v"]` and `.cls`. */
  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const attr = selector.match(/^\[([\w-]+)="([^"]*)"\]$/u);
    const cls = selector.match(/^\.([\w-]+)$/u);
    const test = (element: FakeElement): boolean =>
      attr
        ? element.getAttribute(attr[1]) === attr[2]
        : cls
          ? element.classList.contains(cls[1])
          : false;
    const walk = (element: FakeElement) => {
      for (const child of element.children) {
        if (test(child)) matches.push(child);
        walk(child);
      }
    };
    walk(this);
    return matches;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  // Obsidian DOM helpers.
  createEl(tag: string, options: CreateOptions = {}): FakeElement {
    const element = new FakeElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.ownText = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) {
      element.setAttribute(name, value);
    }
    this.appendChild(element);
    return element;
  }
  createDiv(options: CreateOptions = {}): FakeElement {
    return this.createEl("div", options);
  }
  createSpan(options: CreateOptions = {}): FakeElement {
    return this.createEl("span", options);
  }
  addClass(name: string): void {
    this.classList.add(name);
  }
  removeClass(name: string): void {
    this.classList.remove(name);
  }
  hasClass(name: string): boolean {
    return this.classList.contains(name);
  }
  setText(text: string): void {
    this.ownText = text;
  }
  empty(): void {
    for (const child of [...this.children]) child.remove();
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault() {}, ...event });
    }
  }
  focus(): void {
    this.focused = true;
  }
}

function createBanner(): FakeElement {
  const banner = new FakeElement("div");
  banner.className = "agentic-researcher-chat-attention is-hidden";
  banner.setAttribute("data-testid", "chat-attention-banner");
  banner.style.display = "none";
  return banner;
}

function asElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function testId(root: FakeElement, id: string): FakeElement | null {
  return root.querySelector(`[data-testid="${id}"]`);
}

function isHidden(banner: FakeElement): boolean {
  return banner.classList.contains("is-hidden") && banner.style.display === "none";
}

const approvalRequest: ApprovalRequest = {
  id: "approval-1",
  runId: "run-1",
  toolName: "append_to_current_file",
  action: "append",
  reason: "Appends the accepted summary to the active note.",
  policyTags: ["bound_write"],
  expiresAtMs: Date.now() + 60_000,
};

const clarificationRequest: ClarificationRequest = {
  id: "clarification-1",
  runId: "run-1",
  question: "Which note should receive the summary?",
  options: ["Current note", "New note"],
  context: "Two candidate notes matched the title.",
  expiresAtMs: Date.now() + 60_000,
};

test("an approval and a clarification stack instead of clobbering each other", () => {
  const banner = createBanner();
  const decisions: string[] = [];
  renderChatApprovalCard(asElement(banner), approvalRequest, {
    resolve: (decision) => {
      decisions.push(decision);
      return true;
    },
    openRunDetails: () => {},
  });
  assert.equal(isHidden(banner), false);
  assert.ok(testId(banner, "chat-approval-approve"));
  assert.ok(testId(banner, "chat-approval-deny"));

  renderClarificationCard(asElement(banner), clarificationRequest, {
    answer: () => true,
    skip: () => true,
  });

  // Both cards present, each with its own controls, in display order.
  assert.deepEqual(listChatAttentionKeys(asElement(banner)), [
    "approval",
    "clarification",
  ]);
  assert.ok(testId(banner, "chat-approval-approve"));
  assert.ok(testId(banner, "chat-approval-deny"));
  assert.ok(testId(banner, "clarification-option-0"));
  assert.ok(testId(banner, "clarification-option-1"));
  assert.ok(testId(banner, "clarification-answer"));
  assert.ok(testId(banner, "clarification-send"));
  assert.ok(testId(banner, "clarification-skip"));

  // The clarification card, not the banner, carries the is-clarification class.
  const clarificationCard = findChatAttentionCard(asElement(banner), "clarification");
  assert.ok(clarificationCard);
  assert.equal(
    (clarificationCard as unknown as FakeElement).classList.contains("is-clarification"),
    true,
  );
  assert.equal(banner.classList.contains("is-clarification"), false);
  assert.equal(decisions.length, 0);
});

test("clearing the clarification leaves the approval; clearing all hides the banner", () => {
  const banner = createBanner();
  renderChatApprovalCard(asElement(banner), approvalRequest, {
    resolve: () => true,
    openRunDetails: () => {},
  });
  renderClarificationCard(asElement(banner), clarificationRequest, {
    answer: () => true,
    skip: () => true,
  });

  assert.equal(clearChatAttentionCard(asElement(banner), "clarification"), true);
  assert.deepEqual(listChatAttentionKeys(asElement(banner)), ["approval"]);
  assert.ok(testId(banner, "chat-approval-approve"));
  assert.equal(testId(banner, "clarification-answer"), null);
  assert.equal(isHidden(banner), false);

  // Clearing a key that is not rendered is a no-op and does not hide the banner.
  assert.equal(clearChatAttentionCard(asElement(banner), "blocked"), false);
  assert.equal(isHidden(banner), false);

  clearAllChatAttentionCards(asElement(banner));
  assert.deepEqual(listChatAttentionKeys(asElement(banner)), []);
  assert.equal(banner.children.length, 0);
  assert.equal(isHidden(banner), true);
});

test("answering a clarification settles only its own card", () => {
  const banner = createBanner();
  renderChatApprovalCard(asElement(banner), approvalRequest, {
    resolve: () => true,
    openRunDetails: () => {},
  });
  const answers: string[] = [];
  renderClarificationCard(asElement(banner), clarificationRequest, {
    answer: (value) => {
      answers.push(value);
      return true;
    },
    skip: () => true,
  });

  testId(banner, "clarification-option-1")?.dispatch("click");
  assert.deepEqual(answers, ["New note"]);
  assert.deepEqual(listChatAttentionKeys(asElement(banner)), ["approval"]);
  assert.equal(isHidden(banner), false);

  // Approving from the chat card clears the approval card and, being the
  // last card, hides the banner.
  const approve = testId(banner, "chat-approval-approve");
  assert.ok(approve);
  approve.dispatch("click");
  assert.equal(approve.disabled, true);
  assert.deepEqual(listChatAttentionKeys(asElement(banner)), []);
  assert.equal(isHidden(banner), true);
});

test("a refused decision keeps the card so the user can retry", () => {
  const banner = createBanner();
  renderChatApprovalCard(asElement(banner), approvalRequest, {
    resolve: () => false,
    openRunDetails: () => {},
  });
  testId(banner, "chat-approval-deny")?.dispatch("click");
  assert.deepEqual(listChatAttentionKeys(asElement(banner)), ["approval"]);
  assert.equal(testId(banner, "chat-approval-deny")?.disabled, false);
});

test("cards keep display order regardless of arrival order and re-render in place", () => {
  const banner = createBanner();
  const bannerEl = asElement(banner);
  upsertChatAttentionCard(bannerEl, "followups");
  upsertChatAttentionCard(bannerEl, "clarification").setText("q1");
  upsertChatAttentionCard(bannerEl, "readiness");
  upsertChatAttentionCard(bannerEl, "approval");
  upsertChatAttentionCard(bannerEl, "blocked");
  assert.deepEqual(listChatAttentionKeys(bannerEl), [...CHAT_ATTENTION_CARD_ORDER]);

  // Re-rendering a key replaces its card without moving the others.
  upsertChatAttentionCard(bannerEl, "clarification").setText("q2");
  assert.deepEqual(listChatAttentionKeys(bannerEl), [...CHAT_ATTENTION_CARD_ORDER]);
  assert.equal(findChatAttentionCard(bannerEl, "clarification")?.textContent, "q2");
  assert.equal(banner.children.length, CHAT_ATTENTION_CARD_ORDER.length);
});

test("the readiness card occupies the readiness slot with its pinned selectors", () => {
  const banner = createBanner();
  const model = buildMissionReadinessCardModelV1({
    ok: false,
    compound: true,
    primary: {
      id: "linear",
      label: "Linear",
      status: "missing",
      reason: "No Linear API key is configured.",
      nextAction: "Add a Linear API key in settings.",
      setupTarget: "linear",
    },
    missing: [
      {
        id: "linear",
        label: "Linear",
        status: "missing",
        reason: "No Linear API key is configured.",
        nextAction: "Add a Linear API key in settings.",
        setupTarget: "linear",
      },
      {
        id: "github",
        label: "GitHub",
        status: "missing",
        reason: "No GitHub credential is configured.",
        nextAction: "Add a GitHub token in settings.",
        setupTarget: "github",
      },
    ],
  } as unknown as Parameters<typeof buildMissionReadinessCardModelV1>[0]);
  assert.ok(model);
  const targets: string[] = [];
  renderChatApprovalCard(asElement(banner), approvalRequest, {
    resolve: () => true,
    openRunDetails: () => {},
  });
  const card = renderMissionReadinessCard(asElement(banner), model, {
    onSetupAndResume: (target) => targets.push(String(target)),
  });
  assert.equal(
    (card as unknown as FakeElement).classList.contains(
      "agentic-researcher-mission-readiness-card",
    ),
    true,
  );
  assert.deepEqual(listChatAttentionKeys(asElement(banner)), [
    "readiness",
    "approval",
  ]);
  assert.ok(testId(banner, "chat-mission-readiness-missing"));
  assert.ok(testId(banner, "chat-mission-readiness-fix-github"));
  assert.ok(testId(banner, "chat-mission-readiness-setup-resume"));
  assert.ok(testId(banner, "chat-approval-approve"));
  testId(banner, "chat-mission-readiness-setup-resume")?.dispatch("click");
  assert.deepEqual(targets, ["linear"]);
});

test("AgentView clears by key on the settle paths and clears everything only with the run", () => {
  const viewSource = readFileSync(
    new URL("../src/AgentView.ts", import.meta.url),
    "utf8",
  );
  // The banner is a container: no renderer may wipe it wholesale.
  assert.doesNotMatch(viewSource, /banner\.empty\(\)/u);
  assert.doesNotMatch(viewSource, /chatAttentionEl\.empty\(\)/u);
  assert.match(viewSource, /upsertChatAttentionCard\(banner, "blocked"\)/u);
  assert.match(viewSource, /this\.clearChatAttentionCard\("approval"\)/u);
  assert.match(viewSource, /this\.clearChatAttentionCard\("blocked"\)/u);
  assert.match(viewSource, /this\.clearChatAttentionCard\("readiness"\)/u);
  // Run completion and chat clearing still drop every card.
  assert.match(
    viewSource,
    /this\.refreshContinuationSuppressionCopy\(\);\s*this\.clearChatAttention\(\);/u,
  );
  const readinessSource = readFileSync(
    new URL("../src/ui/MissionReadinessCard.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(readinessSource, /banner\.empty\(\)/u);
  assert.match(readinessSource, /upsertChatAttentionCard\(banner, "readiness"\)/u);
  // A new submission drops last run's next-step chips before anything else.
  assert.match(viewSource, /this\.clearChatAttentionCard\("followups"\)/u);
});

test("next-step chips sit last, submit their fixed prompt on click, and clear themselves", () => {
  const banner = createBanner();
  renderClarificationCard(asElement(banner), clarificationRequest, {
    answer: () => true,
    skip: () => true,
  });
  const submitted: string[] = [];
  const card = renderChatFollowupsCard(
    asElement(banner),
    [
      {
        id: "link_related_notes",
        label: "Link this note to related notes",
        prompt: "Find the notes most related to Notes/Plan.md and append wiki-links.",
      },
      {
        id: "draft_linear_issue",
        label: "Draft a Linear issue from this note",
        prompt: "Draft a Linear issue from the note Notes/Plan.md.",
      },
    ],
    { submit: (prompt) => submitted.push(prompt) },
  );
  assert.ok(card);
  assert.equal(CHAT_ATTENTION_CARD_ORDER[CHAT_ATTENTION_CARD_ORDER.length - 1], "followups");
  assert.deepEqual(listChatAttentionKeys(asElement(banner)), [
    "clarification",
    "followups",
  ]);
  const chip = testId(banner, "chat-followup-chip-1");
  assert.ok(chip);
  // The full prompt is readable before the click.
  assert.equal(chip?.getAttribute("title"), "Draft a Linear issue from the note Notes/Plan.md.");
  chip?.dispatch("click");
  assert.deepEqual(submitted, ["Draft a Linear issue from the note Notes/Plan.md."]);
  // The chips are gone; the unrelated clarification card still stands.
  assert.equal(findChatAttentionCard(asElement(banner), "followups"), null);
  assert.deepEqual(listChatAttentionKeys(asElement(banner)), ["clarification"]);

  // Dismiss clears without submitting anything.
  renderChatFollowupsCard(
    asElement(banner),
    [{ id: "link_related_notes", label: "Link", prompt: "p" }],
    { submit: (prompt) => submitted.push(prompt) },
  );
  testId(banner, "chat-followups-dismiss")?.dispatch("click");
  assert.deepEqual(submitted, ["Draft a Linear issue from the note Notes/Plan.md."]);
  assert.equal(findChatAttentionCard(asElement(banner), "followups"), null);
  // An empty plan renders nothing and clears any stale card.
  assert.equal(
    renderChatFollowupsCard(asElement(banner), [], { submit: () => {} }),
    null,
  );
});
