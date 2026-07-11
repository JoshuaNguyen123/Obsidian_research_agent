import {
  createNodeValidationProfile,
  type ValidationCommand,
  type ValidationProfile,
} from "../../orchestrator/gitWorktreeManager";

export interface NodeNpmValidationProfileOptions {
  testScript?: string | false;
  buildScript?: string | false;
  additionalScripts?: string[];
  allowedGeneratedPaths?: string[];
}

/**
 * Create the locked-down Node/npm validation profile used by coding workers.
 * Package-manager execution controls remain delegated to GitWorktreeManager.
 */
export function createNodeNpmValidationProfile(
  options: NodeNpmValidationProfileOptions = {},
): ValidationProfile {
  const commands: ValidationCommand[] = [];
  if (options.testScript !== false) {
    commands.push(npmRunCommand(options.testScript ?? "test"));
  }
  if (options.buildScript !== false) {
    commands.push(npmRunCommand(options.buildScript ?? "build"));
  }
  for (const script of options.additionalScripts ?? []) {
    commands.push(npmRunCommand(assertNpmScriptName(script)));
  }
  return createNodeValidationProfile(commands, {
    allowedGeneratedPaths: options.allowedGeneratedPaths,
  });
}

function npmRunCommand(script: string): ValidationCommand {
  const safeScript = assertNpmScriptName(script);
  return {
    command: "npm",
    args: ["run", safeScript],
    label: `npm run ${safeScript}`,
  };
}

function assertNpmScriptName(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(normalized)) {
    throw new Error("npm script names may only contain safe package-script characters.");
  }
  return normalized;
}
