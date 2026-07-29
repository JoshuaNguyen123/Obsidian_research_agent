import type { CapabilitySetupTarget } from "../agent/capabilitySetup";
import type {
  MissionReadinessMissingItemV1,
  MissionReadinessPreflightV1,
} from "../agent/missionReadinessPreflight";
import { missionReadinessMissingSummaries } from "../agent/missionReadinessPreflight";

export interface MissionReadinessCardMissingItemV1 {
  id: string;
  label: string;
  nextAction: string;
  setupTarget: CapabilitySetupTarget;
}

export interface MissionReadinessCardModelV1 {
  title: string;
  what: string;
  why: string;
  next: string;
  missingLabels: string[];
  /**
   * Every missing check with its own setup target, so the card can offer a
   * fix per item. One primary CTA alone forces a fix → resubmit → discover
   * the next blocker loop when several capabilities are missing at once.
   */
  missingItems: MissionReadinessCardMissingItemV1[];
  primarySetupTarget: CapabilitySetupTarget;
  primaryNextAction: string;
  chatLine: string;
  actionLabel: string;
}

export function missionReadinessCardTitle(): string {
  return "End-to-end workflow setup required";
}

export function missionReadinessCardActionLabel(): string {
  return "Set up & resume";
}

export function missionReadinessChatLine(missingSummaries: string[]): string {
  const detail =
    missingSummaries.length > 0
      ? missingSummaries.slice(0, 4).join("; ")
      : "Required integrations are not ready.";
  return `End-to-end mission blocked: ${detail}`;
}

/**
 * Builds the single Chat attention card model for a failed compound preflight.
 */
export function buildMissionReadinessCardModelV1(
  preflight: MissionReadinessPreflightV1,
): MissionReadinessCardModelV1 | null {
  if (preflight.ok || !preflight.compound || !preflight.primary) {
    return null;
  }
  const missing = preflight.missing;
  const primary = preflight.primary;
  const labels = missing.map((item) => item.label);
  return {
    title: missionReadinessCardTitle(),
    what: `End-to-end workflow needs ${labels.join(", ")} setup.`,
    why: primary.reason,
    next: primary.nextAction,
    missingLabels: labels,
    missingItems: missing.map((item) => ({
      id: item.id,
      label: item.label,
      nextAction: item.nextAction,
      setupTarget: item.setupTarget,
    })),
    primarySetupTarget: primary.setupTarget,
    primaryNextAction: primary.nextAction,
    chatLine: missionReadinessChatLine(missionReadinessMissingSummaries(missing)),
    actionLabel: missionReadinessCardActionLabel(),
  };
}

export interface MissionReadinessCardHandlersV1 {
  onSetupAndResume: (setupTarget: CapabilitySetupTarget) => void;
}

/**
 * Renders one attention card: missing items list + single Set up & resume CTA.
 */
export function renderMissionReadinessCard(
  banner: HTMLElement,
  model: MissionReadinessCardModelV1,
  handlers: MissionReadinessCardHandlersV1,
): void {
  banner.empty();
  banner.removeClass("is-hidden");
  banner.show();
  banner.createDiv({
    text: model.title,
    cls: "agentic-researcher-chat-attention-title",
  });
  banner.createDiv({
    text: `What: ${model.what}`,
    cls: "agentic-researcher-chat-attention-body",
  });
  if (model.missingItems.length > 1) {
    const missingList = banner.createDiv({
      cls: "agentic-researcher-chat-attention-body",
      attr: { "data-testid": "chat-mission-readiness-missing" },
    });
    // One fix button per distinct settings destination. The primary target is
    // covered by the main CTA below, so its row stays label-only.
    const offeredTargets = new Set<CapabilitySetupTarget>([
      model.primarySetupTarget,
    ]);
    for (const item of model.missingItems) {
      const row = missingList.createDiv({
        cls: "agentic-researcher-chat-attention-missing-row",
      });
      row.createSpan({ text: `${item.label}: ${item.nextAction}` });
      if (offeredTargets.has(item.setupTarget)) continue;
      offeredTargets.add(item.setupTarget);
      const fixButton = row.createEl("button", {
        text: "Fix",
        cls: "agentic-researcher-secondary-action",
        attr: {
          type: "button",
          "data-testid": `chat-mission-readiness-fix-${item.id}`,
        },
      });
      fixButton.addEventListener("click", (event) => {
        event.preventDefault();
        handlers.onSetupAndResume(item.setupTarget);
      });
    }
  }
  banner.createDiv({
    text: `Why: ${model.why}`,
    cls: "agentic-researcher-chat-attention-body",
  });
  banner.createDiv({
    text: `Next: ${model.next}`,
    cls: "agentic-researcher-chat-attention-body",
  });
  const controls = banner.createDiv({
    cls: "agentic-researcher-chat-attention-controls",
  });
  const setupButton = controls.createEl("button", {
    text: model.actionLabel,
    cls: "agentic-researcher-secondary-action",
    attr: {
      type: "button",
      "data-testid": "chat-mission-readiness-setup-resume",
    },
  });
  setupButton.addEventListener("click", (event) => {
    event.preventDefault();
    handlers.onSetupAndResume(model.primarySetupTarget);
  });
}

/** Test helper: summarize missing items for assertions without DOM. */
export function formatMissionReadinessMissingLine(
  missing: readonly MissionReadinessMissingItemV1[],
): string {
  return missing.map((item) => item.label).join(" · ");
}
