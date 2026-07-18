import { portableSha256Text } from "../../../packages/core-api/src/portableSha256";

import type { RepositoryProfileV1 } from "../../../src/agent/repositories/RepositoryProfile";
import { createNodeNpmValidationProfile } from "../../../src/agent/repositories/NodeNpmValidationProfile";

export const REPOSITORY_PROFILE_V2_SCHEMA_VERSION = 2 as const;

export type RepositoryEcosystemV2 =
  | "node"
  | "python"
  | "rust"
  | "go"
  | "java_maven"
  | "java_gradle"
  | "c_cpp"
  | "dotnet";

export type ProtectedControlKindV2 =
  | "manifest"
  | "lockfile"
  | "build_script"
  | "wrapper"
  | "workflow"
  | "hook"
  | "git_config";

export type ProtectedControlApprovalV2 = "exact_diff" | "double_exact";
export type ValidationPhaseV2 = "bootstrap" | "fast" | "targeted" | "full";

export interface RepositoryProjectV2 {
  id: string;
  root: string;
  ecosystems: RepositoryEcosystemV2[];
  allowedPaths: string[];
}

export interface RepositoryProtectedControlV2 {
  path: string;
  kind: ProtectedControlKindV2;
  approval: ProtectedControlApprovalV2;
}

export interface RepositoryPinnedRuntimeV2 {
  projectId: string;
  ecosystem: RepositoryEcosystemV2;
  executable: string;
  version: string;
  source: "repository_pin" | "repository_wrapper" | "immutable_digest";
  digest: string | null;
  approval: "none" | "one_time_exact_digest";
}

export interface RepositoryValidationCommandV2 {
  id: string;
  phase: ValidationPhaseV2;
  projectId: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  network: "disabled" | "exact_approval_required";
  credentialPolicy: "none";
  lockfile: string | null;
}

export interface RepositoryMergePolicyV2 {
  allowedMethods: Array<"squash" | "merge" | "rebase">;
  defaultMethod: "squash" | "merge" | "rebase";
  requireFreshRequiredChecks: true;
  requireSeparateMergeApproval: true;
  forbidForcePush: true;
}

export interface RepositoryProfileV2 {
  schemaVersion: typeof REPOSITORY_PROFILE_V2_SCHEMA_VERSION;
  key: string;
  displayName: string;
  repositoryRoot: string;
  defaultBranch: string;
  projects: RepositoryProjectV2[];
  ecosystems: RepositoryEcosystemV2[];
  allowedPaths: string[];
  protectedControls: RepositoryProtectedControlV2[];
  pinnedRuntimes: RepositoryPinnedRuntimeV2[];
  validationCatalog: RepositoryValidationCommandV2[];
  generatedOutputs: string[];
  requiredGitHubChecks: string[];
  mergePolicy: RepositoryMergePolicyV2;
}

export interface RepositoryDetectionInputV2 {
  key: string;
  displayName: string;
  repositoryRoot: string;
  defaultBranch: string;
  files: readonly string[];
  fileContents?: Readonly<Record<string, string>>;
  fileHashes?: Readonly<Record<string, string>>;
  runtimeDigests?: Partial<Record<RepositoryEcosystemV2, string>>;
  allowedPaths?: readonly string[];
  generatedOutputs?: readonly string[];
  requiredGitHubChecks?: readonly string[];
}

export interface RepositoryProfileAdapterV2 {
  ecosystem: RepositoryEcosystemV2;
  marker(path: string): boolean;
  contribute(context: AdapterContextV2): AdapterContributionV2;
}

export interface RepositoryFileChangeV2 {
  path: string;
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface ProtectedControlClassificationV2 {
  level: "none" | "exact_diff" | "double_exact" | "blocked";
  approvalCount?: 1 | 2;
  exactDiffFingerprint: string;
  matchedControls: RepositoryProtectedControlV2[];
  blockedPaths: string[];
}

interface AdapterContextV2 {
  projectId: string;
  projectRoot: string;
  files: string[];
  fileContents: Readonly<Record<string, string>>;
  fileHashes: Readonly<Record<string, string>>;
  runtimeDigest: string | undefined;
}

interface AdapterContributionV2 {
  runtime: RepositoryPinnedRuntimeV2;
  commands: RepositoryValidationCommandV2[];
  generatedOutputs: string[];
}

export class RepositoryProfileV2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryProfileV2Error";
  }
}

const ECOSYSTEMS: readonly RepositoryEcosystemV2[] = [
  "node",
  "python",
  "rust",
  "go",
  "java_maven",
  "java_gradle",
  "c_cpp",
  "dotnet",
];

const COMMANDS_BY_ECOSYSTEM: Readonly<Record<RepositoryEcosystemV2, readonly string[]>> = {
  node: ["npm", "pnpm", "yarn", "node"],
  python: ["python", "python3", "py", "uv", "poetry", "pipenv"],
  rust: ["cargo"],
  go: ["go"],
  java_maven: ["mvn", "./mvnw"],
  java_gradle: ["gradle", "./gradlew"],
  c_cpp: ["cmake", "ctest", "ninja", "make", "conan"],
  dotnet: ["dotnet"],
};

const MANIFEST_BASENAMES = new Set([
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml",
  "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "CMakeLists.txt", "meson.build", "conanfile.py", "conanfile.txt", "vcpkg.json",
  "Directory.Build.props", "Directory.Build.targets", "global.json",
]);
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
  "uv.lock", "poetry.lock", "Pipfile.lock", "requirements.txt", "Cargo.lock",
  "go.sum", "gradle.lockfile", "conan.lock", "packages.lock.json",
]);

export const REPOSITORY_PROFILE_V2_ADAPTERS: readonly RepositoryProfileAdapterV2[] = [
  nodeAdapter(),
  pythonAdapter(),
  rustAdapter(),
  goAdapter(),
  mavenAdapter(),
  gradleAdapter(),
  cppAdapter(),
  dotnetAdapter(),
];

