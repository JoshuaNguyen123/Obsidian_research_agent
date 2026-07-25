/**
 * Mid-run steering (G5).
 *
 * A running mission can be stopped but not corrected. `AgentRunner.ts` carries
 * 56 abort/stop references and no interjection path at all — grepping `src/`
 * for any user-message-injection seam returns nothing. Clarifying questions
 * exist, but they are agent-initiated at decision points, not user-initiated at
 * an arbitrary moment.
 *
 * The cost shows up in the repo's own compound log: a run that reached
 * modelCallCount=294 and a 45.8m timeout, where the only available levers were
 * repeated Continue clicks and killing the Obsidian process. Watching an agent
 * commit to a wrong path with no option but "kill it and lose the ledger" is
 * the difference between supervised autonomy and a coin flip.
 *
 * ## The narrowing invariant
 *
 * Steering may only ever *narrow*: add a constraint, restrict scope, drop a
 * tool, prioritize a target. It can never add a tool, widen a path, or grant
 * authority. This is not a stylistic choice — it is what keeps steering outside
 * the authority system entirely.
 *
 * `ScopedToolRegistry` enforces least authority by computing an allowed-name set
 * up front and re-checking it at every execution seam, and prepared mutations
 * additionally require an exact `AuthorityGrant` bound to a payload
 * fingerprint. If a steering directive could widen the tool set, it would
 * become a path to reaching a tool the user never approved — a live
 * privilege-escalation channel into a running agent. Because directives only
 * subtract, a steering message can never authorize anything, and
 * `applySteeringToStepPrompt` cannot be turned into a grant.
 *
 * Directives also apply only at step boundaries, never mid-tool-call. A tool
 * call that has been prepared and authorized carries a fingerprint the receipt
 * is validated against; mutating its context mid-flight would invalidate that
 * chain and produce a mutation whose receipt no longer describes what ran.
 *
 * ## Runtime integration
 *
 * 1. `RunCoordinator` owns the bounded queue; `AgentView` enqueues through the
 *    typed plugin wrapper, which rejects widening directives.
 * 2. At the top of each loop step — after the previous tool result is recorded,
 *    before the next request is assembled — call `drainSteeringDirectives`.
 * 3. Dropped tool names are removed from the step's allowed names and tool
 *    definitions before the registry is built; remaining directives are
 *    appended as a system message.
 */

export type SteeringDirectiveKind =
  | "add_constraint"
  | "narrow_scope"
  | "drop_tool"
  | "prioritize_target";

/** Every kind is narrowing. The list is exhaustive by construction. */
export const NARROWING_DIRECTIVE_KINDS: readonly SteeringDirectiveKind[] = [
  "add_constraint",
  "narrow_scope",
  "drop_tool",
  "prioritize_target",
] as const;

/** Bound on pending directives, so a stuck queue cannot grow without limit. */
export const MAX_PENDING_DIRECTIVES = 8;
/** Bound on directive text, so steering cannot become a prompt-injection channel. */
export const MAX_DIRECTIVE_TEXT_CHARS = 500;

export interface SteeringDirectiveV1 {
  version: 1;
  id: string;
  kind: SteeringDirectiveKind;
  /** User-authored text. Trimmed and length-capped, never interpreted as markup. */
  text: string;
  /** Required for `drop_tool`, ignored otherwise. */
  toolName?: string;
  enqueuedAt: string;
}

export interface RunSteeringQueueV1 {
  version: 1;
  pending: SteeringDirectiveV1[];
  /** Directives already projected into a step prompt. */
  applied: SteeringDirectiveV1[];
}

export type SteeringEnqueueResult =
  | { ok: true; queue: RunSteeringQueueV1; directive: SteeringDirectiveV1 }
  | { ok: false; code: SteeringRejectionCode; message: string };

export type SteeringRejectionCode =
  | "no_active_run"
  | "would_widen_authority"
  | "queue_full"
  | "empty_directive"
  | "missing_tool_name";

export function createRunSteeringQueue(): RunSteeringQueueV1 {
  return { version: 1, pending: [], applied: [] };
}

