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

/**
 * The mission plan and the callable frontier are projected by different code,
 * and mid-stage they disagree: the plan names the tool the plan wants next,
 * while the frontier emits schemas for the tools the graph will actually
 * accept. A header reading "Next action: run_code_block" against a frontier
 * offering only append_to_current_file is a standing contradiction with no
 * resolution available to the model, and it burns reasoning turns on
 * reconciling the two rather than acting.
 *
 * Callers that know the frontier pass its tool names here. The plan's own
 * preference is then stated only when the frontier can honour it; otherwise
 * the line is replaced by one that names the frontier as authoritative. The
 * set must come from the same array that produced the tool schemas for this
 * step, so the two projections cannot drift apart again.
 */
function describeNextActionTool(
  toolName: string | undefined,
  callableToolNames: ReadonlySet<string> | undefined,
): { callable: boolean; toolName: string | undefined } {
  if (!toolName || !callableToolNames) {
    return { callable: true, toolName };
  }
  return callableToolNames.has(toolName)
    ? { callable: true, toolName }
    : { callable: false, toolName };
}

export function formatMissionPlanForPrompt(
  plan: MissionPlan | null | undefined,
  callableToolNames?: ReadonlySet<string>,
): string {
  if (!plan) {
    return "";
  }
  const active = getActiveMissionPlanTask(plan);
  const next = getNextMissionPlanAction(plan);
  const nextTool = describeNextActionTool(next?.toolName, callableToolNames);
  const nextActionLine = !next
    ? "Next action: none"
    : nextTool.callable
      ? `Next action: ${next.kind}${next.toolName ? ` ${next.toolName}` : ""} - ${next.summary}`
      : `Next action: ${next.kind} - ${next.summary} (the plan's preferred tool ${nextTool.toolName} is not on the current frontier; use the offered tools instead)`;
  return [
    `${MISSION_PLAN_PROMPT_MARKER} is active. Use it as transient execution state only.`,
    `Status: ${plan.status}`,
    `Active task: ${active ? `${active.id} - ${active.title}` : "none"}`,
    `Remaining tasks: ${countRemainingMissionPlanTasks(plan)}`,
    `Progress score: ${plan.progress.score}`,
    nextActionLine,
    "Do not quote or persist this mission-plan text in chat history.",
  ].join("\n");
}

export function formatMissionPlanNextActionPrompt(
  plan: MissionPlan | null | undefined,
  callableToolNames?: ReadonlySet<string>,
): string {
  const next = getNextMissionPlanAction(plan);
  if (!next) {
    return "No mission-plan next action is available; synthesize only if required proof is complete.";
  }
  const nextTool = describeNextActionTool(next.toolName, callableToolNames);
  return [
    "Continue the active mission-plan task.",
    `Action: ${next.kind}`,
    nextTool.callable
      ? next.toolName
        ? `Preferred tool: ${next.toolName}`
        : ""
      : `The plan prefers ${nextTool.toolName}, which the current frontier does not offer. The offered tools are authoritative; advance the task with one of them rather than waiting for ${nextTool.toolName}.`,
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