export function createRepositoryProfileV2(
  value: Omit<RepositoryProfileV2, "schemaVersion"> & { schemaVersion?: 2 },
): RepositoryProfileV2 {
  return parseRepositoryProfileV2({ ...value, schemaVersion: 2 });
}

/** Parse the fully closed V2 contract. Unknown and missing keys fail closed. */
export function parseRepositoryProfileV2(value: unknown): RepositoryProfileV2 {
  const record = exactRecord(
    value,
    [
      "schemaVersion", "key", "displayName", "repositoryRoot", "defaultBranch",
      "projects", "ecosystems", "allowedPaths", "protectedControls",
      "pinnedRuntimes", "validationCatalog", "generatedOutputs",
      "requiredGitHubChecks", "mergePolicy",
    ],
    "repository profile V2",
  );
  if (record.schemaVersion !== 2) fail("Unsupported RepositoryProfileV2 schema version.");
  const projects = array(record.projects, "projects", 1, 64).map(parseProject);
  const ecosystems = uniqueEcosystems(record.ecosystems, "ecosystems");
  const projectEcosystems = new Set(projects.flatMap((project) => project.ecosystems));
  if (
    ecosystems.length !== projectEcosystems.size ||
    ecosystems.some((ecosystem) => !projectEcosystems.has(ecosystem))
  ) {
    fail("Repository ecosystems must exactly equal the project ecosystem union.");
  }
  const projectIds = new Set(projects.map((project) => project.id));
  if (projectIds.size !== projects.length) fail("Repository project ids must be unique.");
  if (new Set(projects.map((project) => project.root)).size !== projects.length) {
    fail("Repository project roots must be unique.");
  }
  const protectedControls = array(
    record.protectedControls,
    "protectedControls",
    0,
    256,
  ).map(parseProtectedControl);
  if (
    new Set(protectedControls.map((control) => control.path)).size !==
    protectedControls.length
  ) {
    fail("Protected control paths must be unique.");
  }
  const pinnedRuntimes = array(
    record.pinnedRuntimes,
    "pinnedRuntimes",
    projects.reduce((total, project) => total + project.ecosystems.length, 0),
    projects.reduce((total, project) => total + project.ecosystems.length, 0),
  ).map((entry) => parsePinnedRuntime(entry, projects));
  const expectedRuntimeKeys = projects.flatMap((project) =>
    project.ecosystems.map((ecosystem) => `${project.id}:${ecosystem}`),
  );
  if (
    new Set(
      pinnedRuntimes.map(
        (runtime) => `${runtime.projectId}:${runtime.ecosystem}`,
      ),
    ).size !== expectedRuntimeKeys.length ||
    expectedRuntimeKeys.some(
      (key) =>
        !pinnedRuntimes.some(
          (runtime) => `${runtime.projectId}:${runtime.ecosystem}` === key,
        ),
    )
  ) {
    fail("Pinned runtimes must contain exactly one entry per project ecosystem.");
  }
  const validationCatalog = array(
    record.validationCatalog,
    "validationCatalog",
    1,
    128,
  ).map((entry) => parseValidationCommand(entry, projects));
  if (new Set(validationCatalog.map((command) => command.id)).size !== validationCatalog.length) {
    fail("Validation command ids must be unique.");
  }
  const mergePolicy = parseMergePolicy(record.mergePolicy);
  const requiredGitHubChecks = uniqueStrings(
    record.requiredGitHubChecks,
    "requiredGitHubChecks",
    0,
    64,
    200,
  );
  if (mergePolicy.requireFreshRequiredChecks !== true) {
    fail("Merge policy must require fresh required checks.");
  }
  const allowedPaths = uniquePaths(record.allowedPaths, "allowedPaths", 1, 256, true);
  if (
    projects.some((project) =>
      project.allowedPaths.some((path) => !allowedPaths.includes(path)),
    ) ||
    allowedPaths.some(
      (path) => !projects.some((project) => isAtOrBelow(project.root, path)),
    )
  ) {
    fail("Top-level allowed paths must contain only project-declared allowed paths.");
  }
  return {
    schemaVersion: 2,
    key: identifier(record.key, "profile key"),
    displayName: text(record.displayName, "display name", 1, 160),
    repositoryRoot: absolutePath(record.repositoryRoot),
    defaultBranch: branch(record.defaultBranch),
    projects,
    ecosystems,
    allowedPaths,
    protectedControls,
    pinnedRuntimes,
    validationCatalog,
    generatedOutputs: uniquePaths(record.generatedOutputs, "generatedOutputs", 0, 256, false),
    requiredGitHubChecks,
    mergePolicy,
  };
}

