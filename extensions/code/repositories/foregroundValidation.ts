import type { PreparedSandboxActionV2 } from "../sandbox/SandboxManager";
import { CodeSandboxContributionErrorV2 } from "../sandbox/CodeExecutionContributionsV2";
import type { RepositoryProfileV2, RepositoryValidationCommandV2 } from "./RepositoryProfileV2";

/** Select a closed trusted command without silently omitting known checks. */
export function selectForegroundValidationCommand(
  profile: RepositoryProfileV2,
  projectId: string,
  purpose: PreparedSandboxActionV2["purpose"],
): RepositoryValidationCommandV2 {
  const catalog = profile.validationCatalog
    .filter(command => command.projectId === projectId)
    .sort((left, right) => left.id.localeCompare(right.id));
  const phase = purpose === "validation_fast" ? "fast"
    : purpose === "validation_targeted" || purpose === "code_block" ? "targeted"
    : purpose === "validation_full" ? "full" : "bootstrap";
  const exact = catalog.filter(command => command.phase === phase);
  const full = catalog.filter(command => command.phase === "full");
  const legacy = full.length > 0 && full.every(command => /^root-full-\d+$/u.test(command.id));
  if (legacy && ["validation_fast", "validation_targeted", "validation_full"].includes(purpose)) {
    // Historical two-command profiles bind test and build to targeted/full
    // receipts over one manifest. Three or more cannot be represented by
    // those two receipts; choosing just first/last would silently omit work.
    if (full.length > 2 && purpose === "validation_full") throw new CodeSandboxContributionErrorV2("sandbox_validation_scope_incomplete",
      "The migrated profile has more than two validation commands. Review a complete combined validation profile before full validation.");
    return purpose === "validation_full" ? full.at(-1)! : full[0];
  }
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new CodeSandboxContributionErrorV2("sandbox_validation_command_ambiguous",
    `The trusted repository profile has multiple ${phase} commands for project ${projectId}.`);
  // Older detected Node profiles have fast=test and full=build. Reuse the
  // existing approved test command for targeted validation, not build twice.
  const oldNodeBuild = full.length === 1 && profile.projects.some(project => project.id === projectId && project.ecosystems.includes("node"))
    && ["npm", "pnpm", "yarn"].includes(full[0].executable) && full[0].args.length === 2
    && full[0].args[0] === "run" && full[0].args[1] === "build";
  if (purpose === "validation_targeted" && oldNodeBuild) {
    const fast = catalog.filter(command => command.phase === "fast");
    if (fast.length === 1 && ["npm", "pnpm", "yarn"].includes(fast[0].executable)
      && fast[0].args.length === 2 && fast[0].args[0] === "run" && fast[0].args[1] === "test") return fast[0];
    if (fast.length > 1) throw new CodeSandboxContributionErrorV2("sandbox_validation_command_ambiguous",
      `The trusted repository profile has multiple fast commands for project ${projectId}.`);
    throw new CodeSandboxContributionErrorV2("sandbox_validation_scope_incomplete",
      "The trusted Node profile declares a build without an unambiguous test command. Review a complete validation profile.");
  }
  if (full.length === 1 && ["validation_fast", "validation_targeted", "validation_full"].includes(purpose)) return full[0];
  throw new CodeSandboxContributionErrorV2("sandbox_validation_command_unavailable",
    `The trusted repository profile has no unambiguous ${phase} command for project ${projectId}.`);
}
