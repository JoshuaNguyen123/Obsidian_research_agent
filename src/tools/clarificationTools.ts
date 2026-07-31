import { MAX_CLARIFICATION_OPTIONS } from "../agent/clarificationBroker";
import type { AgentTool } from "./types";
import { getOptionalString, getRequiredString } from "./validation";

export function createClarificationTools(): AgentTool[] {
  return [askUserTool];
}

export const ASK_USER_TOOL_NAME = "ask_user";

/**
 * Ask one clarifying question instead of guessing.
 *
 * Only worth spending a turn on when the answer would actually change what the
 * agent does — an ambiguous target, two plausible readings of the request, a
 * missing constraint. The tool is intentionally single-question: a run that
 * needs three answers should ask the most decision-changing one first, act, and
 * ask again if it is still stuck.
 *
 * An unanswered question is not a failure. It returns `answered: false` with an
 * explicit instruction to proceed on the stated assumption, so a user who is
 * away never deadlocks the run.
 */
export const askUserTool: AgentTool = {
  name: ASK_USER_TOOL_NAME,
  description:
    "Ask the user ONE short clarifying question when you are genuinely unsure and the answer would change what you do (ambiguous target, two plausible interpretations, a missing constraint). Offer 2-4 short suggested answers when you can. Do not use it for confirmation of an action (approvals handle that), for questions you can answer by reading the vault or searching, or more than once in a row.",
  parameters: {
    type: "object",
    required: ["question"],
    properties: {
      question: {
        type: "string",
        description: "One specific question, phrased so a short answer resolves it.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: `Up to ${MAX_CLARIFICATION_OPTIONS} short suggested answers shown as one-click replies.`,
      },
      assumption: {
        type: "string",
        description:
          "What you will assume and proceed with if the user does not answer.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const question = getRequiredString(args, "question").trim();
    if (!question) {
      throw new Error("ask_user requires a question.");
    }
    const assumption = getOptionalString(args, "assumption")?.trim() ?? "";
    const options = readOptions(args.options);

    if (typeof context.requestUserClarification !== "function") {
      // No interactive host (headless/e2e): never hang, just proceed.
      return {
        answered: false,
        reason: "no_interactive_user",
        guidance: assumption
          ? `No interactive user is available. Proceed with: ${assumption}`
          : "No interactive user is available. Proceed with your best assumption and state it in the final answer.",
      };
    }

    const outcome = await context.requestUserClarification({
      question,
      options,
      ...(assumption ? { context: `If unanswered: ${assumption}` } : {}),
    });

    if (outcome.status === "answered") {
      return {
        answered: true,
        question,
        answer: outcome.answer,
        guidance:
          "Use this answer as the user's explicit intent. It does not authorize any action that still needs approval.",
      };
    }

    return {
      answered: false,
      question,
      reason: outcome.status,
      guidance: assumption
        ? `The user did not answer (${outcome.status}). Proceed with: ${assumption}`
        : `The user did not answer (${outcome.status}). Proceed with your best assumption and state it in the final answer.`,
    };
  },
};

function readOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const options: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const option = item.replace(/\s+/gu, " ").trim();
    if (option) options.push(option);
    if (options.length >= MAX_CLARIFICATION_OPTIONS) break;
  }
  return options;
}
