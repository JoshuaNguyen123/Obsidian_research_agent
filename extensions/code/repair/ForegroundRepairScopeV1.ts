import type { ScopedExtensionContextV1 } from "@agentic-researcher/core-api";

export interface ForegroundRepairScopeV1 {
  workspaceId: string;
  requestId: string;
}

/**
 * Resolve the exact durable code scope named by the user-authored mission.
 *
 * The model may repeat these identifiers in tool arguments, but those values
 * are transcription hints only. A single explicit mission binding is
 * authoritative. Multiple bindings are accepted only when the requested
 * workspace selects exactly one of them; otherwise preparation fails closed.
 */
export function resolveForegroundRepairScopeV1(
  originalPrompt: string | undefined,
  requestedWorkspaceId?: string | null,
): ForegroundRepairScopeV1 | null {
  if (originalPrompt === undefined || originalPrompt.trim() === "") return null;
  if (originalPrompt.length > 100_000 || originalPrompt.includes("\u0000")) {
    throw new Error("Foreground repair scope prompt is invalid or exceeds the bounded size.");
  }

  const identifier = "([A-Za-z0-9][A-Za-z0-9._:-]{0,127}?)";
  const pairs: ForegroundRepairScopeV1[] = [];
  const collect = (
    expression: RegExp,
    select: (match: RegExpMatchArray) => ForegroundRepairScopeV1,
  ) => {
    for (const match of originalPrompt.matchAll(expression)) {
      const selected = select(match);
      pairs.push({
        workspaceId: boundedIdentifier(selected.workspaceId, "foreground workspace id"),
        requestId: boundedIdentifier(selected.requestId, "foreground repair request id"),
      });
    }
  };

  collect(
    new RegExp(
      `Execute explicit code repair request ${identifier} in trusted workspace ${identifier}(?=[\\s.]|$)`,
      "giu",
    ),
    (match) => ({ requestId: match[1], workspaceId: match[2] }),
  );
  collect(
    new RegExp(
      `using durable workspace ${identifier} and repair request(?: id)? ${identifier}(?=[\\s,;.]|$)`,
      "giu",
    ),
    (match) => ({ workspaceId: match[1], requestId: match[2] }),
  );
  collect(
    new RegExp(
      `Create repository workspace ${identifier} and use one repair request id ${identifier}(?=[\\s,;.]|$)`,
      "giu",
    ),
    (match) => ({ workspaceId: match[1], requestId: match[2] }),
  );

  const unique = [...new Map(
    pairs.map((pair) => [`${pair.workspaceId}\u0000${pair.requestId}`, pair]),
  ).values()];
  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0];

  const requested = typeof requestedWorkspaceId === "string" && requestedWorkspaceId.trim()
    ? boundedIdentifier(requestedWorkspaceId, "requested foreground workspace id")
    : null;
  const matching = requested === null
    ? []
    : unique.filter((pair) => pair.workspaceId === requested);
  if (matching.length === 1) return matching[0];
  throw new Error(
    "Foreground repair scope is ambiguous; name exactly one durable workspace and repair request pair.",
  );
}

export function bindForegroundRepairScopeV1(
  args: Record<string, unknown>,
  context: ScopedExtensionContextV1,
): Record<string, unknown> {
  const runId = context.rootMissionId?.trim() || context.missionId?.trim();
  if (!runId) {
    throw new Error("Production code repair tools require a host mission identity.");
  }
  const scope = resolveForegroundRepairScopeV1(
    context.originalPrompt,
    typeof args.workspaceId === "string" ? args.workspaceId : null,
  );
  return scope === null
    ? { ...args, runId }
    : {
        ...args,
        runId,
        workspaceId: scope.workspaceId,
        requestId: scope.requestId,
      };
}

function boundedIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new Error(`${label} must be a bounded durable identifier.`);
  }
  return value;
}