/** Detect a closed profile from a bounded repository-relative file inventory. */
export function detectRepositoryProfileV2(input: RepositoryDetectionInputV2): RepositoryProfileV2 {
  const files = uniquePaths(input.files, "repository files", 1, 20_000, false);
  const contents = normalizeKeyedRecord(input.fileContents ?? {}, files, "fileContents");
  const hashes = normalizeHashRecord(input.fileHashes ?? {}, files, "fileHashes");
  const grouped = new Map<string, Set<RepositoryEcosystemV2>>();
  for (const file of files) {
    for (const adapter of REPOSITORY_PROFILE_V2_ADAPTERS) {
      if (!adapter.marker(file)) continue;
      const root = directory(file);
      const existing = grouped.get(root) ?? new Set<RepositoryEcosystemV2>();
      existing.add(adapter.ecosystem);
      grouped.set(root, existing);
    }
  }
  if (grouped.size === 0) {
    fail("No supported repository ecosystem marker was detected.");
  }

  const projects: RepositoryProjectV2[] = [];
  const runtimes = new Map<string, RepositoryPinnedRuntimeV2>();
  const commands: RepositoryValidationCommandV2[] = [];
  const adapterOutputs = new Set<string>();
  const sortedGroups = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (let index = 0; index < sortedGroups.length; index += 1) {
    const [root, detected] = sortedGroups[index];
    const projectId = projectIdentifier(root, index);
    const ecosystems = [...detected].sort(ecosystemOrder);
    const projectFiles = files.filter((file) => isAtOrBelow(root, file));
    projects.push({
      id: projectId,
      root,
      ecosystems,
      allowedPaths: [root],
    });
    for (const ecosystem of ecosystems) {
      const adapter = REPOSITORY_PROFILE_V2_ADAPTERS.find(
        (candidate) => candidate.ecosystem === ecosystem,
      )!;
      const contribution = adapter.contribute({
        projectId,
        projectRoot: root,
        files: projectFiles,
        fileContents: contents,
        fileHashes: hashes,
        runtimeDigest: input.runtimeDigests?.[ecosystem],
      });
      runtimes.set(`${projectId}:${ecosystem}`, contribution.runtime);
      commands.push(...contribution.commands);
      contribution.generatedOutputs.forEach((path) => adapterOutputs.add(path));
    }
  }
  const ecosystems = [
    ...new Set(projects.flatMap((project) => project.ecosystems)),
  ].sort(ecosystemOrder);
  const allowedPaths = input.allowedPaths
    ? uniquePaths(input.allowedPaths, "allowedPaths", 1, 256, true)
    : [...new Set(projects.flatMap((project) => project.allowedPaths))].sort();
  const projectsWithAllowedPaths = projects.map((project) => {
    const scoped = allowedPaths.filter((path) => isAtOrBelow(project.root, path));
    if (scoped.length === 0) {
      fail(`Allowed paths do not grant any scope to project ${project.id}.`);
    }
    return { ...project, allowedPaths: scoped };
  });
  return parseRepositoryProfileV2({
    schemaVersion: 2,
    key: input.key,
    displayName: input.displayName,
    repositoryRoot: input.repositoryRoot,
    defaultBranch: input.defaultBranch,
    projects: projectsWithAllowedPaths,
    ecosystems,
    allowedPaths,
    protectedControls: detectProtectedControls(files),
    pinnedRuntimes: [...runtimes.values()].sort(
      (left, right) =>
        left.projectId.localeCompare(right.projectId) ||
        ecosystemOrder(left.ecosystem, right.ecosystem),
    ),
    validationCatalog: commands,
    generatedOutputs: input.generatedOutputs
      ? uniquePaths(input.generatedOutputs, "generatedOutputs", 0, 256, false)
      : [...adapterOutputs].sort(),
    requiredGitHubChecks: input.requiredGitHubChecks ?? [],
    mergePolicy: defaultRepositoryMergePolicyV2(),
  });
}

/** Preserve V1 policy while moving it into the richer closed V2 contract. */
export function migrateRepositoryProfileV1(profile: RepositoryProfileV1): RepositoryProfileV2 {
  const projectId = "root";
  const migratedExecutables = [
    ...profile.validationProfile.bootstrapCommands,
    ...profile.validationProfile.validationCommands,
  ].map((command) => command.command);
  const migratedEcosystems: RepositoryEcosystemV2[] = [
    ...(migratedExecutables.some((command) => ["npm", "node"].includes(command))
      ? ["node" as const]
      : []),
    ...(migratedExecutables.some((command) => ["py", "python", "python3"].includes(command))
      ? ["python" as const]
      : []),
  ];
  const pythonExecutable = migratedExecutables.find((command) =>
    ["py", "python", "python3"].includes(command),
  );
  const validationCatalog: RepositoryValidationCommandV2[] = [
    ...profile.validationProfile.bootstrapCommands.map((command, index) => ({
      id: `root-bootstrap-${index + 1}`,
      phase: "bootstrap" as const,
      projectId,
      executable: command.command,
      args: [...command.args],
      cwd: ".",
      timeoutMs: 300_000,
      network: "exact_approval_required" as const,
      credentialPolicy: "none" as const,
      lockfile: findNodeLockfile(profile.validationProfile.protectedPaths),
    })),
    ...profile.validationProfile.validationCommands.map((command, index) => ({
      id: `root-full-${index + 1}`,
      phase: "full" as const,
      projectId,
      executable: command.command,
      args: [...command.args],
      cwd: ".",
      timeoutMs: 300_000,
      network: "disabled" as const,
      credentialPolicy: "none" as const,
      lockfile: null,
    })),
  ];
  return parseRepositoryProfileV2({
    schemaVersion: 2,
    key: profile.key,
    displayName: profile.displayName,
    repositoryRoot: profile.repositoryRoot,
    defaultBranch: profile.defaultBranch,
    projects: [{ id: projectId, root: ".", ecosystems: migratedEcosystems, allowedPaths: profile.allowedPathPrefixes }],
    ecosystems: migratedEcosystems,
    allowedPaths: profile.allowedPathPrefixes,
    protectedControls: profile.validationProfile.protectedPaths.map(protectedControlForPath),
    pinnedRuntimes: migratedEcosystems.map((ecosystem) =>
      unresolvedRuntime(
        projectId,
        ecosystem,
        ecosystem === "python" ? (pythonExecutable ?? "python") : "node",
        ecosystem === "node" || ecosystem === "python"
          ? profile.runtimeDigests?.[ecosystem]
          : undefined,
      )),
    validationCatalog,
    generatedOutputs: profile.validationProfile.allowedGeneratedPaths,
    requiredGitHubChecks: profile.promotionPolicy.requiredChecks,
    mergePolicy: defaultRepositoryMergePolicyV2(),
  });
}

export function defaultRepositoryMergePolicyV2(): RepositoryMergePolicyV2 {
  return {
    allowedMethods: ["squash"],
    defaultMethod: "squash",
    requireFreshRequiredChecks: true,
    requireSeparateMergeApproval: true,
    forbidForcePush: true,
  };
}

export function repositoryProfileExecutionBlockersV2(profile: RepositoryProfileV2): string[] {
  const parsed = parseRepositoryProfileV2(profile);
  return parsed.pinnedRuntimes
    .filter((runtime) => runtime.approval === "one_time_exact_digest" && !runtime.digest)
    .map(
      (runtime) =>
        `runtime_digest_required:${runtime.projectId}:${runtime.ecosystem}`,
    );
}