/**
 * Enqueue a directive for the next step boundary.
 *
 * Rejects any kind outside `NARROWING_DIRECTIVE_KINDS`. That check is the
 * enforcement point for the narrowing invariant: a caller cannot construct a
 * widening directive and have it reach the prompt, so no steering input can
 * expand the run's tool set or authority.
 */
export function enqueueSteeringDirective(
  queue: RunSteeringQueueV1,
  input: {
    kind: string;
    text: string;
    toolName?: string;
    enqueuedAt: string;
    id?: string;
  },
): SteeringEnqueueResult {
  if (!isNarrowingDirectiveKind(input.kind)) {
    return {
      ok: false,
      code: "would_widen_authority",
      message: `Steering directive kind ${input.kind} is not a narrowing directive. Steering can only add constraints, restrict scope, drop tools, or prioritize targets.`,
    };
  }
  if (queue.pending.length >= MAX_PENDING_DIRECTIVES) {
    return {
      ok: false,
      code: "queue_full",
      message: `At most ${MAX_PENDING_DIRECTIVES} steering directives may be pending.`,
    };
  }

  const text = input.text.trim().slice(0, MAX_DIRECTIVE_TEXT_CHARS);
  if (!text) {
    return {
      ok: false,
      code: "empty_directive",
      message: "A steering directive requires text.",
    };
  }

  const toolName = input.toolName?.trim();
  if (input.kind === "drop_tool" && !toolName) {
    return {
      ok: false,
      code: "missing_tool_name",
      message: "A drop_tool directive requires the tool name to drop.",
    };
  }

  const directive: SteeringDirectiveV1 = {
    version: 1,
    id: input.id ?? `steering-${queue.pending.length + queue.applied.length + 1}`,
    kind: input.kind,
    text,
    ...(toolName ? { toolName } : {}),
    enqueuedAt: input.enqueuedAt,
  };

  return {
    ok: true,
    directive,
    queue: {
      version: 1,
      pending: [...queue.pending, directive],
      applied: [...queue.applied],
    },
  };
}

/**
 * Take everything pending. Call only at a step boundary — never while a tool
 * call is prepared or in flight, or the payload fingerprint that its receipt is
 * validated against would no longer describe the executed action.
 */
export function drainSteeringDirectives(queue: RunSteeringQueueV1): {
  queue: RunSteeringQueueV1;
  drained: SteeringDirectiveV1[];
} {
  if (queue.pending.length === 0) {
    return { queue, drained: [] };
  }
  return {
    drained: [...queue.pending],
    queue: {
      version: 1,
      pending: [],
      applied: [...queue.applied, ...queue.pending],
    },
  };
}

/**
 * Project drained directives into a system message for the next step. Returns
 * null when there is nothing to say, so callers can append unconditionally.
 */
export function applySteeringToStepPrompt(
  directives: readonly SteeringDirectiveV1[],
): string | null {
  if (directives.length === 0) {
    return null;
  }

  const lines = ["User steering received mid-run. Apply from this step onward:"];
  for (const directive of directives) {
    switch (directive.kind) {
      case "add_constraint":
        lines.push(`- Constraint: ${directive.text}`);
        break;
      case "narrow_scope":
        lines.push(`- Narrow scope to: ${directive.text}`);
        break;
      case "drop_tool":
        lines.push(
          `- Do not use ${directive.toolName}: ${directive.text}`,
        );
        break;
      case "prioritize_target":
        lines.push(`- Prioritize: ${directive.text}`);
        break;
    }
  }
  lines.push(
    "These narrow the current mission. They never grant new tools or authority; keep every existing safety requirement.",
  );
  return lines.join("\n");
}

/**
 * Tool names to subtract from the next step's tool set. The caller removes
 * these before the definitions reach the registry — steering never reaches into
 * the registry itself, so the least-authority set stays host-owned.
 */
export function toolNamesDroppedBySteering(
  directives: readonly SteeringDirectiveV1[],
): string[] {
  return [
    ...new Set(
      directives
        .filter((directive) => directive.kind === "drop_tool")
        .map((directive) => directive.toolName?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];
}

export function isNarrowingDirectiveKind(
  value: string,
): value is SteeringDirectiveKind {
  return (NARROWING_DIRECTIVE_KINDS as readonly string[]).includes(value);
}
