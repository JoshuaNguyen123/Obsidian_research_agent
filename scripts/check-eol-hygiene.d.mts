export const EOL_HYGIENE_REPAIR_HINT: string;
export function parseEolHygieneArgs(argv: readonly string[]): { fix: boolean };
export function findEolDriftedFiles(
  lsFilesEolOutput: string,
): { file: string; worktree: string; pinned: string }[];
export function formatEolDriftReport(
  drifted: readonly { file: string; worktree: string; pinned: string }[],
): string;
export function chunkPathArguments(
  files: readonly string[],
  limit?: number,
): string[][];
