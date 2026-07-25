import type {
  ModelChatMessage,
  ModelChatRequest,
  ModelClient,
  ModelToolDefinition,
} from "../model/types";
import type { MissionEvidence } from "../agent/missionLedger";
import type { VerificationCheck } from "../agent/verifiers";
import type { ToolExecutionContext, ToolRegistry } from "../tools/types";
import { appendToolTranscript } from "../model/toolTranscript";
import { serializeToolResultForModel } from "../model/toolResultPayload";

/**
 * Independent model-backed critic for the two-agent research mission.
 *
 * Independence is structural, not prompted:
 * - Its transcript is seeded ONLY with the objective, the Lead's final output,
 *   and evidence/receipt summaries — never the Lead's reasoning transcript.
 * - Its registry is a hard read-only subset (CRITIC_ALLOWED_TOOLS) enforced at
 *   execution, so it can check citations and sources but structurally cannot
 *   write, publish, or approve anything.
 * - It is advisory-first: missionAcceptance remains the SOLE gate on terminal
 *   success. The critic may recommend more work AT MOST ONCE per run (the
 *   caller enforces the cap through leadContinuation); it opens no retry path
 *   of its own, preventing livelock against acceptance/proof-debt.
 */

export const CRITIC_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "read_markdown_files",
  "search_markdown_files",
  "count_words",
  "read_source_section",
  "web_fetch",
  "verify_citation",
]);

const CRITIC_MAX_STEPS = 8;
const CRITIC_MAX_TOOL_CALLS = 8;
const MAX_SEED_EVIDENCE = 24;
const MAX_FINAL_OUTPUT_CHARS = 12_000;
const MAX_MISSING = 12;

export interface CriticWorkerResult {
  status: "pass" | "needs_more_work" | "blocked";
  check: VerificationCheck;
  modelSteps: number;
  toolCalls: number;
}

export async function runCriticWorker(input: {
  runId: string;
  objective: string;
  finalOutput: string;
  evidence: ReadonlyArray<MissionEvidence>;
  receiptIds: ReadonlyArray<string>;
  modelClient: ModelClient;
  toolRegistry: ToolRegistry;
  toolContext: ToolExecutionContext;
  abortSignal?: AbortSignal;
  maxSteps?: number;
  now?: () => Date;
}): Promise<CriticWorkerResult> {
  const now = input.now ?? (() => new Date());
  const registry = createCriticRegistry(input.toolRegistry);
  const maxSteps = Math.min(CRITIC_MAX_STEPS, Math.max(1, input.maxSteps ?? CRITIC_MAX_STEPS));
  const messages: ModelChatMessage[] = [
    {
      role: "system",
      content: [
        "You are an independent critic reviewing a completed research mission.",
        "You did NOT produce this result and must judge it only on the material below plus the read-only tools available.",
        "Check: does the final output answer the objective; is every load-bearing claim supported by the listed evidence; are citations verifiable; is anything important missing or contradicted?",
        "You may use read-only tools to spot-check sources and quotes.",
        'End with a single JSON object on its own line: {"verdict":"pass"|"needs_more_work","missing":["..."],"summary":"..."}.',
        "Be strict about unsupported claims but do not demand work outside the objective.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Objective: ${input.objective}`,
        "",
        `Final output:\n${input.finalOutput.slice(0, MAX_FINAL_OUTPUT_CHARS)}`,
        "",
        `Evidence (${input.evidence.length}):`,
        ...input.evidence
          .slice(0, MAX_SEED_EVIDENCE)
          .map(
            (item) =>
              `- [${item.kind}] ${item.title}${item.url ? ` (${item.url})` : ""}: ${item.summary}`,
          ),
        "",
        `Receipts: ${input.receiptIds.length > 0 ? input.receiptIds.join(", ") : "none"}`,
      ].join("\n"),
    },
  ];

  let modelSteps = 0;
  let toolCalls = 0;
  let verdictText = "";
  try {
    for (let step = 1; step <= maxSteps; step += 1) {
      throwIfAborted(input.abortSignal);
      modelSteps = step;
      const request: ModelChatRequest = {
        messages,
        tools: registry.getDefinitions(),
        abortSignal: input.abortSignal,
      };
      const response = await input.modelClient.chat(request);
      messages.push(response.message);
      if (response.toolCalls.length === 0) {
        verdictText = response.message.content.trim();
        if (verdictText) break;
        messages.push({
          role: "user",
          content: "Return the JSON verdict object now.",
        });
        continue;
      }
      for (const call of response.toolCalls) {
        if (toolCalls >= CRITIC_MAX_TOOL_CALLS) break;
        toolCalls += 1;
        throwIfAborted(input.abortSignal);
        const result = await registry.execute(call, {
          ...input.toolContext,
          runId: `${input.runId}-critic`,
          originalPrompt: input.objective,
          abortSignal: input.abortSignal,
          writeAutonomy: false,
          userApprovalGranted: false,
        });
        appendToolTranscript({
          messages,
          toolCall: call,
          resultContent: serializeToolResultForModel(result),
          origin: "model",
          fallbackId: call.id ?? `critic-tool-${toolCalls}`,
        });
      }
      if (toolCalls >= CRITIC_MAX_TOOL_CALLS) {
        messages.push({
          role: "user",
          content:
            "Tool budget reached. Return the JSON verdict object based on what you verified.",
        });
      }
    }
  } catch (error) {
    return {
      status: "blocked",
      modelSteps,
      toolCalls,
      check: check("blocked", {
        message: `Critic did not complete: ${
          error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
        }`,
        missing: [],
        checkedAt: now().toISOString(),
      }),
    };
  }

  const verdict = parseVerdict(verdictText);
  if (!verdict) {
    // An unusable verdict is advisory noise, never a block: acceptance stays
    // the sole authority, and a malformed critic must not stall the mission.
    return {
      status: "pass",
      modelSteps,
      toolCalls,
      check: check("pass", {
        message:
          "Critic returned no parseable verdict; treating as advisory pass (acceptance remains the gate).",
        missing: [],
        checkedAt: now().toISOString(),
      }),
    };
  }
  return {
    status: verdict.verdict,
    modelSteps,
    toolCalls,
    check: check(verdict.verdict, {
      message: verdict.summary,
      missing: verdict.missing,
      checkedAt: now().toISOString(),
    }),
  };
}

