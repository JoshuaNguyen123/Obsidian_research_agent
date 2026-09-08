import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  unknownToolCallOutcomeCountsV1,
  type ToolCallOutcomeCountsV1,
} from "./toolCallOutcomes";

/** Preserve the attempt before contacting a renderer that may already be dead.
 * Callers select the evidence fields; never pass settings or model thinking. */
export async function preserveFailureEvidence(input: {
  file: string;
  metadata: Record<string, unknown>;
  read: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const record = {
    version: 1,
    recordedAt: new Date().toISOString(),
    ...input.metadata,
    readStatus: "started",
    evidence: null as unknown,
  };
  const save = async () => {
    await mkdir(path.dirname(input.file), { recursive: true });
    const temporary = `${input.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporary, input.file);
  };
  await save();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(input.read).then((evidence) => ({ evidence })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Evidence read timed out")), input.timeoutMs ?? 3_000);
      }),
    ]);
    // `undefined` is not evidence. It also vanishes from JSON.stringify, so a
    // record that called it "captured" would claim proof it does not hold and
    // show no missing key to give that away.
    record.evidence = result.evidence ?? null;
    record.readStatus =
      result.evidence === null || result.evidence === undefined
        ? "unavailable"
        : "captured";
  } catch {
    record.readStatus = "unavailable";
  } finally {
    clearTimeout(timer);
    await save();
  }
}

/**
 * Persist ONE mission attempt before anything destructive happens to it.
 *
 * The rule this exists for: *every* attempted mission leaves a record, not just
 * the failed ones. A green attempt whose renderer dies during teardown used to
 * leave nothing at all, so the occurrence simply disappeared from the evidence
 * — and an occurrence that vanishes is indistinguishable from one that never
 * launched, which is precisely the hole a reliability denominator must not have.
 *
 * Built on `preserveFailureEvidence` rather than beside it: the write-then-read
 * ordering, the atomic rename and the bounded read timeout are already correct
 * there, and a second persistence path is a second thing to get wrong.
 *
 * The tool-call fold is passed in ALREADY HARVESTED. Harvesting must happen
 * before the teardown that destroys the renderer; by the time this helper runs,
 * reading the page may be impossible. An absent fold is recorded as
 * `unobserved` with null counts — never as a complete observation of zero calls.
 */
export async function preserveMissionAttemptRecordV1(input: {
  file: string;
  scenarioId: string;
  /** What the attempt actually delivered, independent of any harness verdict. */
  outcome: "passed" | "failed";
  model: string;
  progress?: Record<string, number | null>;
  /** Harvested BEFORE destructive teardown. Null when nothing was captured. */
  toolCallOutcomes?: ToolCallOutcomeCountsV1 | null;
  /** Optional extra evidence read; may fail without losing the record above. */
  read?: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const toolCallOutcomes =
    input.toolCallOutcomes ?? unknownToolCallOutcomeCountsV1("unobserved");
  await preserveFailureEvidence({
    file: input.file,
    metadata: {
      recordKind: "mission_attempt",
      scenarioId: input.scenarioId,
      outcome: input.outcome,
      model: input.model,
      ...(input.progress ? { progress: input.progress } : {}),
      toolCallOutcomes,
      /**
       * The single field a consumer should gate on. It is NOT "the attempt
       * passed": an attempt can deliver its artifacts while its tool evidence
       * is lossy, and that combination must never satisfy a completeness
       * check. Derived here so no consumer has to re-derive it and drift.
       */
      evidenceComplete: toolCallOutcomes.coverage === "complete",
    },
    read: input.read ?? (async () => null),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
}
