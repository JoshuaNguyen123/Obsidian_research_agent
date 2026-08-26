export const COMPANION_ASSETS_ARTIFACT: string;
export function findNonCanonicalAssets(
  files: Readonly<Record<string, string>>,
): string[];
export function buildCompanionAssets(
  repoRoot: string,
): Promise<{ bundleHash: string; fileCount: number }>;
