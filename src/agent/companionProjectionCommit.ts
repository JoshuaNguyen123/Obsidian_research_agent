export interface CompanionProjectionCommitInputV1 {
  appliedThroughSequence: number;
  persistProjection(): Promise<{ changed: boolean }>;
  acknowledgeCursor(throughSequence: number): Promise<void>;
}

export interface CompanionProjectionCommitResultV1 {
  projectionChanged: boolean;
  cursorAcknowledged: boolean;
  cursorError: unknown | null;
}

/**
 * Enforces the crash-safe companion ordering boundary: the exact core
 * projection must be durable before the external applied-event cursor moves.
 * Projection failures reject without calling the acknowledgement callback;
 * acknowledgement failures are returned so the caller can keep retry work
 * pending while still hydrating the already-durable core state.
 */
export async function persistCompanionProjectionBeforeCursorV1(
  input: CompanionProjectionCommitInputV1,
): Promise<CompanionProjectionCommitResultV1> {
  if (
    !Number.isInteger(input.appliedThroughSequence) ||
    input.appliedThroughSequence < 0
  ) {
    throw new Error("Companion applied-event sequence is invalid.");
  }
  const projection = await input.persistProjection();
  if (input.appliedThroughSequence === 0) {
    return {
      projectionChanged: projection.changed,
      cursorAcknowledged: false,
      cursorError: null,
    };
  }
  try {
    await input.acknowledgeCursor(input.appliedThroughSequence);
    return {
      projectionChanged: projection.changed,
      cursorAcknowledged: true,
      cursorError: null,
    };
  } catch (error) {
    return {
      projectionChanged: projection.changed,
      cursorAcknowledged: false,
      cursorError: error,
    };
  }
}
