import {
  readLatestMissionLedger,
  readMissionLedgerByRunId,
  type MissionLedger,
} from "./missionLedger";
import type { ToolExecutionContext } from "../tools/types";

export interface MissionResumeContext {
  path: string;
  ledger: MissionLedger;
  promptContext: string;
}

export function hasMissionResumeIntent(prompt: string): boolean {
  return /\b(continue|resume|keep going|carry on)\b/i.test(prompt);
}

export function extractRequestedRunId(prompt: string): string | null {
  return (
    /\b(?:continue|resume|keep going|carry on)\s+run\s+([A-Za-z0-9._:-]+)/i.exec(
      prompt,
    )?.[1] ?? null
  );
}

export async function buildMissionResumeContext({
  prompt,
  activeIntentPrompt,
  toolContext,
}: {
  prompt: string;
  activeIntentPrompt: string;
  toolContext: ToolExecutionContext;
}): Promise<MissionResumeContext | null> {
  if (!hasMissionResumeIntent(prompt) && !hasMissionResumeIntent(activeIntentPrompt)) {
    return null;
  }

  const requestedRunId =
    extractRequestedRunId(prompt) ?? extractRequestedRunId(activeIntentPrompt);
  const loaded =
    requestedRunId !== null
      ? await readMissionLedgerByRunId(toolContext, requestedRunId)
      : await readLatestMissionLedger(toolContext);

  if (!loaded) {
    return null;
  }

  return {
    path: loaded.path,
    ledger: loaded.ledger,
    promptContext: formatLedgerForModel(loaded.ledger, loaded.path),
  };
}

export function formatLedgerForModel(
  ledger: MissionLedger,
  path = `Agent Runs/${ledger.runId}.md`,
): string {
  const incomplete = ledger.tasks.filter((task) => task.status !== "complete");
  const evidence = ledger.evidence.slice(0, 12).map((item) => {
    const locator = item.path ?? item.url ?? item.id;
    return `${item.title} (${item.kind}; ${locator}): ${item.summary}`;
  });

  return [
    "Structured Agent Runs mission ledger for resume context.",
    "Use this ledger only if it matches the user's requested continuation.",
    "Do not persist this ledger text into chat history.",
    `Ledger path: ${path}`,
    `Run id: ${ledger.runId}`,
    `Mission: ${ledger.mission}`,
    `Status: ${ledger.status}`,
    `Route: ${ledger.route}`,
    `Expected tools: ${ledger.loopBudget.expectedTools.join(", ") || "none"}`,
    `Incomplete tasks: ${incomplete.map((task) => task.title).join("; ") || "none"}`,
    `Blockers: ${ledger.blockers.join("; ") || "none"}`,
    `Next actions: ${ledger.nextActions.join("; ") || "none"}`,
    "Evidence:",
    evidence.length > 0 ? evidence.join("\n") : "none",
  ].join("\n");
}