/** Classify protected control changes; the host owns approval and authorization. */
export function classifyProtectedControlChangesV2(
  profile: RepositoryProfileV2,
  changes: readonly RepositoryFileChangeV2[],
): ProtectedControlClassificationV2 {
  const parsed = parseRepositoryProfileV2(profile);
  if (changes.length === 0 || changes.length > 100) {
    fail("Protected-control classification requires 1-100 file changes.");
  }
  const normalized = changes.map((change) => ({
    path: safeRelativePath(change.path, "change path", false),
    beforeSha256: nullableFingerprint(change.beforeSha256, "beforeSha256"),
    afterSha256: nullableFingerprint(change.afterSha256, "afterSha256"),
  })).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(normalized.map((change) => change.path)).size !== normalized.length) {
    fail("Protected-control changes must use unique paths.");
  }
  const blockedPaths = normalized
    .map((change) => change.path)
    .filter(
      (path) =>
        isGitInternalsPath(path) &&
        path !== ".git/config" &&
        !path.startsWith(".git/hooks/"),
    );
  const matchedControls = parsed.protectedControls.filter((control) =>
    normalized.some((change) => pathMatches(control.path, change.path)),
  );
  const fingerprint = sha256Canonical({
    version: 1,
    profileKey: parsed.key,
    changes: normalized,
  });
  if (blockedPaths.length > 0) {
    return {
      level: "blocked",
      exactDiffFingerprint: fingerprint,
      matchedControls,
      blockedPaths,
    };
  }
  const double = matchedControls.some((control) => control.approval === "double_exact");
  const exact = matchedControls.length > 0;
  return {
    level: double ? "double_exact" : exact ? "exact_diff" : "none",
    ...(double ? { approvalCount: 2 as const } : exact ? { approvalCount: 1 as const } : {}),
    exactDiffFingerprint: fingerprint,
    matchedControls,
    blockedPaths: [],
  };
}

function nodeAdapter(): RepositoryProfileAdapterV2 {
  return {
    ecosystem: "node",
    marker: (path) => basename(path) === "package.json",
    contribute(context) {
      const legacy = createNodeNpmValidationProfile();
      const root = context.projectRoot;
      const lockfile = firstExisting(context.files, root, [
        "npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
      ]);
      const manager = lockfile?.endsWith("pnpm-lock.yaml")
        ? "pnpm"
        : lockfile?.endsWith("yarn.lock") ? "yarn" : "npm";
      const bootstrap = lockfile
        ? [command(context, "bootstrap", `${manager}-restore`, manager,
          manager === "npm"
            ? ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]
            : manager === "pnpm"
              ? ["install", "--frozen-lockfile", "--ignore-scripts"]
              : ["install", "--immutable", "--ignore-scripts"],
          "exact_approval_required", lockfile, 300_000)]
        : [];
      return {
        runtime: runtimeFromPin(context, "node", "node", [".nvmrc", ".node-version"]),
        commands: [
          ...bootstrap,
          ...legacy.validationCommands.map((entry, index) => command(
            context,
            index === 0 ? "fast" : "full",
            `npm-${entry.args.at(-1) ?? index + 1}`,
            entry.command,
            entry.args,
            "disabled",
            null,
            300_000,
          )),
        ],
        generatedOutputs: [atRoot(root, "dist")],
      };
    },
  };
}

function pythonAdapter(): RepositoryProfileAdapterV2 {
  return {
    ecosystem: "python",
    marker: (path) => ["pyproject.toml", "requirements.txt", "uv.lock", "poetry.lock", "Pipfile.lock"].includes(basename(path)),
    contribute(context) {
      const lock = firstExisting(context.files, context.projectRoot, ["uv.lock", "poetry.lock", "Pipfile.lock", "requirements.txt"]);
      let executable = "python";
      let args = ["-m", "pip", "install", "--require-hashes", "-r", "requirements.txt"];
      if (lock?.endsWith("uv.lock")) [executable, args] = ["uv", ["sync", "--frozen"]];
      if (lock?.endsWith("poetry.lock")) [executable, args] = ["poetry", ["install", "--sync", "--no-interaction"]];
      if (lock?.endsWith("Pipfile.lock")) [executable, args] = ["pipenv", ["sync", "--dev"]];
      return {
        runtime: runtimeFromPin(context, "python", "python", [".python-version", "runtime.txt"]),
        commands: [
          ...(lock ? [command(context, "bootstrap", "python-restore", executable, args, "exact_approval_required", lock, 300_000)] : []),
          command(context, "fast", "python-pytest", "python", ["-m", "pytest", "-q"], "disabled", null, 300_000),
          command(context, "full", "python-pytest-full", "python", ["-m", "pytest"], "disabled", null, 600_000),
        ],
        generatedOutputs: [atRoot(context.projectRoot, ".coverage")],
      };
    },
  };
}

function rustAdapter(): RepositoryProfileAdapterV2 {
  return simpleAdapter("rust", ["Cargo.toml"], "cargo", ["Cargo.lock"],
    ["fetch", "--locked"], ["test", "--locked"], ["test", "--locked", "--all-targets"], ["target"]);
}

function goAdapter(): RepositoryProfileAdapterV2 {
  return simpleAdapter("go", ["go.mod"], "go", ["go.sum"],
    ["mod", "download"], ["test", "./..."], ["test", "-count=1", "./..."], []);
}

function mavenAdapter(): RepositoryProfileAdapterV2 {
  return {
    ecosystem: "java_maven",
    marker: (path) => basename(path) === "pom.xml",
    contribute(context) {
      const wrapper = firstExisting(context.files, context.projectRoot, ["mvnw"]);
      const executable = wrapper ? "./mvnw" : "mvn";
      return {
        runtime: wrapperRuntime(context, "java_maven", executable, wrapper),
        commands: [
          command(context, "fast", "maven-test", executable, ["-o", "test", "-DskipITs"], "disabled", null, 600_000),
          command(context, "full", "maven-verify", executable, ["-o", "verify"], "disabled", null, 900_000),
        ],
        generatedOutputs: [atRoot(context.projectRoot, "target")],
      };
    },
  };
}

