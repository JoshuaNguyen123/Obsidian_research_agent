/**
 * Chat attention stack — the keyed cards inside the chat attention banner.
 *
 * The banner (`data-testid="chat-attention-banner"`) used to be one slot that
 * four renderers each `empty()`-ed before drawing: a clarifying question that
 * arrived while a blocker was showing destroyed the blocker, and an approval
 * request wiped a readiness card the user had not acted on yet. The banner is
 * now a container of cards keyed by `data-attention-key`; each renderer
 * replaces only its own card and each clear path removes only its own key.
 * The banner is hidden exactly when it holds no cards.
 *
 * Standard DOM only (no Obsidian helpers) so the stack is unit-testable in
 * Node against a minimal element shim.
 */

export type ChatAttentionKey =
  | "readiness"
  | "blocked"
  | "approval"
  | "clarification"
  | "followups";

/**
 * Display order, top to bottom. Pre-run gates first, live prompts next, and
 * the post-run "next, I could" chips last because they never block anything.
 */
export const CHAT_ATTENTION_CARD_ORDER: readonly ChatAttentionKey[] = [
  "readiness",
  "blocked",
  "approval",
  "clarification",
  "followups",
];

export const CHAT_ATTENTION_CARD_CLASS = "agentic-researcher-chat-attention-card";
export const CHAT_ATTENTION_KEY_ATTRIBUTE = "data-attention-key";

function isChatAttentionKey(value: string | null): value is ChatAttentionKey {
  return (
    value !== null &&
    (CHAT_ATTENTION_CARD_ORDER as readonly string[]).includes(value)
  );
}

function listChatAttentionCards(banner: HTMLElement): HTMLElement[] {
  return Array.from(banner.children).filter((child): child is HTMLElement =>
    isChatAttentionKey(child.getAttribute(CHAT_ATTENTION_KEY_ATTRIBUTE)),
  );
}

export function findChatAttentionCard(
  banner: HTMLElement,
  key: ChatAttentionKey,
): HTMLElement | null {
  return (
    listChatAttentionCards(banner).find(
      (card) => card.getAttribute(CHAT_ATTENTION_KEY_ATTRIBUTE) === key,
    ) ?? null
  );
}

/** Keys currently rendered, in display order. */
export function listChatAttentionKeys(banner: HTMLElement): ChatAttentionKey[] {
  return listChatAttentionCards(banner).map(
    (card) => card.getAttribute(CHAT_ATTENTION_KEY_ATTRIBUTE) as ChatAttentionKey,
  );
}

function showBanner(banner: HTMLElement): void {
  banner.classList.remove("is-hidden");
  banner.style.display = "";
}

function hideBanner(banner: HTMLElement): void {
  banner.classList.add("is-hidden");
  banner.style.display = "none";
}

/**
 * Returns a fresh, empty card for `key`, replacing any existing card with the
 * same key in place of its ordered slot, and reveals the banner. Other cards
 * are left untouched.
 */
export function upsertChatAttentionCard(
  banner: HTMLElement,
  key: ChatAttentionKey,
): HTMLElement {
  findChatAttentionCard(banner, key)?.remove();
  const card = banner.ownerDocument.createElement("div");
  card.className = CHAT_ATTENTION_CARD_CLASS;
  card.setAttribute(CHAT_ATTENTION_KEY_ATTRIBUTE, key);
  const rank = CHAT_ATTENTION_CARD_ORDER.indexOf(key);
  const nextCard =
    listChatAttentionCards(banner).find(
      (existing) =>
        CHAT_ATTENTION_CARD_ORDER.indexOf(
          existing.getAttribute(CHAT_ATTENTION_KEY_ATTRIBUTE) as ChatAttentionKey,
        ) > rank,
    ) ?? null;
  banner.insertBefore(card, nextCard);
  showBanner(banner);
  return card;
}

/**
 * Removes the card for `key` if present; hides the banner when that was the
 * last card. Returns whether a card was removed.
 */
export function clearChatAttentionCard(
  banner: HTMLElement,
  key: ChatAttentionKey,
): boolean {
  const card = findChatAttentionCard(banner, key);
  if (!card) {
    return false;
  }
  card.remove();
  if (listChatAttentionCards(banner).length === 0) {
    hideBanner(banner);
  }
  return true;
}

/** Removes every card (and any stray child) and hides the banner. */
export function clearAllChatAttentionCards(banner: HTMLElement): void {
  for (const child of Array.from(banner.children)) {
    child.remove();
  }
  hideBanner(banner);
}
