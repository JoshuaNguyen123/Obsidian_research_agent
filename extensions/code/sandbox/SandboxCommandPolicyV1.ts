/**
 * What `code_sandbox_run` may run (CODE-17, D-283, the host's
 * docs/security/SANDBOX-COMMANDS.md): one program and its arguments, in the
 * verified sandbox, with the network off and nothing written back.
 *
 * This mirrors the host's `commandPolicy` (src/shared/code/commands.ts),
 * which the person's Command tab reads, and is held to the same cases. The
 * sandbox's boundary is what keeps a command safe; these rules keep the
 * answer honest: a shell, a launcher, an install that would only time out
 * with no network, or an argument the provider refuses is refused here in
 * words, before anything is prepared. The agent gives an argv, never a line,
 * so nothing is split or expanded: an argument is passed to the program as
 * it is written.
 */

/**
 * The programs a command may name: the Node and Python ecosystems'
 * executables the profile parser takes and the runtime carries. `npx` is not
 * one, so `npm exec` stands in for it.
 */
export const CODE_SANDBOX_RUN_PROGRAMS_V1 = ["node", "npm", "python", "python3"] as const;
export type CodeSandboxRunProgramV1 = (typeof CODE_SANDBOX_RUN_PROGRAMS_V1)[number];

/** The ecosystem a program is prepared under, which the one-command profile pins. */
export const CODE_SANDBOX_RUN_ECOSYSTEM_V1: Readonly<Record<CodeSandboxRunProgramV1, "node" | "python">> = {
  node: "node",
  npm: "node",
  python: "python",
  python3: "python",
};

/** The agent's default time limit and its bounds (the person's tab allows 30 minutes). */
export const CODE_SANDBOX_RUN_DEFAULT_TIMEOUT_SECONDS_V1 = 120;
export const CODE_SANDBOX_RUN_MIN_TIMEOUT_SECONDS_V1 = 1;
export const CODE_SANDBOX_RUN_MAX_TIMEOUT_SECONDS_V1 = 600;
/** The task's argument limits, which the host's policy shares. */
export const CODE_SANDBOX_RUN_MAX_ARGS_V1 = 64;
export const CODE_SANDBOX_RUN_MAX_ARG_CHARS_V1 = 500;

export const CODE_SANDBOX_RUN_INSTALL_REFUSAL_V1 =
  "Installing needs the network, which the sandbox does not have. Dependencies come from the repository's own bootstrap, approved where it is trusted.";

/** Programs refused by name, with why: a shell, or a program that only exists to run another one. */
const REFUSED_PROGRAMS: Readonly<Record<string, string>> = {
  sh: "a shell",
  bash: "a shell",
  dash: "a shell",
  zsh: "a shell",
  fish: "a shell",
  ksh: "a shell",
  pwsh: "a shell",
  powershell: "a shell",
  cmd: "a shell",
  busybox: "a shell",
  env: "a program that runs another program",
  xargs: "a program that runs another program",
  nohup: "a program that runs another program",
  timeout: "a program that runs another program",
  sudo: "a program that runs another program as another user",
  su: "a program that runs another program as another user",
  npx: "not one the sandbox's profile parser takes (npm exec runs a package's program)",
  pip: "an installer, and installing needs the network",
  pip3: "an installer, and installing needs the network",
};

/** Arguments the provider refuses anywhere in its command line, with what to use instead. */
const PROVIDER_REFUSED_ARGUMENTS: Readonly<Record<string, string>> = {
  "-v": "--verbose",
  "-H": "the long form",
  "--mount": "another name",
  "--volume": "another name",
  "--host": "another name",
  "--privileged": "another name",
};

export interface CodeSandboxRunRequestV1 {
  argv: readonly unknown[];
  cwd?: unknown;
  timeoutSeconds?: unknown;
}

