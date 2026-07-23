/** Model-visible capability status is descriptive, not authority. */
export type CapabilityAvailabilityV1 =
  | "installed"
  | "authorized"
  | "ready"
  | "offered"
  | "withheld";

export interface CapabilitySnapshotEntryV1 {
  toolName: string;
  availability: readonly CapabilityAvailabilityV1[];
  withheldReason?: string;
}

export interface CapabilitySnapshotV1 {
  version: 1;
  installedTools: readonly string[];
  authorizedTools: readonly string[];
  readyTools: readonly string[];
  offeredTools: readonly string[];
  withheldTools: readonly {
    toolName: string;
    reason: string;
  }[];
  currentNote: {
    authorized: boolean;
    contextInjected: boolean;
    callableTool: "read_current_file" | null;
  };
  provider: {
    provider: string;
    model: string;
  };
  /** Compatibility view for Run Details and tests. */
  entries: readonly CapabilitySnapshotEntryV1[];
}

export interface BuildCapabilitySnapshotInputV1 {
  installed?: readonly string[];
  authorized?: readonly string[];
  ready?: readonly string[];
  offered?: readonly string[];
  withheld?: readonly (
    | string
    | {
        toolName: string;
        reason: string;
      }
  )[];
  currentNote?: Partial<CapabilitySnapshotV1["currentNote"]>;
  provider?: Partial<CapabilitySnapshotV1["provider"]>;
}

const AVAILABILITY_ORDER: readonly CapabilityAvailabilityV1[] = [
  "installed",
  "authorized",
  "ready",
  "offered",
  "withheld",
];

export function canonicalCapabilityToolName(name: string): string {
  return name.trim() === "read_current_note" ? "read_current_file" : name.trim();
}

export function buildCapabilitySnapshotV1(
  input: BuildCapabilitySnapshotInputV1,
): CapabilitySnapshotV1 {
  const installedTools = canonicalNames(input.installed);
  const authorizedTools = canonicalNames(input.authorized);
  const readyTools = canonicalNames(input.ready);
  const offeredTools = canonicalNames(input.offered);
  const withheldTools = (input.withheld ?? [])
    .map((item) =>
      typeof item === "string"
        ? {
            toolName: canonicalCapabilityToolName(item),
            reason: "not offered on the current frontier",
          }
        : {
            toolName: canonicalCapabilityToolName(item.toolName),
            reason: item.reason.trim() || "not offered on the current frontier",
          },
    )
    .filter((item) => item.toolName)
    .sort((left, right) => left.toolName.localeCompare(right.toolName));
  const withheldReasonByTool = new Map(
    withheldTools.map((item) => [item.toolName, item.reason]),
  );
  const groups = {
    installed: new Set(installedTools),
    authorized: new Set(authorizedTools),
    ready: new Set(readyTools),
    offered: new Set(offeredTools),
    withheld: new Set(withheldTools.map((item) => item.toolName)),
  } satisfies Record<CapabilityAvailabilityV1, Set<string>>;
  const allNames = new Set(
    AVAILABILITY_ORDER.flatMap((availability) => [...groups[availability]]),
  );

  return {
    version: 1,
    installedTools,
    authorizedTools,
    readyTools,
    offeredTools,
    withheldTools,
    currentNote: {
      authorized: input.currentNote?.authorized ?? false,
      contextInjected: input.currentNote?.contextInjected ?? false,
      callableTool: input.currentNote?.callableTool ?? null,
    },
    provider: {
      provider: input.provider?.provider?.trim() || "unknown",
      model: input.provider?.model?.trim() || "unknown",
    },
    entries: [...allNames]
      .sort((left, right) => left.localeCompare(right))
      .map((toolName) => ({
        toolName,
        availability: AVAILABILITY_ORDER.filter((availability) =>
          groups[availability].has(toolName),
        ),
        ...(withheldReasonByTool.has(toolName)
          ? { withheldReason: withheldReasonByTool.get(toolName) }
          : {}),
      })),
  };
}

export function formatCapabilitySnapshotForModel(
  snapshot: CapabilitySnapshotV1,
): string {
  const lines = [
    "CAPABILITY_SNAPSHOT_V1",
    `installed: ${formatNames(snapshot.installedTools)}`,
    `authorized: ${formatNames(snapshot.authorizedTools)}`,
    `ready: ${formatNames(snapshot.readyTools)}`,
    `offered_now: ${formatNames(snapshot.offeredTools)}`,
    `withheld: ${
      snapshot.withheldTools.length > 0
        ? snapshot.withheldTools
            .map((item) => `${item.toolName} (${item.reason})`)
            .join(", ")
        : "none"
    }`,
    `current_note: authorized=${snapshot.currentNote.authorized}; context_injected=${snapshot.currentNote.contextInjected}; callable_tool=${snapshot.currentNote.callableTool ?? "none"}`,
    `provider: ${snapshot.provider.provider}; model=${snapshot.provider.model}`,
    "The current frontier is a temporary callable subset, not the platform catalog.",
    "Authorization does not guarantee current exposure. Only offered_now tools may be called.",
    "`read_current_note` is an authority label mapped to `read_current_file`, not a missing tool.",
  ];
  return lines.join("\n");
}

function canonicalNames(values: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map(canonicalCapabilityToolName)
        .filter((value) => value.length > 0),
    ),
  ].sort();
}

function formatNames(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}
