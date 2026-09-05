export interface ResourceMeasurementOptions { cdp: string; vault: string; durationMs: number; intervalMs: number; output: string }
export function parseResourceMeasurementArgs(args: string[]): ResourceMeasurementOptions;
export function measureStorage(directory: string, maxEntries?: number): Promise<{ bytes: number; files: number }>;
export interface ResourceSample { status: "observed" | "unavailable"; elapsedMs: number; runtimeStartedAt?: number; heapUsedBytes?: number | null; storageBytes?: number | null; roundTripMs?: number }
export function summarizeResourceSamples(samples: ResourceSample[], targetDurationMs: number): {
  samples: number; observed: number; coverage: number | null; elapsedMs: number; durationSatisfied: boolean; runtimeSessions: number;
  heapGrowthBytes: number | null; storageGrowthBytes: number | null; maxRoundTripMs: number | null;
  acceptedOutputEfficiency: null; qualification: "resource_observation_only";
};
export function runResourceMeasurement(options: ResourceMeasurementOptions): Promise<ReturnType<typeof summarizeResourceSamples> & { output: string }>;