export interface CodeSandboxRunCommandV1 {
  executable: CodeSandboxRunProgramV1;
  args: string[];
  /** Workspace-relative, `.` for the root. */
  cwd: string;
  timeoutMs: number;
  ecosystem: "node" | "python";
}

export type CodeSandboxRunRefusalCodeV1 =
  | "command_empty"
  | "command_program"
  | "command_args"
  | "command_sandbox_argument"
  | "command_install"
  | "command_cwd"
  | "command_timeout";

export type CodeSandboxRunDecisionV1 =
  | { ok: true; command: CodeSandboxRunCommandV1 }
  | { ok: false; code: CodeSandboxRunRefusalCodeV1; reason: string };

/**
 * What the sandbox will run for a request, or why it will not: a bare program
 * name from the list, arguments within the limits and free of what the
 * provider refuses, no install, a working folder inside the workspace, a time
 * limit within its bounds.
 */
export function codeSandboxRunPolicyV1(
  request: CodeSandboxRunRequestV1,
  options: { maxTimeoutSeconds?: number } = {},
): CodeSandboxRunDecisionV1 {
  const argv = Array.isArray(request?.argv) ? request.argv : [];
  if (argv.length === 0 || argv.some((word) => typeof word !== "string")) {
    return { ok: false, code: "command_empty", reason: "Give a program and its arguments as an argv, such as [\"python3\", \"-m\", \"pytest\", \"-q\"]." };
  }
  const [program, ...args] = argv as string[];
  if (!program) {
    return { ok: false, code: "command_empty", reason: "Give a program and its arguments as an argv, such as [\"python3\", \"-m\", \"pytest\", \"-q\"]." };
  }
  if (/[/\\]/u.test(program)) {
    return {
      ok: false,
      code: "command_program",
      reason: `Name the program, not a path to it: one of ${CODE_SANDBOX_RUN_PROGRAMS_V1.join(", ")}. A script runs through its interpreter, as python3 ${program.split(/[/\\]/u).pop() ?? program} does.`,
    };
  }
  const refused = REFUSED_PROGRAMS[program.toLowerCase().replace(/\.exe$/u, "")];
  if (refused) {
    return {
      ok: false,
      code: "command_program",
      reason: `${program} is ${refused}, so it does not run here: the sandbox runs one of ${CODE_SANDBOX_RUN_PROGRAMS_V1.join(", ")} and its arguments.`,
    };
  }
  if (!(CODE_SANDBOX_RUN_PROGRAMS_V1 as readonly string[]).includes(program)) {
    return {
      ok: false,
      code: "command_program",
      reason: `${program} is not a program the sandbox runs. It runs ${CODE_SANDBOX_RUN_PROGRAMS_V1.join(", ")}.`,
    };
  }
  const executable = program as CodeSandboxRunProgramV1;
  if (args.length > CODE_SANDBOX_RUN_MAX_ARGS_V1 || args.some((arg) => arg.length > CODE_SANDBOX_RUN_MAX_ARG_CHARS_V1)) {
    return {
      ok: false,
      code: "command_args",
      reason: `A command takes at most ${CODE_SANDBOX_RUN_MAX_ARGS_V1} arguments of ${CODE_SANDBOX_RUN_MAX_ARG_CHARS_V1} characters each.`,
    };
  }
  if (args.some((arg) => /[\r\n\0]/u.test(arg))) {
    return { ok: false, code: "command_args", reason: "An argument cannot hold a line break." };
  }
  // The one rule the host's policy does not have: its argv comes from a typed
  // line, which has no empty word unless it is quoted, and the profile parser
  // refuses an empty argument, so the agent hears why here, not as a
  // preparation failure.
  if (args.some((arg) => arg === "")) {
    return { ok: false, code: "command_args", reason: "An argument cannot be empty: leave it out." };
  }
  const providerRefusal = providerArgumentRefusal([executable, ...args]);
  if (providerRefusal) return { ok: false, code: "command_sandbox_argument", reason: providerRefusal };
  if (installRefused(executable, args)) {
    return { ok: false, code: "command_install", reason: CODE_SANDBOX_RUN_INSTALL_REFUSAL_V1 };
  }
  const cwd = normalizeCommandCwd(request.cwd);
  if (cwd === null) {
    return { ok: false, code: "command_cwd", reason: "The working folder must be inside the workspace, such as . or src." };
  }
  const maxSeconds = options.maxTimeoutSeconds ?? CODE_SANDBOX_RUN_MAX_TIMEOUT_SECONDS_V1;
  const seconds = request.timeoutSeconds === undefined || request.timeoutSeconds === null
    ? CODE_SANDBOX_RUN_DEFAULT_TIMEOUT_SECONDS_V1
    : Number(request.timeoutSeconds);
  if (!Number.isFinite(seconds) || seconds < CODE_SANDBOX_RUN_MIN_TIMEOUT_SECONDS_V1 || seconds > maxSeconds) {
    return {
      ok: false,
      code: "command_timeout",
      reason: `The time limit is between ${CODE_SANDBOX_RUN_MIN_TIMEOUT_SECONDS_V1} second and ${maxSeconds} seconds.`,
    };
  }
  return {
    ok: true,
    command: {
      executable,
      args: [...args],
      cwd,
      timeoutMs: Math.round(seconds * 1_000),
      ecosystem: CODE_SANDBOX_RUN_ECOSYSTEM_V1[executable],
    },
  };
}

