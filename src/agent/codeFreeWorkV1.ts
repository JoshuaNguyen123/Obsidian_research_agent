import type { ModelToolCall } from "../model/types";
import { DefaultToolRegistry } from "../tools/ToolRegistry";
import type {
  AgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "../tools/types";
import type {
  ActionReconciliationResult,
  AuthorizedActionContext,
  PreparedAction,
  PreparedActionResult,
  ToolDescriptor,
} from "./actions";

/*
 * The free coding loop (CODE-18). A capable model is given one open node,
 * `code_free_work`, whose tools it calls in any order — read, search, edit,
 * check — until it says the work is done after a green targeted validation,
 * or its budget ends. The closing nodes that follow are the guided ladder's
 * own tail, from its first validation on, so the proof does not change.
 */

export type CodeAutonomyV1 = "guided" | "free";

export interface CodeFreeBudgetV1 {
  /** Tool calls the open node may make. */
  toolCalls: number;
  /** Agent turns (model calls) the open node may take. */
  modelCalls: number;
  /** Provider tokens the open node may spend (reported, else estimated). */
  tokens: number;
  /** Wall-clock milliseconds the open node may run. */
  ms: number;
}

export const DEFAULT_CODE_FREE_BUDGET_V1: Readonly<CodeFreeBudgetV1> = Object.freeze({
  toolCalls: 60,
  modelCalls: 80,
  tokens: 3_000_000,
  ms: 30 * 60_000,
});

export const CODE_FREE_BUDGET_LIMITS_V1: Readonly<
  Record<keyof CodeFreeBudgetV1, readonly [number, number]>
> = Object.freeze({
  toolCalls: [4, 400],
  modelCalls: [4, 400],
  tokens: [20_000, 20_000_000],
  ms: [60_000, 4 * 60 * 60_000],
});

export const CODE_FREE_WORK_NODE_ID_V1 = "code_free_work" as const;

export const CODE_PLAN_UPDATE_TOOL_NAME_V1 = "code_plan_update" as const;

export const CODE_PLAN_MAX_ITEMS_V1 = 20;
export const CODE_PLAN_MAX_TEXT_CHARS_V1 = 200;

/**
 * How many times in a row the model may say the open work is done without a
 * passing targeted validation before the open node is handed to its closing
 * steps, which run that validation (RAP CODE2-24). Each time it is told what is
 * owed; a model that keeps answering in prose instead spent 200 turns of a
 * 240-turn budget, so after this many the checks decide instead of the model.
 */
export const CODE_FREE_UNCHECKED_DONE_LIMIT_V1 = 3;

/**
 * A `code_repair_status` read that found no repair record (RAP CODE2-24). The
 * open node writes none: `code_repair_record_cycle` is a closing step, so a
 * status read inside the node always finds nothing, and that is an answer, not
 * a failure for the two-identical-failures rule to count. Beam read it twice
 * after a red check, as the node's own message told it to, and the pass ended
 * on "No durable code repair checkpoint exists".
 */
export function isMissingRepairRecordV1(
  toolName: string,
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (toolName !== "code_repair_status" || !error) return false;
  return error.code === "repair_checkpoint_missing" ||
    /^No durable code repair checkpoint exists\b/u.test(error.message ?? "");
}

/**
 * The open node's menu, in the order the model is offered it. A tool is on it
 * only when the registry has it, so a tool a later core adds
 * (`code_workspace_apply_patch`, `code_sandbox_run`) or a host provides
 * (`code_workspace_inspect`) joins without a change here. Trash is on the
 * menu and still asks: its approval comes from its own descriptor.
 * `recall_tool_result` reads back what context compaction set aside, so a
 * long pass can return to a read it made early instead of making it again.
 */
export const CODE_FREE_MENU_V1 = Object.freeze([
  "code_sandbox_status",
  "code_workspace_status",
  "code_workspace_create",
  "code_workspace_list",
  "code_workspace_read",
  "code_workspace_stat",
  "code_workspace_search",
  "code_workspace_inspect",
  "code_workspace_create_file",
  "code_workspace_append",
  "code_workspace_write_expected",
  "code_workspace_patch",
  "code_workspace_apply_patch",
  "code_workspace_mkdir",
  "code_workspace_move",
  "code_workspace_copy",
  "code_workspace_trash",
  "code_validate_fast",
  "code_validate_targeted",
  "code_sandbox_run",
  "code_environment_status",
  "code_environment_execute",
  "code_environment_poll",
  "code_environment_stop",
  "code_environment_changes",
  "code_environment_adopt",
  "code_repair_status",
  "recall_tool_result",
  CODE_PLAN_UPDATE_TOOL_NAME_V1,
] as const);

/**
 * Steps that need the run to own its workspace (CODE2-24). A run attached to a
 * person's workspace changes and checks its files and the person commits
 * them, so its ladder leaves these out: the code runtime refuses the repair
 * cycle record and the verified commit there, publication follows the commit,
 * and promoting a scratch workspace to a repository would take it over.
 */
export const PERSON_COMMITTED_CODE_TOOLS_V1: ReadonlySet<string> = new Set([
  "code_repair_record_cycle",
  "code_commit_verified",
  "publish_verified_code_to_github",
  "code_workspace_init_repository",
]);

/**
 * Writes that change the workspace's files, after which a check is owed. An
 * append is one: a ladder whose only write was an append (a brief that says
 * "append") was planned as a guided pass, not the open node.
 */
export const CODE_FREE_WRITE_TOOLS_V1: ReadonlySet<string> = new Set([
  "code_workspace_create_file",
  "code_workspace_append",
  "code_workspace_write_expected",
  "code_workspace_patch",
  "code_workspace_apply_patch",
  "code_workspace_mkdir",
  "code_workspace_move",
  "code_workspace_copy",
  "code_workspace_trash",
]);

export function normalizeCodeAutonomyV1(value: unknown): CodeAutonomyV1 {
  return value === "free" ? "free" : "guided";
}

export function normalizeCodeFreeBudgetV1(
  value: Partial<CodeFreeBudgetV1> | null | undefined,
): CodeFreeBudgetV1 {
  const pick = (key: keyof CodeFreeBudgetV1): number => {
    const raw = value?.[key];
    const [min, max] = CODE_FREE_BUDGET_LIMITS_V1[key];
    const chosen =
      typeof raw === "number" && Number.isFinite(raw)
        ? Math.trunc(raw)
        : DEFAULT_CODE_FREE_BUDGET_V1[key];
    return Math.min(max, Math.max(min, chosen));
  };
  return {
    toolCalls: pick("toolCalls"),
    modelCalls: pick("modelCalls"),
    tokens: pick("tokens"),
    ms: pick("ms"),
  };
}

/**
 * The agent steps a segment may take while the open node is open (CODE2-2).
 * The open node is bounded by its own model calls, not by the runner's
 * hard step cap or the person's step setting, so a deep (240) or extended
 * (400) budget is reachable; the closing nodes keep the allowance the model
 * and tool budgets give them (two turns each, and four to finish).
 */
export function codeFreeSegmentStepLimitV1(input: {
  budget: Pick<CodeFreeBudgetV1, "modelCalls">;
  spentModelCalls: number;
  closingCount: number;
}): number {
  const left = Math.max(0, input.budget.modelCalls - Math.max(0, input.spentModelCalls));
  return Math.max(1, left + Math.max(0, input.closingCount) * 2 + 4);
}

/** The menu tools the registry has, in menu order. */
export function codeFreeMenuToolNamesV1(
  available: ReadonlySet<string>,
): string[] {
  return CODE_FREE_MENU_V1.filter(
    (name) => name === CODE_PLAN_UPDATE_TOOL_NAME_V1 || available.has(name),
  );
}

export interface CodeFreeWorkPlanV1 {
  /** The open node's tools, in menu order. */
  menu: string[];
  /** The guided ladder's tail the open node is followed by. */
  closing: string[];
}

/**
 * The free plan for a guided code ladder, or null when the ladder is not an
 * implementation (no write, or nothing to check), in which case a free run
 * plans exactly as a guided one. The open node replaces every step before the
 * ladder's first validation; the rest is kept as it is.
 */
export function planCodeFreeWorkV1(input: {
  ladder: readonly string[];
  available: ReadonlySet<string>;
}): CodeFreeWorkPlanV1 | null {
  const firstValidation = input.ladder.findIndex((name) =>
    name.startsWith("code_validate_"),
  );
  if (firstValidation < 0) return null;
  const head = input.ladder.slice(0, firstValidation);
  if (!head.some((name) => CODE_FREE_WRITE_TOOLS_V1.has(name))) return null;
  // The open node replaces code steps only. A ladder whose head also holds a
  // note write, a web read or anything else outside the code catalog is not a
  // plain coding pass, and is planned as a guided one.
  if (head.some((name) => !name.startsWith("code_"))) return null;
  const menu = codeFreeMenuToolNamesV1(input.available);
  if (
    !menu.some((name) => CODE_FREE_WRITE_TOOLS_V1.has(name)) ||
    !menu.includes("code_validate_targeted")
  ) {
    return null;
  }
  return { menu, closing: input.ladder.slice(firstValidation) };
}

export type CodePlanItemStatusV1 = "pending" | "in_progress" | "done";

export interface CodePlanItemV1 {
  text: string;
  status: CodePlanItemStatusV1;
}

/**
 * The model's to-do list, as the run reports it each time the model updates
 * it. `revision` counts the updates in this run, from 1.
 */
export interface CodePlanUpdateEventV1 {
  version: 1;
  runId: string;
  nodeId: typeof CODE_FREE_WORK_NODE_ID_V1;
  revision: number;
  items: CodePlanItemV1[];
  updatedAt: string;
}

const PLAN_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "done"]);

