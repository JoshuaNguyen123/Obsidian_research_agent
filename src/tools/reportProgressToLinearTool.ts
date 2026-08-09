/**
 * Close the reflection loop back into Linear.
 *
 * At the end of a mission the agent writes a reflection into the originating
 * note. Until now that reflection was vault-only: the Linear issue that started
 * the work never heard about it unless the run happened to reach GitHub
 * publication (which comments and completes as a finalizer) or came from the
 * automatic queue (which runs its own four-state ladder). Everything else — most
 * commonly "research this and file a Linear issue" — created a ticket and then
 * went silent.
 *
 * This is the model-callable half of that loop. The agent decides whether to
 * report, what to say, and which level to move to. The host keeps everything
 * that must not be model-chosen:
 *
 * - `status` is a closed enum, never a raw state id. `linear_update_issue`
 *   accepts an opaque `stateId`, so exposing it directly would let a model move
 *   an issue into any state in any team. Here the host maps three semantic
 *   levels onto the ids the workspace already configured.
 * - the issue must be one this run actually touched, so the agent cannot
 *   comment on an arbitrary ticket it read about somewhere.
 * - the comment is checked for host-internal metadata before it reaches the
 *   provider, reusing the same guard as issue bodies.
 */

import type { ToolDescriptor } from "../agent/actions";
import { assertCleanLinearHumanOutputV1 } from "../integrations/linear/LinearIssueFormatV1";
import type { JsonSchemaObject } from "../model/types";
import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import type { ProjectLineageV1 } from "../agent/projectLifecycle";

export const REPORT_PROGRESS_TO_LINEAR_TOOL_NAME = "report_progress_to_linear";

/** Semantic levels the model may choose between. */
export const LINEAR_PROGRESS_STATUSES = ["started", "blocked", "completed"] as const;

export type LinearProgressStatusV1 = (typeof LINEAR_PROGRESS_STATUSES)[number];

export const REPORT_PROGRESS_COMMENT_MAX_CHARS = 4_000;

export function collectBoundLinearIssueIdsFromProjectLineagesV1(
  lineages: readonly ProjectLineageV1[],
  runIds: ReadonlySet<string>,
): string[] {
  return [...new Set(
    lineages
      .filter((lineage) => runIds.has(lineage.runId.trim()))
      .flatMap((lineage) =>
        lineage.commits.flatMap((commit) =>
          commit.proof.stage === "linear_hierarchy"
            ? commit.proof.issueIds.filter(
                (value) => typeof value === "string" && value.trim().length > 0,
              )
            : [],
        ),
      ),
  )];
}

export interface LinearProgressStateIdsV1 {
  started: string;
  blocked: string;
  completed: string;
}

export interface LinearProgressCommentResultV1 {
  receiptId: string;
  commentId: string;
}

export interface LinearProgressStateResultV1 {
  receiptId: string;
  /** False when the issue was already in the requested state. */
  changed: boolean;
}

export interface CreateReportProgressToLinearOptionsV1 {
  /**
   * Issue ids this run legitimately touched, from the run's project lineage or
   * research-publication checkpoint. An empty list means the run has no bound
   * issue and the tool refuses every call.
   *
   * Async because a single `publish_research_to_linear` writes no
   * linear_hierarchy lineage commit — its issue is only recoverable from the
   * durable publication checkpoint, which is read from disk.
   */
  resolveBoundIssueIds(
    context: ToolExecutionContext,
  ): Promise<readonly string[]> | readonly string[];
  /** Configured workflow-state ids. Any of them may be blank. */
  resolveStateIds(): LinearProgressStateIdsV1;
  postComment(input: {
    issueId: string;
    body: string;
    context: ToolExecutionContext;
  }): Promise<LinearProgressCommentResultV1>;
  moveIssueState(input: {
    issueId: string;
    stateId: string;
    context: ToolExecutionContext;
  }): Promise<LinearProgressStateResultV1>;
  isAvailable?(): boolean;
}

const REPORT_PROGRESS_PARAMETERS: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    issueId: {
      type: "string",
      description: "Linear issue id this run created or read back.",
    },
    status: {
      type: "string",
      enum: [...LINEAR_PROGRESS_STATUSES],
      description:
        "Progress level. Omit to comment without changing the issue state.",
    },
    comment: {
      type: "string",
      description:
        "Short user-facing progress note in plain prose. No fingerprints or machine contracts.",
    },
  },
  required: ["issueId", "comment"],
};

const REPORT_PROGRESS_DESCRIPTOR: ToolDescriptor = {
  version: 1,
  name: REPORT_PROGRESS_TO_LINEAR_TOOL_NAME,
  capability: { system: "linear", resourceType: "issue", action: "update" },
  effect: "reversible_mutation",
  risk: "medium",
  approval: {
    allowPromptGrant: true,
    allowPersistentGrant: true,
    fallback: "exact",
  },
  execution: {
    preparation: "none",
    cacheable: false,
    parallelSafe: false,
  },
  durability: {
    journal: true,
    receipt: true,
    readback: "required",
    reconciliation: "required",
  },
  allowedPrincipals: ["single_agent"],
  receiptKind: "external_action",
  operationGoals: ["linear_progress_report"],
};

