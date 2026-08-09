export interface RealAiConnectionTarget {
  provider: "ollama" | "openai_compatible";
  baseUrl: string;
  model: string;
}

export type RealAiLaneAttestationState = {
  mockInstalled?: boolean | null;
  viewMocks?: readonly boolean[] | null;
  descriptorTransportKind?: string | null;
  settingsModel?: string | null;
  expectedModel?: string | null;
};

export class RealAiConnectionAttestationRegistry {
  private readonly verified = new Set<string>();

  has(target: RealAiConnectionTarget): boolean {
    return this.verified.has(realAiConnectionAttestationKey(target));
  }

  record(target: RealAiConnectionTarget): void {
    this.verified.add(realAiConnectionAttestationKey(target));
  }
}

/**
 * Fail closed when a Tier A (--real-ai) lane still attests the Playwright mock
 * model or a non-production transport. Journey lanes must use startRealAiHarness.
 */
export function assertRealAiLaneNonMock(
  state: RealAiLaneAttestationState,
): void {
  if (state.mockInstalled === true) {
    throw new Error(
      "Tier A real-AI lane fail-closed: Playwright mock model is still installed. Use startRealAiHarness with --real-ai.",
    );
  }
  const viewMocks = state.viewMocks ?? [];
  if (viewMocks.some((value) => value === true)) {
    throw new Error(
      "Tier A real-AI lane fail-closed: an AgentView still has the Playwright mock model installed.",
    );
  }
  const transport = String(state.descriptorTransportKind ?? "").trim();
  if (transport && transport !== "production") {
    throw new Error(
      `Tier A real-AI lane fail-closed: model transport is ${transport}, expected production.`,
    );
  }
  const settingsModel = String(state.settingsModel ?? "").trim();
  const expectedModel = String(state.expectedModel ?? "").trim();
  if (expectedModel && settingsModel && settingsModel !== expectedModel) {
    throw new Error(
      `Tier A real-AI lane fail-closed: settings model ${settingsModel} does not match expected ${expectedModel}.`,
    );
  }
  if (/mock|playwright-e2e/iu.test(settingsModel)) {
    throw new Error(
      `Tier A real-AI lane fail-closed: settings model looks like a mock (${settingsModel}).`,
    );
  }
}

export async function verifyWithWorkerConnectionAttestation<T>({
  registry,
  target,
  verify,
  validate,
  timeoutMs = 60_000,
}: {
  registry: RealAiConnectionAttestationRegistry;
  target: RealAiConnectionTarget;
  verify(input: { reuseWorkerAttestation: boolean }): Promise<T>;
  validate(state: T): Promise<void> | void;
  timeoutMs?: number;
}): Promise<T> {
  const reuseWorkerAttestation = registry.has(target);
  const normalizedTimeoutMs = Math.max(1, Math.trunc(timeoutMs));
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const state = await Promise.race([
    verify({ reuseWorkerAttestation }),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              `Real AI connection attestation timed out after ${normalizedTimeoutMs} ms.`,
            ),
          ),
        normalizedTimeoutMs,
      );
    }),
  ]).finally(() => {
    if (timeout !== null) clearTimeout(timeout);
  });
  await validate(state);
  // Publish only after every production, no-mock, and UI readiness assertion
  // succeeds. Failed transport or validation cannot poison later scenarios.
  registry.record(target);
  return state;
}

function realAiConnectionAttestationKey(
  target: RealAiConnectionTarget,
): string {
  return `${target.provider}\u0000${target.baseUrl}\u0000${target.model}`;
}
