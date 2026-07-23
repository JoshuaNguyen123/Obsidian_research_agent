import type { CapabilitySetupTarget } from "../agent/capabilitySetup";
import type {
  MissionReadinessMissingItemV1,
  MissionReadinessPreflightV1,
} from "../agent/missionReadinessPreflight";
import { missionReadinessMissingSummaries } from "../agent/missionReadinessPreflight";

export interface MissionReadinessCardModelV1 {
  title: string;
  what: string;
  why: string;
  next: string;
  missingLabels: string[];
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
  if (model.missingLabels.length > 1) {
    banner.createDiv({
      text: `Missing: ${model.missingLabels.join(" · ")}`,
      cls: "agentic-researcher-chat-attention-body",
      attr: { "data-testid": "chat-mission-readiness-missing" },
    });
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