export function createReportProgressToLinearTool(
  options: CreateReportProgressToLinearOptionsV1,
): AgentTool {
  // One report per issue per run. A looping model must not be able to turn the
  // ticket into a comment feed.
  const reportedIssuesByRun = new Map<string, Set<string>>();

  return {
    name: REPORT_PROGRESS_TO_LINEAR_TOOL_NAME,
    description:
      "Post one progress update to the Linear issue this run is working and optionally move it to started, blocked, or completed. Use at the end of a mission, alongside the note reflection. The host resolves the workspace's configured state for the level you choose.",
    parameters: REPORT_PROGRESS_PARAMETERS,
    descriptor: REPORT_PROGRESS_DESCRIPTOR,
    async execute(args, context) {
      if (options.isAvailable?.() === false) {
        throw new ToolExecutionError(
          "linear_progress_report_unavailable",
          "Reporting progress to Linear is unavailable because the integration, credential, or configured destination is not ready.",
          { mutationState: "not_applied" },
        );
      }

      const issueId = requireText(args.issueId, "issueId", 256);
      const comment = requireText(
        args.comment,
        "comment",
        REPORT_PROGRESS_COMMENT_MAX_CHARS,
      );
      const status = parseStatus(args.status);

      // The model may only report on an issue this run actually touched.
      const boundIssueIds = await options.resolveBoundIssueIds(context);
      if (boundIssueIds.length === 0) {
        throw new ToolExecutionError(
          "linear_progress_report_unbound_run",
          "This run has no Linear issue bound to it, so there is nothing to report progress on.",
          { mutationState: "not_applied" },
        );
      }
      if (!boundIssueIds.includes(issueId)) {
        throw new ToolExecutionError(
          "linear_progress_report_issue_not_bound",
          `Linear issue ${issueId} was not created or read back by this run. Report progress only on this run's own issue.`,
          { mutationState: "not_applied" },
        );
      }

      try {
        assertCleanLinearHumanOutputV1(comment, "Linear progress comment");
      } catch (error) {
        throw new ToolExecutionError(
          "linear_progress_report_invalid_arguments",
          error instanceof Error ? error.message : String(error),
          { mutationState: "not_applied" },
        );
      }

      const runKey = context.rootMissionId?.trim() || context.runId?.trim() || "";
      const alreadyReported = reportedIssuesByRun.get(runKey);
      if (alreadyReported?.has(issueId)) {
        throw new ToolExecutionError(
          "linear_progress_report_already_reported",
          `Progress was already reported to Linear issue ${issueId} in this run. Report once per issue.`,
          { mutationState: "not_applied" },
        );
      }

      // Resolve the state before commenting, so an unconfigured level is
      // reported as a skip rather than discovered after the comment landed.
      const stateResolution = resolveStatusState(status, options.resolveStateIds());

      const posted = await options.postComment({ issueId, body: comment, context });
      if (!alreadyReported) {
        reportedIssuesByRun.set(runKey, new Set([issueId]));
      } else {
        alreadyReported.add(issueId);
      }

      const receiptIds = [posted.receiptId];
      let stateOutcome: string;
      if (!status) {
        stateOutcome = "no state change requested";
      } else if (!stateResolution.stateId) {
        // Deliberately not fatal. The publication finalizer throws when the
        // completed state is unset because it gates a release; a reflection
        // that cannot move the ticket has still reported successfully.
        stateOutcome = `skipped: no Linear state is configured for "${status}"`;
      } else {
        const moved = await options.moveIssueState({
          issueId,
          stateId: stateResolution.stateId,
          context,
        });
        receiptIds.push(moved.receiptId);
        // "Already in that state" is a confirmation, not a failure.
        stateOutcome = moved.changed
          ? `moved to ${status}`
          : `already ${status}`;
      }

      return {
        issueId,
        commentId: posted.commentId,
        status: status ?? null,
        stateOutcome,
        receiptIds,
      };
    },
  };
}

/** Map a semantic level onto the workspace's configured state id. */
export function resolveStatusState(
  status: LinearProgressStatusV1 | null,
  stateIds: LinearProgressStateIdsV1,
): { stateId: string | null } {
  if (!status) return { stateId: null };
  const configured = status === "started"
    ? stateIds.started
    : status === "blocked"
      ? stateIds.blocked
      : stateIds.completed;
  const trimmed = typeof configured === "string" ? configured.trim() : "";
  return { stateId: trimmed || null };
}

function parseStatus(value: unknown): LinearProgressStatusV1 | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    !LINEAR_PROGRESS_STATUSES.includes(value as LinearProgressStatusV1)
  ) {
    throw new ToolExecutionError(
      "linear_progress_report_invalid_arguments",
      `status must be one of ${LINEAR_PROGRESS_STATUSES.join(", ")}.`,
      { mutationState: "not_applied" },
    );
  }
  return value as LinearProgressStatusV1;
}

function requireText(value: unknown, label: string, maximumLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new ToolExecutionError(
      "linear_progress_report_invalid_arguments",
      `${label} is required.`,
      { mutationState: "not_applied" },
    );
  }
  if (text.length > maximumLength) {
    throw new ToolExecutionError(
      "linear_progress_report_invalid_arguments",
      `${label} exceeds ${maximumLength} characters.`,
      { mutationState: "not_applied" },
    );
  }
  return text;
}