/** An argv as it would be typed: each word quoted only when it needs to be. */
export function codeSandboxRunLineV1(argv: readonly string[]): string {
  return argv
    .map((word) => (word !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word) ? word : `'${word.replace(/'/gu, `'\\''`)}'`))
    .join(" ");
}

function providerArgumentRefusal(argv: readonly string[]): string | null {
  for (const argument of argv) {
    const instead = PROVIDER_REFUSED_ARGUMENTS[argument];
    if (instead) {
      return `The sandbox refuses the argument ${argument} anywhere in a command, because to a container it would mean a mount or the host. Use ${instead}${argument === "-v" ? " (python -m unittest and most tools take it)" : ""}.`;
    }
    const named = /docker\.sock|podman\.sock|\/var\/run/iu.exec(argument);
    if (named) return `The sandbox refuses an argument that names ${named[0]}.`;
    if (argument === "/") return "The sandbox refuses / as an argument: a command cannot name the root of a filesystem.";
  }
  return null;
}

/** Whether the arguments ask for an install, which needs the network. */
function installRefused(program: CodeSandboxRunProgramV1, args: readonly string[]): boolean {
  if (program === "npm") {
    const verb = args.find((arg) => !arg.startsWith("-"));
    return verb !== undefined && NPM_INSTALL_VERBS.has(verb);
  }
  const module = args.indexOf("-m");
  if (module >= 0 && (args[module + 1] === "pip" || args[module + 1] === "ensurepip")) {
    const verb = args.slice(module + 2).find((arg) => !arg.startsWith("-"));
    return args[module + 1] === "ensurepip" || verb === "install" || verb === "download" || verb === "wheel";
  }
  return false;
}

const NPM_INSTALL_VERBS = new Set([
  "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall",
  "ci", "add", "update", "up", "upgrade", "udpate", "clean-install", "install-clean", "install-test",
  "it", "cit", "link", "ln", "rebuild", "rb",
]);

function normalizeCommandCwd(input: unknown): string | null {
  if (input === undefined || input === null) return ".";
  if (typeof input !== "string") return null;
  const raw = input.trim().replace(/\\/gu, "/");
  if (raw === "" || raw === "." || raw === "./") return ".";
  if (raw.startsWith("/") || /^[A-Za-z]:/u.test(raw) || raw.startsWith("~")) return null;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." || /[\0\r\n]/u.test(part)) return null;
    if (part.toLowerCase() === ".git") return null;
    parts.push(part);
  }
  return parts.length === 0 ? "." : parts.join("/");
}
