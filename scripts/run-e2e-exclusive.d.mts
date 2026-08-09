export interface ExecutedPlaywrightTestV1 {
  project: string;
  file: string;
  title: string;
}

export function assertProjectsExecuted(
  report: unknown,
  selectedProjects: string[],
): { checked: number; executed: Record<string, number> };

export function collectExecutedPlaywrightTests(
  report: unknown,
  selectedProjects: string[],
): ExecutedPlaywrightTestV1[];

export function hasTargetedPlaywrightSelection(args: string[]): boolean;
