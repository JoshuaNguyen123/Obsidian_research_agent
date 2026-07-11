import assert from "node:assert/strict";
import test from "node:test";

import {
  createNodeNpmValidationProfile,
  createRepositoryProfile,
  createRepositoryProfileRegistry,
  getRepositoryProfile,
  parseRepositoryProfile,
  parseRepositoryProfileRegistry,
  upsertRepositoryProfile,
} from "../src/agent/repositories";

function createProfile() {
  return createRepositoryProfile({
    key: "research-agent",
    displayName: "Obsidian Research Agent",
    repositoryRoot: "C:\\work\\Obsidian_research_agent",
    defaultBranch: "main",
    allowedPathPrefixes: ["src", "tests", "docs"],
    validationProfile: createNodeNpmValidationProfile({
      allowedGeneratedPaths: ["main.js"],
    }),
  });
}

test("Node/npm repository profiles reuse guarded worktree validation controls", () => {
  const profile = createProfile();
  assert.equal(profile.key, "research-agent");
  assert.deepEqual(
    profile.validationProfile.validationCommands.map((command) => command.label),
    ["npm run test", "npm run build"],
  );
  assert.deepEqual(profile.validationProfile.bootstrapCommands[0], {
    command: "npm",
    args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    label: "npm ci --ignore-scripts",
  });
  assert.ok(profile.validationProfile.protectedPaths.includes("package.json"));
  assert.deepEqual(profile.validationProfile.allowedGeneratedPaths, ["main.js"]);
  assert.deepEqual(profile.promotionPolicy, {
    localBasePromotion: "guarded_fast_forward",
    completionProof: "local_verified",
    githubRepository: null,
    requiredChecks: [],
  });
});

test("repository registries are durable, keyed, and immutable", () => {
  const profile = createProfile();
  const empty = createRepositoryProfileRegistry();
  const registry = upsertRepositoryProfile(empty, profile);
  assert.equal(getRepositoryProfile(empty, profile.key), undefined);
  assert.deepEqual(getRepositoryProfile(registry, profile.key), profile);
  assert.deepEqual(
    parseRepositoryProfileRegistry(JSON.parse(JSON.stringify(registry))),
    registry,
  );
});

test("repository profile parsing rejects unknown keys and unsafe paths", () => {
  const profile = createProfile();
  assert.throws(
    () => parseRepositoryProfile({ ...profile, extra: true }),
    /unknown: extra/i,
  );
  assert.throws(
    () => createRepositoryProfile({ ...profile, repositoryRoot: "relative/repository" }),
    /absolute local path/i,
  );
  assert.throws(
    () => createRepositoryProfile({ ...profile, allowedPathPrefixes: ["../outside"] }),
    /safe repository-relative path/i,
  );
  assert.throws(
    () => createNodeNpmValidationProfile({ additionalScripts: ["test && publish"] }),
    /script names/i,
  );
  assert.throws(
    () =>
      createRepositoryProfile({
        ...profile,
        promotionPolicy: { completionProof: "merged_pr" },
      }),
    /requires a pinned GitHub repository/i,
  );
});

test("repository profiles pin remote proof without granting publication", () => {
  const profile = createRepositoryProfile({
    ...createProfile(),
    promotionPolicy: {
      localBasePromotion: "disabled",
      completionProof: "merged_pr",
      githubRepository: "openai/example",
      requiredChecks: ["test", "build"],
    },
  });
  assert.equal(profile.promotionPolicy.completionProof, "merged_pr");
  assert.equal(profile.promotionPolicy.localBasePromotion, "disabled");
  assert.deepEqual(profile.promotionPolicy.requiredChecks, ["test", "build"]);
});