function gradleAdapter(): RepositoryProfileAdapterV2 {
  return {
    ecosystem: "java_gradle",
    marker: (path) => ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].includes(basename(path)),
    contribute(context) {
      const wrapper = firstExisting(context.files, context.projectRoot, ["gradlew"]);
      const executable = wrapper ? "./gradlew" : "gradle";
      const lock = firstExisting(context.files, context.projectRoot, ["gradle.lockfile"]);
      return {
        runtime: wrapperRuntime(context, "java_gradle", executable, wrapper),
        commands: [
          ...(lock ? [command(context, "bootstrap", "gradle-restore", executable, ["dependencies", "--no-daemon"], "exact_approval_required", lock, 600_000)] : []),
          command(context, "fast", "gradle-test", executable, ["test", "--offline", "--no-daemon"], "disabled", null, 600_000),
          command(context, "full", "gradle-check", executable, ["check", "--offline", "--no-daemon"], "disabled", null, 900_000),
        ],
        generatedOutputs: [atRoot(context.projectRoot, "build")],
      };
    },
  };
}

function cppAdapter(): RepositoryProfileAdapterV2 {
  return {
    ecosystem: "c_cpp",
    marker: (path) => ["CMakeLists.txt", "meson.build", "conanfile.py", "conanfile.txt", "vcpkg.json", "Makefile"].includes(basename(path)),
    contribute(context) {
      const lock = firstExisting(context.files, context.projectRoot, ["conan.lock"]);
      return {
        runtime: unresolvedRuntime(
          context.projectId,
          "c_cpp",
          "cmake",
          context.runtimeDigest,
        ),
        commands: [
          ...(lock ? [command(context, "bootstrap", "conan-restore", "conan", ["install", ".", "--lockfile=conan.lock", "--build=never"], "exact_approval_required", lock, 600_000)] : []),
          command(context, "fast", "cmake-build", "cmake", ["--build", "build"], "disabled", null, 600_000),
          command(context, "full", "ctest", "ctest", ["--test-dir", "build", "--output-on-failure"], "disabled", null, 900_000),
        ],
        generatedOutputs: [atRoot(context.projectRoot, "build")],
      };
    },
  };
}

function dotnetAdapter(): RepositoryProfileAdapterV2 {
  return {
    ecosystem: "dotnet",
    marker: (path) => /\.(?:sln|csproj|fsproj)$/i.test(path),
    contribute(context) {
      const lock = context.files.find((path) => isAtOrBelow(context.projectRoot, path) && basename(path) === "packages.lock.json") ?? null;
      return {
        runtime: runtimeFromPin(context, "dotnet", "dotnet", ["global.json"]),
        commands: [
          ...(lock ? [command(context, "bootstrap", "dotnet-restore", "dotnet", ["restore", "--locked-mode"], "exact_approval_required", lock, 600_000)] : []),
          command(context, "fast", "dotnet-test", "dotnet", ["test", "--no-restore"], "disabled", null, 600_000),
          command(context, "full", "dotnet-test-release", "dotnet", ["test", "--no-restore", "--configuration", "Release"], "disabled", null, 900_000),
        ],
        generatedOutputs: [atRoot(context.projectRoot, "bin"), atRoot(context.projectRoot, "obj")],
      };
    },
  };
}

function simpleAdapter(
  ecosystem: RepositoryEcosystemV2,
  markers: string[],
  executable: string,
  locks: string[],
  restoreArgs: string[],
  fastArgs: string[],
  fullArgs: string[],
  outputs: string[],
): RepositoryProfileAdapterV2 {
  return {
    ecosystem,
    marker: (path) => markers.includes(basename(path)),
    contribute(context) {
      const lock = firstExisting(context.files, context.projectRoot, locks);
      return {
        runtime: unresolvedRuntime(
          context.projectId,
          ecosystem,
          executable,
          context.runtimeDigest,
        ),
        commands: [
          ...(lock ? [command(context, "bootstrap", `${ecosystem}-restore`, executable, restoreArgs, "exact_approval_required", lock, 600_000)] : []),
          command(context, "fast", `${ecosystem}-fast`, executable, fastArgs, "disabled", null, 600_000),
          command(context, "full", `${ecosystem}-full`, executable, fullArgs, "disabled", null, 900_000),
        ],
        generatedOutputs: outputs.map((output) => atRoot(context.projectRoot, output)),
      };
    },
  };
}

function command(
  context: AdapterContextV2,
  phase: ValidationPhaseV2,
  suffix: string,
  executable: string,
  args: string[],
  network: RepositoryValidationCommandV2["network"],
  lockfile: string | null,
  timeoutMs: number,
): RepositoryValidationCommandV2 {
  return {
    id: `${context.projectId}-${suffix}`.replace(/[^a-z0-9._-]/g, "-"),
    phase,
    projectId: context.projectId,
    executable,
    args: [...args],
    cwd: context.projectRoot,
    timeoutMs,
    network,
    credentialPolicy: "none",
    lockfile,
  };
}

function runtimeFromPin(
  context: AdapterContextV2,
  ecosystem: RepositoryEcosystemV2,
  executable: string,
  pinNames: string[],
): RepositoryPinnedRuntimeV2 {
  const pin = firstExisting(context.files, context.projectRoot, pinNames);
  if (!pin) {
    return unresolvedRuntime(
      context.projectId,
      ecosystem,
      executable,
      context.runtimeDigest,
    );
  }
  const content = context.fileContents[pin]?.trim() || "repository-defined";
  const digest = context.fileHashes[pin] ?? sha256Text(context.fileContents[pin] ?? pin);
  return {
    projectId: context.projectId,
    ecosystem,
    executable,
    version: content.slice(0, 128),
    source: "repository_pin",
    digest,
    approval: "none",
  };
}

