export const BUNDLE_PARITY_ARTIFACTS: readonly string[];
export const BUNDLE_PARITY_REBUILD_HINT: string;
export function parseBundleParityArgs(argv: string[]): { noBuild: boolean };
export function driftedParityArtifactsFromStat(statOutput: string): string[];
