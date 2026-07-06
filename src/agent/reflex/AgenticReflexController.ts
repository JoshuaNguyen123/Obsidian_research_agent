import { scoreCandidateActions } from "./actionScorer";
import { evaluateCompletion } from "./completionEvaluator";
import { classifyIntent } from "./intentRouter";
import { evaluateProgress } from "./progressMonitor";
import type { AgenticReflexInput, AgenticReflexOutput } from "./types";

export class AgenticReflexController {
  async evaluate(input: AgenticReflexInput): Promise<AgenticReflexOutput> {
    const intent = await classifyIntent(input);
    const actionScores = scoreCandidateActions(input, intent);
    const progress = evaluateProgress(input);
    const completion = evaluateCompletion(input);
    return {
      intent,
      actionScores,
      progress,
      completion,
      diagnostics: {
        enabled: input.settings?.agenticReflexEnabled === true,
        topAction: actionScores[0]?.action.toolName ?? actionScores[0]?.action.kind,
        fallbackReason: intent.label === "unknown" ? intent.reason : undefined,
      },
    };
  }
}