function wrapperRuntime(
  context: AdapterContextV2,
  ecosystem: RepositoryEcosystemV2,
  executable: string,
  wrapper: string | null,
): RepositoryPinnedRuntimeV2 {
  if (!wrapper) {
    return unresolvedRuntime(
      context.projectId,
      ecosystem,
      executable,
      context.runtimeDigest,
    );
  }
  return {
    projectId: context.projectId,
    ecosystem,
    executable,
    version: "repository-wrapper",
    source: "repository_wrapper",
    digest: context.fileHashes[wrapper] ?? sha256Text(context.fileContents[wrapper] ?? wrapper),
    approval: "none",
  };
}

function unresolvedRuntime(
  projectId: string,
  ecosystem: RepositoryEcosystemV2,
  executable: string,
  digest: string | undefined,
): RepositoryPinnedRuntimeV2 {
  return {
    projectId,
    ecosystem,
    executable,
    version: "unresolved",
    source: "immutable_digest",
    digest: digest ? fingerprint(digest, `${ecosystem} runtime digest`) : null,
    approval: "one_time_exact_digest",
  };
}

function detectProtectedControls(files: readonly string[]): RepositoryProtectedControlV2[] {
  const controls = new Map<string, RepositoryProtectedControlV2>();
  addControl(controls, ".github/workflows", "workflow", "double_exact");
  addControl(controls, ".github/actions", "workflow", "double_exact");
  addControl(controls, ".githooks", "hook", "double_exact");
  addControl(controls, ".husky", "hook", "double_exact");
  addControl(controls, ".git/hooks", "hook", "double_exact");
  addControl(controls, ".git/config", "git_config", "exact_diff");
  addControl(controls, "scripts", "build_script", "exact_diff");
  for (const path of files) {
    const base = basename(path);
    if (path.startsWith(".github/workflows/")) addControl(controls, ".github/workflows", "workflow", "double_exact");
    if (path.startsWith(".github/actions/")) addControl(controls, ".github/actions", "workflow", "double_exact");
    if (path.startsWith(".githooks/") || path.startsWith(".husky/") || path.startsWith(".git/hooks/")) {
      const root = path.startsWith(".husky/") ? ".husky" : path.startsWith(".githooks/") ? ".githooks" : ".git/hooks";
      addControl(controls, root, "hook", "double_exact");
    }
    if (path === ".git/config") addControl(controls, path, "git_config", "exact_diff");
    if (MANIFEST_BASENAMES.has(base) || /\.(?:csproj|fsproj|sln)$/i.test(base)) {
      addControl(controls, path, "manifest", "exact_diff");
    }
    if (LOCKFILE_BASENAMES.has(base) || base.endsWith(".lockfile")) {
      addControl(controls, path, "lockfile", "exact_diff");
    }
    if (
      base === "Makefile" || base === "Dockerfile" || base.startsWith("Dockerfile.") ||
      /^(?:build|vite|webpack|rollup|esbuild|jest|vitest|tsconfig)[.-]/i.test(base) ||
      path.startsWith("scripts/")
    ) addControl(controls, path, "build_script", "exact_diff");
    if (base === "mvnw" || base === "gradlew" || path.includes("/wrapper/")) {
      addControl(controls, path, "wrapper", "exact_diff");
    }
  }
  return [...controls.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function protectedControlForPath(path: string): RepositoryProtectedControlV2 {
  const normalized = safeRelativePath(path, "protected path", false);
  if (normalized.startsWith(".github/workflows") || normalized.startsWith(".github/actions")) return { path: normalized, kind: "workflow", approval: "double_exact" };
  if (normalized.startsWith(".githooks") || normalized.startsWith(".husky") || normalized.startsWith(".git/hooks")) {
    return { path: normalized, kind: "hook", approval: "double_exact" };
  }
  if (normalized === ".git/config") return { path: normalized, kind: "git_config", approval: "exact_diff" };
  if (LOCKFILE_BASENAMES.has(basename(normalized))) return { path: normalized, kind: "lockfile", approval: "exact_diff" };
  if (MANIFEST_BASENAMES.has(basename(normalized))) return { path: normalized, kind: "manifest", approval: "exact_diff" };
  return { path: normalized, kind: "build_script", approval: "exact_diff" };
}

function parseProject(value: unknown): RepositoryProjectV2 {
  const record = exactRecord(value, ["id", "root", "ecosystems", "allowedPaths"], "repository project");
  const root = safeRelativePath(record.root, "project root", true);
  const allowedPaths = uniquePaths(record.allowedPaths, "project allowedPaths", 1, 256, true);
  if (allowedPaths.some((path) => !isAtOrBelow(root, path))) fail("Project allowed paths must remain under the project root.");
  return { id: identifier(record.id, "project id"), root, ecosystems: uniqueEcosystems(record.ecosystems, "project ecosystems"), allowedPaths };
}

function parseProtectedControl(value: unknown): RepositoryProtectedControlV2 {
  const record = exactRecord(value, ["path", "kind", "approval"], "protected control");
  const kind = enumValue(record.kind, ["manifest", "lockfile", "build_script", "wrapper", "workflow", "hook", "git_config"] as const, "protected control kind");
  const approval = enumValue(record.approval, ["exact_diff", "double_exact"] as const, "protected control approval");
  if ((kind === "workflow" || kind === "hook") && approval !== "double_exact") fail("Workflow and hook controls require double-exact approval.");
  if (kind !== "workflow" && kind !== "hook" && approval !== "exact_diff") fail("Non-workflow protected controls require exact-diff approval.");
  return { path: safeRelativePath(record.path, "protected control path", false), kind, approval };
}

function parsePinnedRuntime(
  value: unknown,
  projects: readonly RepositoryProjectV2[],
): RepositoryPinnedRuntimeV2 {
  const record = exactRecord(value, ["projectId", "ecosystem", "executable", "version", "source", "digest", "approval"], "pinned runtime");
  const projectId = identifier(record.projectId, "runtime project id");
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) fail("Pinned runtime references an unknown project.");
  const ecosystem = ecosystemValue(record.ecosystem, "runtime ecosystem");
  if (!project.ecosystems.includes(ecosystem)) {
    fail("Pinned runtime ecosystem is not declared by its project.");
  }
  const executable = executableValue(record.executable, ecosystem);
  const source = enumValue(record.source, ["repository_pin", "repository_wrapper", "immutable_digest"] as const, "runtime source");
  const approval = enumValue(record.approval, ["none", "one_time_exact_digest"] as const, "runtime approval");
  const digest = record.digest === null ? null : fingerprint(record.digest, "runtime digest");
  if ((source === "repository_pin" || source === "repository_wrapper") && (!digest || approval !== "none")) {
    fail("Repository-pinned runtimes require a verified digest and no extra approval.");
  }
  if (source === "immutable_digest" && approval !== "one_time_exact_digest") {
    fail("Host runtime digests require one-time exact confirmation.");
  }
  return { projectId, ecosystem, executable, version: text(record.version, "runtime version", 1, 128), source, digest, approval };
}

function parseValidationCommand(
  value: unknown,
  projects: readonly RepositoryProjectV2[],
): RepositoryValidationCommandV2 {
  const record = exactRecord(value, ["id", "phase", "projectId", "executable", "args", "cwd", "timeoutMs", "network", "credentialPolicy", "lockfile"], "validation command");
  const projectId = identifier(record.projectId, "validation project id");
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) fail("Validation command references an unknown project.");
  const executable = text(record.executable, "validation executable", 1, 128);
  if (!project.ecosystems.some((ecosystem) => COMMANDS_BY_ECOSYSTEM[ecosystem].includes(executable))) {
    fail(`Validation executable is not allowed by the detected ecosystems: ${executable}.`);
  }
  const args = uniqueOrRepeatedStrings(record.args, "validation args", 0, 64, 500);
  if (args.some((argument) => /[\r\n\0]/.test(argument))) fail("Validation args contain control characters.");
  const phase = enumValue(record.phase, ["bootstrap", "fast", "targeted", "full"] as const, "validation phase");
  const network = enumValue(record.network, ["disabled", "exact_approval_required"] as const, "validation network mode");
  const lockfile = record.lockfile === null ? null : safeRelativePath(record.lockfile, "validation lockfile", false);
  if (phase === "bootstrap" && (!lockfile || network !== "exact_approval_required")) {
    fail("Bootstrap commands require a declared lockfile and exact network approval.");
  }
  if (phase !== "bootstrap" && (lockfile !== null || network !== "disabled")) {
    fail("Validation commands must run offline and cannot declare bootstrap lockfiles.");
  }
  if (record.credentialPolicy !== "none") fail("Sandbox validation commands cannot receive application credentials.");
  const cwd = safeRelativePath(record.cwd, "validation cwd", true);
  if (!isAtOrBelow(project.root, cwd)) {
    fail("Validation cwd must remain inside its declared project.");
  }
  if (lockfile && !isAtOrBelow(project.root, lockfile)) {
    fail("Validation lockfile must remain inside its declared project.");
  }
  const parsed: RepositoryValidationCommandV2 = {
    id: identifier(record.id, "validation command id"),
    phase,
    projectId,
    executable,
    args,
    cwd,
    timeoutMs: integer(record.timeoutMs, "validation timeout", 1_000, 1_800_000),
    network,
    credentialPolicy: "none",
    lockfile,
  };
  if (phase === "bootstrap") assertExactLockfileRestore(parsed);
  return parsed;
}

