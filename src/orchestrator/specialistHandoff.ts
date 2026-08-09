import { portableSha256Text } from "../../packages/core-api/src/portableSha256";
import type {
  SpecialistHandoffV2,
  SpecialistMode,
  SpecialistProofReferencesV2,
  WorkerHandoff,
} from "./types";

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;

export interface CreateSpecialistHandoffV2Input {
  handoff: WorkerHandoff;
  missionGraphId: string;
  specialistMode: SpecialistMode;
  /** Exact stage input or its stable descriptor. Secrets must never be passed. */
  missionInput: unknown;
  acceptanceCriteria: readonly string[];
  receiptIds?: readonly string[];
  artifactIds?: readonly string[];
  validationIds?: readonly string[];
  changedFiles?: readonly string[];
  conflicts?: readonly string[];
  limitations?: readonly string[];
  recommendedNextAction: string;
  workspaceLeaseId?: string;
  workspaceDiffFingerprint?: string;
  repairCycle?: 0 | 1;
}

export interface SpecialistHandoffAuthorityV2 {
  missionGraphId: string;
  inputFingerprint?: string;
  evidenceIds: ReadonlySet<string>;
  receiptIds: ReadonlySet<string>;
  artifactIds: ReadonlySet<string>;
  validationIds: ReadonlySet<string>;
  workspaceDiffFingerprint?: string;
}

export interface SpecialistHandoffValidationV2 {
  ok: boolean;
  missing: string[];
  stale: string[];
}

/** Create a deterministic, restart-safe handoff. The host still verifies it. */
export function createSpecialistHandoffV2(
  input: CreateSpecialistHandoffV2Input,
): SpecialistHandoffV2 {
  const missionGraphId = requiredText(input.missionGraphId, "missionGraphId", 200);
  const acceptanceCriteria = uniqueNarrative(
    input.acceptanceCriteria,
    "acceptanceCriteria",
    64,
    1_000,
  );
  if (acceptanceCriteria.length === 0) {
    throw new Error("Specialist handoff requires acceptance criteria.");
  }
  const proofReferences: SpecialistProofReferencesV2 = {
    evidenceIds: uniqueIds(input.handoff.evidenceIds),
    receiptIds: uniqueIds(input.receiptIds ?? []),
    artifactIds: uniqueIds(input.artifactIds ?? []),
    validationIds: uniqueIds(input.validationIds ?? []),
  };
  const changedFiles = uniqueRelativePaths(input.changedFiles ?? []);
  const workspaceDiffFingerprint = optionalFingerprint(
    input.workspaceDiffFingerprint,
    "workspaceDiffFingerprint",
  );
  const inputFingerprint = fingerprint({
    missionGraphId,
    specialistMode: input.specialistMode,
    missionInput: input.missionInput,
    acceptanceCriteria,
  });
  const progressFingerprint = fingerprint({
    taskId: input.handoff.taskId,
    specialistMode: input.specialistMode,
    summary: input.handoff.summary,
    sourceIds: uniqueIds(input.handoff.sourceIds),
    proofReferences,
    changedFiles,
    workspaceDiffFingerprint: workspaceDiffFingerprint ?? null,
    unresolvedQuestions: uniqueNarrative(
      input.handoff.unresolvedQuestions,
      "unresolvedQuestions",
      64,
      1_000,
    ),
    conflicts: uniqueNarrative(input.conflicts ?? [], "conflicts", 64, 1_000),
    limitations: uniqueNarrative(
      input.limitations ?? [],
      "limitations",
      64,
      1_000,
    ),
  });

  return {
    ...input.handoff,
    schemaVersion: 2,
    fromParticipantId: "specialist",
    toParticipantId: "lead",
    missionGraphId,
    specialistMode: input.specialistMode,
    inputFingerprint,
    progressFingerprint,
    acceptanceCriteria,
    proofReferences,
    changedFiles,
    conflicts: uniqueNarrative(input.conflicts ?? [], "conflicts", 64, 1_000),
    limitations: uniqueNarrative(
      input.limitations ?? [],
      "limitations",
      64,
      1_000,
    ),
    recommendedNextAction: requiredText(
      input.recommendedNextAction,
      "recommendedNextAction",
      2_000,
    ),
    ...(input.workspaceLeaseId?.trim()
      ? {
          workspaceLeaseId: requiredText(
            input.workspaceLeaseId,
            "workspaceLeaseId",
            200,
          ),
        }
      : {}),
    ...(workspaceDiffFingerprint ? { workspaceDiffFingerprint } : {}),
    repairCycle: input.repairCycle ?? 0,
  };
}

