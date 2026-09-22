/**
 * Chat attention cards that need no view state: the approval prompt and the
 * clarifying question. Each renders into its own keyed card in the attention
 * stack and clears only that card when settled, so a question arriving while
 * an approval waits leaves the approval standing (and vice versa).
 *
 * Kept free of Obsidian imports (the DOM helpers come from Obsidian's global
 * augmentation) so the cards are unit-testable in Node.
 */

import type { ApprovalRequest } from "../agent/approvalBroker";
import type { CompletionFollowupV1 } from "../agent/autoFollowups";
import type { ClarificationRequest } from "../agent/clarificationBroker";
import { formatApprovalCardModelV1 } from "./approvalCardModel";
import { chatApprovalAttentionTitle } from "./agentViewCopy";
import {
  clearChatAttentionCard,
  upsertChatAttentionCard,
} from "./chatAttentionStack";

export interface ChatApprovalCardHandlersV1 {
  /** Returns whether the broker accepted the decision. */
  resolve: (decision: "approved" | "denied") => boolean;
  openRunDetails: () => void;
}

export function renderChatApprovalCard(
  banner: HTMLElement,
  request: ApprovalRequest,
  handlers: ChatApprovalCardHandlersV1,
): HTMLElement {
  const card = upsertChatAttentionCard(banner, "approval");
  card.createDiv({
    text: chatApprovalAttentionTitle(request.toolName),
    cls: "agentic-researcher-chat-attention-title",
  });
  card.createDiv({
    text: request.reason,
    cls: "agentic-researcher-chat-attention-body",
  });
  // The chat card offers the same Approve/Deny authority as the Run Details
  // card, so it owes the user the same minimum context: WHERE the mutation
  // is going. Title and reason alone let a user approve an outbound write
  // without ever seeing its destination.
  const attentionModel = formatApprovalCardModelV1(request);
  if (attentionModel.preview?.destination) {
    card.createDiv({
      text: attentionModel.preview.destination,
      cls: "agentic-researcher-chat-attention-body",
      attr: { "data-testid": "chat-approval-destination" },
    });
  }
  const controls = card.createDiv({
    cls: "agentic-researcher-chat-attention-controls",
  });
  const approveButton = controls.createEl("button", {
    text: "Approve",
    cls: "agentic-researcher-secondary-action",
    attr: { type: "button", "data-testid": "chat-approval-approve" },
  });
  const denyButton = controls.createEl("button", {
    text: "Deny",
    cls: "agentic-researcher-secondary-action",
    attr: { type: "button", "data-testid": "chat-approval-deny" },
  });
  const openDetails = controls.createEl("button", {
    text: "Open Run Details",
    cls: "agentic-researcher-secondary-action",
    attr: { type: "button" },
  });
  const resolve = (decision: "approved" | "denied") => {
    if (!handlers.resolve(decision)) return;
    approveButton.disabled = true;
    denyButton.disabled = true;
    clearChatAttentionCard(banner, "approval");
  };
  approveButton.addEventListener("click", (event) => {
    event.preventDefault();
    resolve("approved");
  });
  denyButton.addEventListener("click", (event) => {
    event.preventDefault();
    resolve("denied");
  });
  openDetails.addEventListener("click", (event) => {
    event.preventDefault();
    handlers.openRunDetails();
  });
  return card;
}

export interface ClarificationCardHandlersV1 {
  /** Returns whether the broker accepted the answer. */
  answer: (value: string) => boolean;
  /** Returns whether the broker accepted the skip. */
  skip: () => boolean;
}

/**
 * The agent is unsure and asked one question. Rendered inline in chat with
 * one-click suggested answers plus a free-text box, so answering is a single
 * gesture and the transcript keeps the exchange.
 */
export function renderClarificationCard(
  banner: HTMLElement,
  request: ClarificationRequest,
  handlers: ClarificationCardHandlersV1,
): HTMLElement {
  const card = upsertChatAttentionCard(banner, "clarification");
  card.addClass("is-clarification");
  card.createDiv({
    text: request.question,
    cls: "agentic-researcher-chat-attention-title",
  });
  if (request.context) {
    card.createDiv({
      text: request.context,
      cls: "agentic-researcher-chat-attention-body",
    });
  }

  const controls = card.createDiv({
    cls: "agentic-researcher-chat-attention-controls",
  });
  const settle = (run: () => boolean) => {
    if (!run()) return;
    clearChatAttentionCard(banner, "clarification");
  };

  for (const [index, option] of request.options.entries()) {
    const chip = controls.createEl("button", {
      text: option,
      cls: "agentic-researcher-secondary-action agentic-researcher-clarification-chip",
      attr: {
        type: "button",
        "data-testid": `clarification-option-${index}`,
      },
    });
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      settle(() => handlers.answer(option));
    });
  }

  const freeForm = card.createDiv({
    cls: "agentic-researcher-clarification-input",
  });
  const input = freeForm.createEl("input", {
    attr: {
      type: "text",
      placeholder: "Type an answer…",
      "data-testid": "clarification-answer",
    },
  });
  const submit = () => {
    const value = input.value.trim();
    if (!value) return;
    settle(() => handlers.answer(value));
  };
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submit();
  });
  const sendButton = freeForm.createEl("button", {
    text: "Send",
    cls: "agentic-researcher-secondary-action",
    attr: { type: "button", "data-testid": "clarification-send" },
  });
  sendButton.addEventListener("click", (event) => {
    event.preventDefault();
    submit();
  });
  const skipButton = freeForm.createEl("button", {
    text: "Skip",
    cls: "agentic-researcher-secondary-action",
    attr: { type: "button", "data-testid": "clarification-skip" },
  });
  skipButton.addEventListener("click", (event) => {
    event.preventDefault();
    settle(() => handlers.skip());
  });
  input.focus();
  return card;
}

export interface ChatFollowupsCardHandlersV1 {
  /** Submits the chip's fixed prompt through the ordinary composer path. */
  submit: (prompt: string) => void;
}

/**
 * The mission finished and the host has concrete next steps. Chips only: a
 * click submits a real mission the user can read first (the full prompt is
 * the chip's tooltip); nothing runs on its own and no authority is granted.
 */
export function renderChatFollowupsCard(
  banner: HTMLElement,
  followups: readonly CompletionFollowupV1[],
  handlers: ChatFollowupsCardHandlersV1,
): HTMLElement | null {
  if (followups.length === 0) {
    clearChatAttentionCard(banner, "followups");
    return null;
  }
  const card = upsertChatAttentionCard(banner, "followups");
  card.addClass("is-followups");
  card.setAttribute("data-testid", "chat-followups");
  card.createDiv({
    text: "Next, I could:",
    cls: "agentic-researcher-chat-attention-title",
  });
  const controls = card.createDiv({
    cls: "agentic-researcher-chat-attention-controls",
  });
  for (const [index, followup] of followups.entries()) {
    const chip = controls.createEl("button", {
      text: followup.label,
      cls: "agentic-researcher-secondary-action agentic-researcher-clarification-chip",
      attr: {
        type: "button",
        title: followup.prompt,
        "data-testid": `chat-followup-chip-${index}`,
        "data-followup-id": followup.id,
      },
    });
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      clearChatAttentionCard(banner, "followups");
      handlers.submit(followup.prompt);
    });
  }
  const dismiss = controls.createEl("button", {
    text: "Dismiss",
    cls: "agentic-researcher-secondary-action",
    attr: { type: "button", "data-testid": "chat-followups-dismiss" },
  });
  dismiss.addEventListener("click", (event) => {
    event.preventDefault();
    clearChatAttentionCard(banner, "followups");
  });
  return card;
}