function check(
  status: "pass" | "needs_more_work" | "blocked",
  fields: { message: string; missing: string[]; checkedAt: string },
): VerificationCheck {
  return {
    id: "critic:independent-review",
    kind: "critic",
    status,
    confidence: status === "blocked" ? 0 : 0.8,
    missing: fields.missing,
    evidenceIds: [],
    receiptIds: [],
    message: fields.message,
    checkedAt: fields.checkedAt,
  };
}

function parseVerdict(
  text: string,
): { verdict: "pass" | "needs_more_work"; missing: string[]; summary: string } | null {
  // The verdict is the last JSON object in the reply.
  const matches = text.match(/\{[\s\S]*\}/gu);
  if (!matches) return null;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    try {
      const parsed: unknown = JSON.parse(matches[index]!);
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      const verdict = record.verdict;
      if (verdict !== "pass" && verdict !== "needs_more_work") continue;
      return {
        verdict,
        missing: Array.isArray(record.missing)
          ? record.missing
              .filter((entry): entry is string => typeof entry === "string")
              .slice(0, MAX_MISSING)
              .map((entry) => entry.slice(0, 300))
          : [],
        summary:
          typeof record.summary === "string" && record.summary.trim()
            ? record.summary.trim().slice(0, 1_000)
            : `Critic verdict: ${verdict}.`,
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** Read-only registry hard-restricted to the critic's tool subset. */
export function createCriticRegistry(registry: ToolRegistry): ToolRegistry {
  const definitions = registry
    .getDefinitions()
    .filter((definition) => CRITIC_ALLOWED_TOOLS.has(definition.function.name));
  return {
    getDefinitions(): ModelToolDefinition[] {
      return definitions;
    },
    async execute(call, context) {
      if (!CRITIC_ALLOWED_TOOLS.has(call.name)) {
        return {
          ok: false,
          toolName: call.name,
          error: {
            code: "critic_policy_blocked",
            message: `The critic cannot execute ${call.name}; it is review-only.`,
          },
        };
      }
      return registry.execute(call, {
        ...context,
        writeAutonomy: false,
        userApprovalGranted: false,
      });
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("The critic review was cancelled.");
  }
}
