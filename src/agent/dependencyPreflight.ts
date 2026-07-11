import type {
  MissionDependencyStatus,
} from "./missionLedger";

export interface DependencyPreflightResult {
  status: "ok" | "degraded" | "blocked";
  rows: MissionDependencyStatus[];
  canStartModelLoop: boolean;
}

export function runDependencyPreflight(
  rows: MissionDependencyStatus[],
): DependencyPreflightResult {
  const blocked = rows.some((row) => row.status === "blocked");
  const degraded = rows.some((row) => row.status === "degraded" || row.status === "unknown");
  return {
    status: blocked ? "blocked" : degraded ? "degraded" : "ok",
    rows: rows.map((row) => ({ ...row })),
    canStartModelLoop: !blocked,
  };
}