export function parseCodePlanItemsV1(
  args: Record<string, unknown>,
): { ok: true; items: CodePlanItemV1[] } | { ok: false; message: string } {
  const raw = args.items;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: "items must be a list of one to 20 {text, status} entries." };
  }
  if (raw.length > CODE_PLAN_MAX_ITEMS_V1) {
    return { ok: false, message: `A plan holds at most ${CODE_PLAN_MAX_ITEMS_V1} items; merge some.` };
  }
  const items: CodePlanItemV1[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, message: `items[${index}] must be {text, status}.` };
    }
    const record = entry as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.replace(/\s+/gu, " ").trim() : "";
    if (!text) {
      return { ok: false, message: `items[${index}].text must be a short sentence.` };
    }
    if (text.length > CODE_PLAN_MAX_TEXT_CHARS_V1) {
      return { ok: false, message: `items[${index}].text is over ${CODE_PLAN_MAX_TEXT_CHARS_V1} characters.` };
    }
    const status = typeof record.status === "string" ? record.status : "";
    if (!PLAN_STATUSES.has(status)) {
      return { ok: false, message: `items[${index}].status must be pending, in_progress or done.` };
    }
    items.push({ text, status: status as CodePlanItemStatusV1 });
  }
  return { ok: true, items };
}

const STATUS_MARK: Record<CodePlanItemStatusV1, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  done: "[x]",
};