function assertExactLockfileRestore(
  command: RepositoryValidationCommandV2,
): void {
  const signature = `${command.executable}\0${command.args.join("\0")}`;
  const exact = new Set([
    "npm\0ci\0--ignore-scripts\0--no-audit\0--no-fund",
    "pnpm\0install\0--frozen-lockfile\0--ignore-scripts",
    "yarn\0install\0--immutable\0--ignore-scripts",
    "uv\0sync\0--frozen",
    "poetry\0install\0--sync\0--no-interaction",
    "pipenv\0sync\0--dev",
    "cargo\0fetch\0--locked",
    "go\0mod\0download",
    "gradle\0dependencies\0--no-daemon",
    "./gradlew\0dependencies\0--no-daemon",
    "conan\0install\0.\0--lockfile=conan.lock\0--build=never",
    "dotnet\0restore\0--locked-mode",
  ]);
  const hashedRequirements =
    (command.executable === "python" || command.executable === "py") &&
    command.args.join("\0") ===
      "-m\0pip\0install\0--require-hashes\0-r\0requirements.txt";
  if (!exact.has(signature) && !hashedRequirements) {
    fail("Bootstrap command is not an exact lockfile restoration signature.");
  }
}

function parseMergePolicy(value: unknown): RepositoryMergePolicyV2 {
  const record = exactRecord(value, ["allowedMethods", "defaultMethod", "requireFreshRequiredChecks", "requireSeparateMergeApproval", "forbidForcePush"], "merge policy");
  const allowedMethods = array(record.allowedMethods, "allowed merge methods", 1, 3).map((entry) => enumValue(entry, ["squash", "merge", "rebase"] as const, "merge method"));
  if (new Set(allowedMethods).size !== allowedMethods.length) fail("Allowed merge methods must be unique.");
  const defaultMethod = enumValue(record.defaultMethod, ["squash", "merge", "rebase"] as const, "default merge method");
  if (!allowedMethods.includes(defaultMethod)) fail("Default merge method must be allowed.");
  if (record.requireFreshRequiredChecks !== true || record.requireSeparateMergeApproval !== true || record.forbidForcePush !== true) {
    fail("Merge policy cannot disable fresh checks, separate approval, or force-push protection.");
  }
  return { allowedMethods, defaultMethod, requireFreshRequiredChecks: true, requireSeparateMergeApproval: true, forbidForcePush: true };
}