export function isSpecialistHandoffV2(
  value: WorkerHandoff,
): value is SpecialistHandoffV2 {
  const candidate = value as Partial<SpecialistHandoffV2>;
  return (
    candidate.schemaVersion === 2 &&
    candidate.fromParticipantId === "specialist" &&
    candidate.toParticipantId === "lead" &&
    typeof candidate.missionGraphId === "string" &&
    typeof candidate.inputFingerprint === "string" &&
    typeof candidate.progressFingerprint === "string"
  );
}

/**
 * Resolve every handoff claim against host-observed MissionGraph/receipt state.
 * An empty reference list is valid; an unresolved referenced id is not.
 */
export function validateSpecialistHandoffV2(
  handoff: SpecialistHandoffV2,
  authority: SpecialistHandoffAuthorityV2,
): SpecialistHandoffValidationV2 {
  const missing: string[] = [];
  const stale: string[] = [];
  if (handoff.missionGraphId !== authority.missionGraphId) {
    stale.push("mission_graph");
  }
  if (
    authority.inputFingerprint &&
    handoff.inputFingerprint !== authority.inputFingerprint
  ) {
    stale.push("input_fingerprint");
  }
  if (!FINGERPRINT.test(handoff.inputFingerprint)) {
    missing.push("valid_input_fingerprint");
  }
  if (!FINGERPRINT.test(handoff.progressFingerprint)) {
    missing.push("valid_progress_fingerprint");
  }
  if (handoff.acceptanceCriteria.length === 0) {
    missing.push("acceptance_criteria");
  }
  collectUnresolved(
    "evidence",
    handoff.proofReferences.evidenceIds,
    authority.evidenceIds,
    missing,
  );
  collectUnresolved(
    "receipt",
    handoff.proofReferences.receiptIds,
    authority.receiptIds,
    missing,
  );
  collectUnresolved(
    "artifact",
    handoff.proofReferences.artifactIds,
    authority.artifactIds,
    missing,
  );
  collectUnresolved(
    "validation",
    handoff.proofReferences.validationIds,
    authority.validationIds,
    missing,
  );
  if (
    handoff.workspaceDiffFingerprint &&
    handoff.workspaceDiffFingerprint !== authority.workspaceDiffFingerprint
  ) {
    stale.push("workspace_diff");
  }
  return { ok: missing.length === 0 && stale.length === 0, missing, stale };
}

export function fingerprintSpecialistInput(input: {
  missionGraphId: string;
  specialistMode: SpecialistMode;
  missionInput: unknown;
  acceptanceCriteria: readonly string[];
}): string {
  return fingerprint({
    missionGraphId: input.missionGraphId.trim(),
    specialistMode: input.specialistMode,
    missionInput: input.missionInput,
    acceptanceCriteria: uniqueNarrative(
      input.acceptanceCriteria,
      "acceptanceCriteria",
      64,
      1_000,
    ),
  });
}

export function fingerprintSpecialistWorkspaceDiff(
  changedFiles: readonly string[],
): string {
  return fingerprint({ changedFiles: uniqueRelativePaths(changedFiles).sort() });
}

function collectUnresolved(
  kind: string,
  ids: readonly string[],
  allowed: ReadonlySet<string>,
  output: string[],
): void {
  for (const id of ids) {
    if (!allowed.has(id)) output.push(`${kind}:${id}`);
  }
}

function fingerprint(value: unknown): string {
  return `sha256:${portableSha256Text(stableJson(value))}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function uniqueIds(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.map((value) => requiredText(value, "proof id", 200)),
    ),
  ];
}

function uniqueNarrative(
  values: readonly string[],
  field: string,
  limit: number,
  maxLength: number,
): string[] {
  return [
    ...new Set(
      values
        .slice(0, limit)
        .map((value) => requiredText(value, field, maxLength)),
    ),
  ];
}

function uniqueRelativePaths(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.map((value) => {
        const path = requiredText(value, "changed file", 2_000).replace(/\\/gu, "/");
        if (
          path.startsWith("/") ||
          /^[A-Za-z]:/u.test(path) ||
          path.split("/").some((segment) => segment === "..")
        ) {
          throw new Error("Specialist changed-file paths must be workspace-relative.");
        }
        return path.replace(/^\.\//u, "");
      }),
    ),
  ];
}

function optionalFingerprint(value: string | undefined, field: string): string | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!FINGERPRINT.test(normalized)) {
    throw new Error(`${field} must be a SHA-256 fingerprint.`);
  }
  return normalized;
}

function requiredText(value: string, field: string, maxLength: number): string {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u0008]/u.test(normalized)) {
    throw new Error(`${field} is invalid.`);
  }
  return normalized;
}
