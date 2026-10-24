import test from "node:test";
import assert from "node:assert/strict";

import {
  REPOSITORY_PROFILE_V2_ADAPTERS,
  classifyProtectedControlChangesV2,
  detectRepositoryProfileV2,
  parseRepositoryProfileV2,
  repositoryProfileExecutionBlockersV2,
} from "../extensions/code/repositories/RepositoryProfileV2";

const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;

test("RepositoryProfileV2 detects every required ecosystem with closed safe catalogs", () => {
  const files = [
    "package.json",
    "package-lock.json",
    ".nvmrc",
    "pyproject.toml",
    "uv.lock",
    ".python-version",
    "Cargo.toml",
    "Cargo.lock",
    "go.mod",
    "go.sum",
    "pom.xml",
    "mvnw",
    "build.gradle.kts",
    "gradle.lockfile",
    "gradlew",
    "CMakeLists.txt",
    "conan.lock",
    "app.sln",
    "packages.lock.json",
    "global.json",
    ".github/workflows/ci.yml",
    ".husky/pre-commit",
    "scripts/build.mjs",
  ];
  const profile = detectRepositoryProfileV2({
    key: "fixture",
    displayName: "Fixture repository",
    repositoryRoot: "C:\\work\\fixture",
    defaultBranch: "main",
    files,
    fileContents: {
      ".nvmrc": "24.16.0\n",
      ".python-version": "3.11.9\n",
      "global.json": '{"sdk":{"version":"9.0.100"}}',
      "mvnw": "wrapper",
      "gradlew": "wrapper",
    },
    requiredGitHubChecks: ["ci/windows", "ci/linux"],
  });

  assert.equal(profile.schemaVersion, 2);
  assert.deepEqual(
    profile.ecosystems,
    ["node", "python", "rust", "go", "java_maven", "java_gradle", "c_cpp", "dotnet"],
  );
  assert.deepEqual(
    REPOSITORY_PROFILE_V2_ADAPTERS.map((adapter) => adapter.ecosystem),
    profile.ecosystems,
  );
  assert.ok(profile.validationCatalog.some((command) => command.phase === "bootstrap"));
  assert.ok(
    profile.validationCatalog
      .filter((command) => command.phase === "bootstrap")
      .every(
        (command) =>
          command.lockfile &&
          command.network === "exact_approval_required" &&
          command.credentialPolicy === "none",
      ),
  );
  assert.ok(
    profile.validationCatalog
      .filter((command) => command.phase !== "bootstrap")
      .every((command) => command.network === "disabled"),
  );
  assert.equal(
    profile.protectedControls.find((control) => control.path === ".github/workflows")
      ?.approval,
    "double_exact",
  );
  assert.equal(
    profile.protectedControls.find((control) => control.path === ".husky")?.approval,
    "double_exact",
  );
  assert.deepEqual(profile.requiredGitHubChecks, ["ci/windows", "ci/linux"]);
  assert.equal(profile.mergePolicy.defaultMethod, "squash");
  assert.equal(profile.mergePolicy.forbidForcePush, true);
  assert.ok(
    repositoryProfileExecutionBlockersV2(profile).includes(
      "runtime_digest_required:root:rust",
    ),
  );
});

test("RepositoryProfileV2 is closed recursively and rejects weakened safety fields", () => {
  const profile = detectRepositoryProfileV2({
    key: "node-only",
    displayName: "Node only",
    repositoryRoot: "/work/node-only",
    defaultBranch: "main",
    files: ["package.json", "package-lock.json", ".nvmrc"],
    fileContents: { ".nvmrc": "24.16.0" },
  });

  assert.throws(
    () => parseRepositoryProfileV2({ ...profile, surprise: true }),
    /closed V2 contract/i,
  );
  assert.throws(
    () =>
      parseRepositoryProfileV2({
        ...profile,
        mergePolicy: { ...profile.mergePolicy, forbidForcePush: false },
      }),
    /cannot disable/i,
  );
  const bootstrap = profile.validationCatalog.find((command) => command.phase === "bootstrap")!;
  assert.throws(
    () =>
      parseRepositoryProfileV2({
        ...profile,
        validationCatalog: profile.validationCatalog.map((command) =>
          command.id === bootstrap.id ? { ...command, lockfile: null } : command,
        ),
      }),
    /declared lockfile/i,
  );
});