function uniqueEcosystems(value: unknown, label: string): RepositoryEcosystemV2[] {
  const output = array(value, label, 1, ECOSYSTEMS.length).map((entry) => ecosystemValue(entry, label));
  if (new Set(output).size !== output.length) fail(`${label} must be unique.`);
  return output.sort(ecosystemOrder);
}

function ecosystemValue(value: unknown, label: string): RepositoryEcosystemV2 {
  return enumValue(value, ECOSYSTEMS, label);
}

function executableValue(value: unknown, ecosystem: RepositoryEcosystemV2): string {
  const executable = text(value, "runtime executable", 1, 128);
  if (!COMMANDS_BY_ECOSYSTEM[ecosystem].includes(executable)) fail(`Runtime executable is not allowed for ${ecosystem}.`);
  return executable;
}

function normalizeKeyedRecord(
  value: Readonly<Record<string, string>>,
  files: readonly string[],
  label: string,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [rawPath, content] of Object.entries(value)) {
    const path = safeRelativePath(rawPath, `${label} path`, false);
    if (!files.includes(path)) fail(`${label} references a file outside the inventory.`);
    if (typeof content !== "string" || content.length > 2_000_000) fail(`${label} contains invalid or oversized content.`);
    output[path] = content;
  }
  return output;
}

function normalizeHashRecord(
  value: Readonly<Record<string, string>>,
  files: readonly string[],
  label: string,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [rawPath, hash] of Object.entries(value)) {
    const path = safeRelativePath(rawPath, `${label} path`, false);
    if (!files.includes(path)) fail(`${label} references a file outside the inventory.`);
    output[path] = fingerprint(hash, `${label} fingerprint`);
  }
  return output;
}

function uniquePaths(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  allowRoot: boolean,
): string[] {
  const output = array(value, label, minimum, maximum).map((entry) =>
    safeRelativePath(entry, label, allowRoot),
  );
  if (new Set(output).size !== output.length) fail(`${label} must not contain duplicates.`);
  return output.sort();
}

function safeRelativePath(value: unknown, label: string, allowRoot: boolean): string {
  const path = text(value, label, 1, 500).replace(/\/$/, "");
  if (allowRoot && path === ".") return path;
  if (
    path === "." || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) fail(`${label} must be a safe repository-relative path.`);
  return path;
}

function absolutePath(value: unknown): string {
  const path = text(value, "repository root", 1, 1_024);
  if (!(path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) || path.includes("\0")) {
    fail("Repository root must be an absolute local path.");
  }
  return path === "/" || /^[A-Za-z]:[\\/]$/.test(path) ? path : path.replace(/[\\/]$/, "");
}

function branch(value: unknown): string {
  const result = text(value, "default branch", 1, 255);
  if (result.startsWith("-") || result.startsWith("/") || result.endsWith("/") || result.endsWith(".") || result.includes("..") || result.includes("@{") || /[~^:?*[\\\s]/.test(result)) {
    fail("Default branch is unsafe.");
  }
  return result;
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label, 1, 128);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(result) || ["__proto__", "prototype", "constructor"].includes(result)) fail(`${label} is invalid.`);
  return result;
}

function nullableFingerprint(value: unknown, label: string): string | null {
  return value === null ? null : fingerprint(value, label);
}

function fingerprint(value: unknown, label: string): string {
  const result = text(value, label, 71, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) fail(`${label} must use canonical sha256 lowercase hex.`);
  return result;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object.`);
  const record = value as Record<string, unknown>;
  if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) fail(`${label} must be a plain object.`);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) fail(`${label} keys do not match the closed V2 contract.`);
  return record;
}

function array(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(`${label} must contain ${minimum}-${maximum} entries.`);
  return value;
}

function text(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") fail(`${label} must be a string.`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum || /[\0\r\n]/.test(result)) fail(`${label} is invalid.`);
  return result;
}

function uniqueStrings(value: unknown, label: string, minimum: number, maximum: number, maxLength: number): string[] {
  const output = array(value, label, minimum, maximum).map((entry) => text(entry, label, 1, maxLength));
  if (new Set(output).size !== output.length) fail(`${label} must be unique.`);
  return output;
}

function uniqueOrRepeatedStrings(value: unknown, label: string, minimum: number, maximum: number, maxLength: number): string[] {
  return array(value, label, minimum, maximum).map((entry) => text(entry, label, 1, maxLength));
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(`${label} must be a safe integer in range.`);
  return value as number;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${label} is invalid.`);
  return value as T;
}

function ecosystemOrder(left: RepositoryEcosystemV2, right: RepositoryEcosystemV2): number {
  return ECOSYSTEMS.indexOf(left) - ECOSYSTEMS.indexOf(right);
}

function addControl(
  controls: Map<string, RepositoryProtectedControlV2>,
  path: string,
  kind: ProtectedControlKindV2,
  approval: ProtectedControlApprovalV2,
): void {
  controls.set(path, { path, kind, approval });
}

function firstExisting(files: readonly string[], root: string, names: readonly string[]): string | null {
  for (const name of names) {
    const path = atRoot(root, name);
    if (files.includes(path)) return path;
  }
  return null;
}

function findNodeLockfile(paths: readonly string[]): string | null {
  return paths.find((path) => ["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(basename(path))) ?? null;
}

function projectIdentifier(root: string, index: number): string {
  if (root === ".") return "root";
  const result = root.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return result || `project-${index + 1}`;
}

function atRoot(root: string, path: string): string {
  return root === "." ? path : `${root}/${path}`;
}

function directory(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isAtOrBelow(root: string, path: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

function pathMatches(control: string, path: string): boolean {
  return path === control || path.startsWith(`${control}/`);
}

function isGitInternalsPath(path: string): boolean {
  return path === ".git" || path.startsWith(".git/");
}

function sha256Text(value: string): string {
  return `sha256:${portableSha256Text(value)}`;
}

function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail("Canonical JSON contains an unsafe number.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") fail("Canonical JSON contains an unsupported value.");
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function fail(message: string): never {
  throw new RepositoryProfileV2Error(message);
}
