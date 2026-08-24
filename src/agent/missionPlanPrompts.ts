import {
  countRemainingMissionPlanTasks,
  getActiveMissionPlanTask,
  getNextMissionPlanAction,
  type MissionPlan,
} from "./missionPlan";

/**
 * Stable first-line prefix of the rendered mission-plan system message. The
 * runner uses it to find and re-render that message each step: the block was
 * rendered once at run start and persisted verbatim while missionPlan was
 * reassigned throughout the run, so the prompt said "Active task:
 * tool-01-read_template / Next action: verify" while the live stage prompt
 * said stage=code_validation — a standing contradiction the model burned
 * turns trying to reconcile.
 */
export const MISSION_PLAN_PROMPT_MARKER = "Mission Plan v1";

export function formatMissionPlanForPrompt(plan: MissionPlan | null | undefined): string {
  if (!plan) {
    return "";
  }
  const active = getActiveMissionPlanTask(plan);
  const next = getNextMissionPlanAction(plan);
  return [
    `${MISSION_PLAN_PROMPT_MARKER} is active. Use it as transient execution state only.`,
    `Status: ${plan.status}`,
    `Active task: ${active ? `${active.id} - ${active.title}` : "none"}`,
    `Remaining tasks: ${countRemainingMissionPlanTasks(plan)}`,
    `Progress score: ${plan.progress.score}`,
    next ? `Next action: ${next.kind}${next.toolName ? ` ${next.toolName}` : ""} - ${next.summary}` : "Next action: none",
    "Do not quote or persist this mission-plan text in chat history.",
  ].join("\n");
}

export function formatMissionPlanNextActionPrompt(
  plan: MissionPlan | null | undefined,
): string {
  const next = getNextMissionPlanAction(plan);
  if (!next) {
    return "No mission-plan next action is available; synthesize only if required proof is complete.";
  }
  return [
    "Continue the active mission-plan task.",
    `Action: ${next.kind}`,
    next.toolName ? `Preferred tool: ${next.toolName}` : "",
    `Reason: ${next.summary}`,
    "Request only tools that are available and appropriate for the current mission.",
  ].filter(Boolean).join("\n");
}

export function formatMissionPlanResumePrompt(
  plan: MissionPlan | null | undefined,
  ledgerPath: string,
): string {
  if (!plan) {
    return "";
  }
  return [
    "Resume from the mission plan below.",
    `Ledger path: ${ledgerPath}`,
    formatMissionPlanForPrompt(plan),
  ].join("\n");
}