/** The plan as the model is answered it: one line per item. */
export function renderCodePlanV1(items: readonly CodePlanItemV1[]): string {
  const done = items.filter((item) => item.status === "done").length;
  return [
    `Plan recorded (${done} of ${items.length} done):`,
    ...items.map((item) => `${STATUS_MARK[item.status]} ${item.text}`),
  ].join("\n");
}

/** What a budget stop says is left: the plan's open items, then the closing. */
export function describeCodeFreeWorkLeftV1(input: {
  items: readonly CodePlanItemV1[] | null;
  closing: readonly string[];
}): string {
  const open = (input.items ?? []).filter((item) => item.status !== "done");
  const parts: string[] = [];
  if (open.length > 0) {
    parts.push(`Left on the plan: ${open.map((item) => item.text).join("; ")}.`);
  } else if (!input.items) {
    parts.push("No plan was recorded.");
  }
  if (input.closing.length > 0) {
    parts.push(`Then: ${input.closing.join(", ")}.`);
  }
  return parts.join(" ");
}

export function codePlanUpdateToolV1(
  record: (items: CodePlanItemV1[]) => void,
): AgentTool {
  return {
    name: CODE_PLAN_UPDATE_TOOL_NAME_V1,
    description:
      "Purpose: keep your to-do list for this coding pass where the person can see it. Use when: you start, and whenever an item starts or is done. Required: items, the whole list each time (at most 20), each {text, status} with status pending, in_progress or done. Side effects: none on the workspace; the list is shown to the person. Answers the list back.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: CODE_PLAN_MAX_ITEMS_V1,
          items: {
            type: "object",
            properties: {
              text: { type: "string", maxLength: CODE_PLAN_MAX_TEXT_CHARS_V1 },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["text", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    descriptor: {
      version: 1,
      name: CODE_PLAN_UPDATE_TOOL_NAME_V1,
      capability: { system: "workspace", resourceType: "code_plan", action: "read" },
      effect: "read",
      risk: "low",
      approval: { allowPromptGrant: true, allowPersistentGrant: true, fallback: "none" },
      execution: { preparation: "none", cacheable: false, parallelSafe: false },
      durability: { journal: false, receipt: false, readback: "none", reconciliation: "none" },
      allowedPrincipals: ["host", "single_agent", "lead", "code_worker"],
    },
    async execute(args) {
      const parsed = parseCodePlanItemsV1(args);
      if (!parsed.ok) {
        throw new Error(parsed.message);
      }
      record(parsed.items);
      return renderCodePlanV1(parsed.items);
    },
  };
}

/**
 * The registry a run uses, with `code_plan_update` beside the host's tools.
 * Until `activate()` it is the host's registry exactly: the tool is not
 * listed, has no descriptor and cannot be called, so a guided run sees no
 * difference. A run activates it once its graph holds the open node.
 */
export function createCodePlanToolOverlayV1(
  base: ToolRegistry,
  record: (items: CodePlanItemV1[]) => void,
): { registry: ToolRegistry; activate(): void; active(): boolean } {
  const plan = new DefaultToolRegistry([codePlanUpdateToolV1(record)]);
  let active = false;
  const owns = (name: string): boolean =>
    active && name === CODE_PLAN_UPDATE_TOOL_NAME_V1;
  const registry: ToolRegistry = {
    getDefinitions() {
      const definitions = base.getDefinitions();
      if (
        !active ||
        definitions.some(
          (definition) => definition.function.name === CODE_PLAN_UPDATE_TOOL_NAME_V1,
        )
      ) {
        return definitions;
      }
      return [...definitions, ...plan.getDefinitions()];
    },
    getDescriptor(toolName: string): ToolDescriptor | null {
      return owns(toolName)
        ? plan.getDescriptor(toolName)
        : base.getDescriptor?.(toolName) ?? null;
    },
    execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
      return owns(call.name) ? plan.execute(call, context) : base.execute(call, context);
    },
  };
  if (base.prepare) {
    registry.prepare = (
      call: ModelToolCall,
      context: ToolExecutionContext,
    ): Promise<PreparedActionResult> =>
      owns(call.name) ? plan.prepare(call, context) : base.prepare!(call, context);
  }
  if (base.executePrepared) {
    registry.executePrepared = (
      action: PreparedAction,
      context: ToolExecutionContext,
      authorization?: AuthorizedActionContext,
    ): Promise<ToolExecutionResult> =>
      owns(action.toolName)
        ? plan.executePrepared(action, context, authorization)
        : base.executePrepared!(action, context, authorization);
  }
  if (base.reconcile) {
    registry.reconcile = (
      action: PreparedAction,
      context: ToolExecutionContext,
    ): Promise<ActionReconciliationResult> =>
      owns(action.toolName)
        ? plan.reconcile(action, context)
        : base.reconcile!(action, context);
  }
  return {
    registry,
    activate() {
      active = true;
    },
    active: () => active,
  };
}