test("protected-control classifier binds exact hashes and escalates workflows and hooks", () => {
  const profile = detectRepositoryProfileV2({
    key: "protected",
    displayName: "Protected repository",
    repositoryRoot: "/work/protected",
    defaultBranch: "main",
    files: [
      "package.json",
      "package-lock.json",
      ".nvmrc",
      ".github/workflows/ci.yml",
      "src/index.ts",
    ],
    fileContents: { ".nvmrc": "24.16.0" },
  });
  const source = classifyProtectedControlChangesV2(profile, [
    { path: "src/index.ts", beforeSha256: SHA_A, afterSha256: SHA_B },
  ]);
  assert.equal(source.level, "none");
  assert.equal(source.approvalCount, undefined);

  const manifest = classifyProtectedControlChangesV2(profile, [
    { path: "package.json", beforeSha256: SHA_A, afterSha256: SHA_B },
  ]);
  assert.equal(manifest.level, "exact_diff");
  assert.equal(manifest.approvalCount, 1);

  const workflow = classifyProtectedControlChangesV2(profile, [
    { path: ".github/workflows/ci.yml", beforeSha256: SHA_A, afterSha256: SHA_B },
  ]);
  assert.equal(workflow.level, "double_exact");
  assert.equal(workflow.approvalCount, 2);
  assert.match(workflow.exactDiffFingerprint, /^sha256:[0-9a-f]{64}$/);

  const reordered = classifyProtectedControlChangesV2(profile, [
    { path: "src/index.ts", beforeSha256: SHA_A, afterSha256: SHA_B },
    { path: "package.json", beforeSha256: SHA_A, afterSha256: SHA_B },
  ]);
  const reverse = classifyProtectedControlChangesV2(profile, [
    { path: "package.json", beforeSha256: SHA_A, afterSha256: SHA_B },
    { path: "src/index.ts", beforeSha256: SHA_A, afterSha256: SHA_B },
  ]);
  assert.equal(reordered.exactDiffFingerprint, reverse.exactDiffFingerprint);

  const gitHook = classifyProtectedControlChangesV2(profile, [
    { path: ".git/hooks/post-checkout", beforeSha256: SHA_A, afterSha256: SHA_B },
  ]);
  assert.equal(gitHook.level, "double_exact");

  const gitInternal = classifyProtectedControlChangesV2(profile, [
    { path: ".git/objects/aa/bb", beforeSha256: SHA_A, afterSha256: SHA_B },
  ]);
  assert.equal(gitInternal.level, "blocked");
});

function detectFiles(files: string[]) {
  return detectRepositoryProfileV2({
    key: "python-legacy",
    displayName: "Python repository",
    repositoryRoot: "/work/python-legacy",
    defaultBranch: "main",
    files,
  });
}

test("a Python repository declared by setup.py or setup.cfg alone is trusted as a Python project (CODE2-25)", () => {
  for (const manifest of ["setup.py", "setup.cfg"]) {
    const profile = detectFiles([manifest, "README.md", "pkg/__init__.py", "tests/test_pkg.py"]);
    assert.deepEqual(profile.ecosystems, ["python"], manifest);
    assert.deepEqual(profile.projects.map((project) => project.root), ["."], manifest);
    const phases = profile.validationCatalog.map((command) => `${command.phase}:${command.executable} ${command.args.join(" ")}`);
    assert.deepEqual(phases, ["fast:python -m pytest -q", "full:python -m pytest"], manifest);
    assert.ok(
      profile.validationCatalog.every((command) => command.network === "disabled" && command.lockfile === null),
      "with nothing pinned there is no bootstrap: installing the project would run its setup.py with the network on",
    );
    assert.equal(
      profile.protectedControls.find((control) => control.path === manifest)?.kind,
      "manifest",
      `${manifest} runs code at install, so a change to it asks as a manifest's does`,
    );
    assert.equal(
      classifyProtectedControlChangesV2(profile, [{ path: manifest, beforeSha256: SHA_A, afterSha256: SHA_B }]).level,
      "exact_diff",
    );
  }
  const pinned = detectFiles(["setup.py", "requirements.txt", "tests/test_pkg.py"]);
  assert.deepEqual(
    pinned.validationCatalog.filter((command) => command.phase === "bootstrap").map((command) => command.lockfile),
    ["requirements.txt"],
    "a root requirements.txt beside setup.py is still the hash-pinned bootstrap",
  );
});

test("a requirements.txt below a declared Python project is that project's file, not a project (CODE2-25)", () => {
  for (const manifest of ["setup.py", "setup.cfg", "pyproject.toml"]) {
    const profile = detectFiles([manifest, "docs/requirements.txt", "docs/conf.py", "src/pkg/__init__.py", "tests/test_pkg.py"]);
    assert.deepEqual(profile.projects.map((project) => project.root), ["."], manifest);
    assert.deepEqual(profile.allowedPaths, ["."], manifest);
    assert.ok(profile.validationCatalog.every((command) => command.cwd === "."), manifest);
  }

  // Without a declared project above it, a requirements.txt is still a project of its own.
  assert.deepEqual(detectFiles(["docs/requirements.txt", "docs/conf.py"]).projects.map((project) => project.root), ["docs"]);
  assert.deepEqual(
    detectFiles(["requirements.txt", "tools/requirements.txt"]).projects.map((project) => project.root),
    [".", "tools"],
    "a root requirements.txt lists dependencies; it does not declare a project that holds tools/",
  );
  assert.deepEqual(
    detectFiles(["package.json", "package-lock.json", "docs/requirements.txt"]).projects.map((project) => `${project.root}:${project.ecosystems.join(",")}`),
    [".:node", "docs:python"],
    "a Node project does not hold a Python folder",
  );
  // A nested project that declares itself, or carries a lock, stays its own.
  assert.deepEqual(
    detectFiles(["setup.py", "plugins/extra/setup.py", "services/api/requirements.txt", "services/api/uv.lock"]).projects.map((project) => project.root),
    [".", "plugins/extra", "services/api"],
  );
});
