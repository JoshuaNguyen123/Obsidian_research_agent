/**
 * Independent verification of the retained-journey deliverables.
 *
 * Every check here deliberately uses a path the agent did not use: `gh api`
 * for the repository, `git` for the commit, and the note file on disk for the
 * research report and reflection. The agent grading its own homework is not
 * evidence.
 *
 * It also asserts the chain is *linked*. Six artifacts that exist but do not
 * reference each other would satisfy "they were created" while meaning the
 * ideation -> organization -> execution flow does not actually work.
 *
 * Read-only apart from an optional `git clone` into the Desktop folder so the
 * delivered code opens directly in an editor.
 */

import { execFile } from "node:child_process";
import { readFile, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ""), "..");
const ARTIFACT_PATH = path.join(repoRoot, "test-results", "retained-journey-artifacts.json");
const CLONE = process.argv.includes("--clone");

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok === true ? "PASS" : ok === false ? "FAIL" : "SKIP";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function gh(args) {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: 60_000,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

const artifacts = JSON.parse(await readFile(ARTIFACT_PATH, "utf8"));
console.log(`Verifying retained-journey artifacts for ${artifacts.marker}\n`);

// 1. Private GitHub repository, read through gh rather than the agent.
let repoFullName = null;
let remoteCommitSha = null;
if (artifacts.githubRepositoryUrl) {
  const match = String(artifacts.githubRepositoryUrl).match(
    /github\.com\/([^/]+\/[^/#?]+)/u,
  );
  repoFullName = match ? match[1].replace(/\.git$/u, "") : null;
}
if (repoFullName) {
  try {
    const raw = await gh(["api", `repos/${repoFullName}`]);
    const repo = JSON.parse(raw);
    record(
      "GitHub repository exists and is private",
      repo.private === true,
      `${repo.full_name} (private=${repo.private}, default=${repo.default_branch})`,
    );
    const commits = JSON.parse(
      await gh(["api", `repos/${repoFullName}/commits?per_page=1`]),
    );
    remoteCommitSha = commits?.[0]?.sha ?? null;
    record("GitHub repository has a commit", Boolean(remoteCommitSha), remoteCommitSha ?? "none");
    // Draft-PR promotion keeps the feature commit on the PR branch, so the
    // honest check is "the reported SHA exists in this repository", not "it
    // is the default-branch head".
    if (artifacts.commitSha) {
      try {
        const commit = JSON.parse(
          await gh(["api", `repos/${repoFullName}/commits/${artifacts.commitSha}`]),
        );
        record(
          "Reported commit exists in the repository",
          commit?.sha === artifacts.commitSha,
          `${String(commit?.sha).slice(0, 12)} ${String(commit?.commit?.message ?? "").split("\n")[0].slice(0, 60)}`,
        );
        remoteCommitSha = commit?.sha ?? remoteCommitSha;
      } catch (error) {
        record(
          "Reported commit exists in the repository",
          false,
          String(error?.message ?? error).slice(0, 160),
        );
      }
    }
    const pulls = JSON.parse(
      await gh(["api", `repos/${repoFullName}/pulls?state=open&per_page=20`]),
    );
    const draftPull = pulls.find(
      (pull) =>
        pull?.draft === true &&
        pull?.state === "open" &&
        pull?.head?.sha === artifacts.commitSha,
    );
    record(
      "GitHub has an open draft PR at the reported commit",
      Boolean(draftPull),
      draftPull?.html_url ?? "none",
    );
    if (artifacts.githubPublicationReadback?.pullRequest?.htmlUrl) {
      record(
        "Agent draft PR URL matches provider readback",
        draftPull?.html_url ===
          artifacts.githubPublicationReadback.pullRequest.htmlUrl,
        artifacts.githubPublicationReadback.pullRequest.htmlUrl,
      );
    } else {
      record("Agent draft PR URL matches provider readback", false, "missing checkpoint PR URL");
    }
  } catch (error) {
    record("GitHub repository readback", false, String(error?.message ?? error).slice(0, 200));
  }
} else {
  record("GitHub repository exists and is private", false, "no repository URL was produced");
}

// 2. The commit the agent reported must be the commit that is really there.
if (artifacts.commitSha && remoteCommitSha) {
  record(
    "Reported commit SHA matches the remote",
    artifacts.commitSha === remoteCommitSha,
    `reported=${String(artifacts.commitSha).slice(0, 12)} remote=${String(remoteCommitSha).slice(0, 12)}`,
  );
} else {
  record("Reported commit SHA matches the remote", false, "one side is missing");
}

// 3. Linear create/readback proof from the production read tool.
const linearReadback = artifacts.linearIssueReadback;
record(
  "Linear issue title matches the retained marker",
  linearReadback?.title === `CRDT implementation ${artifacts.marker}`,
  linearReadback?.title ?? "missing",
);
record(
  "Linear issue is in Application_testing_dumping_grounds",
  linearReadback?.team?.name === "Application_testing_dumping_grounds",
  linearReadback?.team?.name ?? "missing",
);
record(
  "Linear issue assignee is the configured viewer",
  Boolean(artifacts.linearViewerId) &&
    linearReadback?.assignee?.id === artifacts.linearViewerId,
  `viewer=${artifacts.linearViewerId ?? "missing"} assignee=${linearReadback?.assignee?.id ?? "missing"}`,
);

// 4. Research report and reflection on the note, with real URLs.
const vaultRoot =
  process.env.OBSIDIAN_VAULT?.trim() ||
  path.join(os.homedir(), "OneDrive", "Desktop", "test_vault_obsidian_ai");
const notePath = path.join(vaultRoot, ...String(artifacts.notePath ?? "").split("/"));
let note = "";
try {
  note = await readFile(notePath, "utf8");
  record("Research note exists on disk", note.length > 0, `${note.length} chars`);
} catch (error) {
  record("Research note exists on disk", false, String(error?.message ?? error).slice(0, 160));
}
if (note) {
  const headings = ["## Problem and impact", "## Evidence and source links", "## Proposed work"];
  const present = headings.filter((heading) => note.includes(heading));
  record(
    "Research report uses the canonical headings",
    present.length === headings.length,
    `${present.length}/${headings.length}`,
  );
  const urls = note.match(/https?:\/\/[^\s)\]]+/gu) ?? [];
  const sourceUrls = [
    ...new Set(
      urls
        .map((url) => url.replace(/[.,;:]+$/u, ""))
        .filter((url) => !/linear\.app|github\.com/u.test(url)),
    ),
  ];
  record("Research cites exactly two external sources", sourceUrls.length === 2, `${sourceUrls.length} source URLs`);
  const expectedSourceUrls = Array.isArray(artifacts.sourceUrls)
    ? artifacts.sourceUrls
    : [];
  record(
    "Research cites the exact retained source URLs",
    expectedSourceUrls.length === 2 &&
      expectedSourceUrls.every((url) => note.includes(url)),
    `${expectedSourceUrls.length}/2 retained source URLs`,
  );
  record(
    "Note carries the run marker",
    note.includes(artifacts.marker),
    artifacts.marker,
  );

  // The linkage checks: the reflection must cite the REAL artifacts.
  if (artifacts.linearIssueUrl) {
    record(
      "Note links the real Linear issue",
      note.includes(artifacts.linearIssueUrl),
      artifacts.linearIssueUrl,
    );
  } else {
    record("Note links the real Linear issue", false, "no Linear issue URL was produced");
  }
  if (artifacts.githubRepositoryUrl) {
    record(
      "Note links the real GitHub repository",
      note.includes(artifacts.githubRepositoryUrl),
      artifacts.githubRepositoryUrl,
    );
  } else {
    record("Note links the real GitHub repository", false, "no repository URL was produced");
  }
  if (artifacts.githubPublicationReadback?.pullRequest?.htmlUrl) {
    record(
      "Note links the real draft pull request",
      note.includes(artifacts.githubPublicationReadback.pullRequest.htmlUrl),
      artifacts.githubPublicationReadback.pullRequest.htmlUrl,
    );
  } else {
    record("Note links the real draft pull request", false, "no draft PR URL was produced");
  }
}

// 5. Required graph and UI proof.
const requiredGraphTools = [
  "code_workspace_read",
  "code_workspace_write_expected",
  "code_validate_targeted",
  "code_validate_full",
  "code_commit_verified",
  "linear_create_issue",
  "github_create_repository",
  "publish_verified_code_to_github",
];
const completedGraphTools = new Set(
  Array.isArray(artifacts.completedGraphToolNames)
    ? artifacts.completedGraphToolNames
    : [],
);
const missingGraphTools = requiredGraphTools.filter(
  (toolName) => !completedGraphTools.has(toolName),
);
record(
  "MissionGraph completed the retained lifecycle tools",
  missingGraphTools.length === 0,
  missingGraphTools.length ? `missing=${missingGraphTools.join(",")}` : "complete",
);
record(
  "Mission UI surfaces passed",
  Boolean(artifacts.uiSurfaces?.assistantReply),
  artifacts.uiSurfaces?.assistantReply ? "assistant reply and Run Details observed" : "missing",
);

// 6. Working code the user can open, cloned through git rather than copied.
if (CLONE && repoFullName) {
  const desktop = process.env.OneDrive?.trim()
    ? path.join(process.env.OneDrive.trim(), "Desktop")
    : path.join(os.homedir(), "Desktop");
  const target = path.join(desktop, `crdt-local-first-${artifacts.marker}`);
  try {
    await mkdir(desktop, { recursive: true });
    await execFileAsync("gh", ["repo", "clone", repoFullName, target], {
      timeout: 180_000,
      windowsHide: true,
    });
    const entries = await readdir(target);
    record("Code cloned to the Desktop", entries.length > 0, `${target} (${entries.length} entries)`);
    const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%H %s"], {
      cwd: target,
      windowsHide: true,
      encoding: "utf8",
    });
    const clonedHead = stdout.trim().split(/\s+/u)[0] ?? "";
    record(
      "Cloned repository has the verified commit",
      clonedHead === artifacts.commitSha,
      stdout.trim().slice(0, 120),
    );
  } catch (error) {
    record("Code cloned to the Desktop", false, String(error?.message ?? error).slice(0, 200));
  }
}

const failed = results.filter((entry) => entry.ok === false);
const skipped = results.filter((entry) => entry.ok === null);
console.log(
  `\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} not applicable`,
);
process.exitCode = failed.length > 0 ? 1 : 0;
