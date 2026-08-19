import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Shared reflection-quality extraction for e2e lanes.
 *
 * Both completion-reflection writers (initiatingNoteReflection's
 * "## Mission completion reflection" and AcceptedResearchNoteWriter's
 * "## Agent project reflection") emit host-deterministic prose plus a hidden
 * HTML-comment proof block. Lanes assert on the *visible* section body only:
 * the hidden proof lineage is covered by receipt readback assertions, and the
 * visible prose must read as a human summary — bounded length, real URLs,
 * validation language, and no internal jargon.
 */
export function extractVisibleCompletionReflection(note: string): {
  count: number;
  visible: string;
  wordCount: number;
} {
  const heading =
    /^## (?:Mission completion reflection|Agent project reflection)\s*$/gimu;
  const starts = [...note.matchAll(heading)];
  const first = starts[0];
  const bodyStart =
    first?.index === undefined ? -1 : first.index + first[0].length;
  const nextHeading =
    bodyStart < 0
      ? null
      : /^##\s+/gmu.exec(note.slice(bodyStart));
  const bodyEnd =
    bodyStart < 0
      ? -1
      : nextHeading?.index === undefined
        ? note.length
        : bodyStart + nextHeading.index;
  const raw =
    bodyStart < 0 || bodyEnd < bodyStart
      ? ""
      : note.slice(bodyStart, bodyEnd);
  const withoutHiddenProof = raw.replace(/<!--[\s\S]*?-->/gu, "");
  const visible = withoutHiddenProof
    .replace(/\s+/gu, " ")
    .trim();
  // Concise reflection bounds apply to the human summary, not to exact code
  // reproduced beneath it. Counting a 20-line verified excerpt as prose made
  // the quality gate depend on identifier density instead of writing quality.
  const prose = withoutHiddenProof.split(/^### Verified code example\s*$/mu)[0] ?? "";
  const countable = prose
    .replace(/https?:\/\/[^\s)]+/giu, " ");
  const words =
    countable.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) ?? [];
  return { count: starts.length, visible, wordCount: words.length };
}

export interface VerifiedCommitBoundCodeExampleV1 {
  path: string;
  startLine: number;
  endLine: number;
  commitPrefix: string;
  artifactSha256Prefix: string;
  codeSha256: string;
  language: string;
  code: string;
}

/**
 * Parse the visible code examples emitted by the host-owned completion
 * writers. This intentionally rejects loose Markdown: every example needs a
 * commit, file hash, excerpt hash, bounded source range, and a closed fence.
 */
export function extractVerifiedCommitBoundCodeExamplesV1(
  note: string,
): VerifiedCommitBoundCodeExampleV1[] {
  const lines = note.replace(/\r\n?/gu, "\n").split("\n");
  const examples: VerifiedCommitBoundCodeExampleV1[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "### Verified code example") continue;
    const metadata = lines[index + 1] ?? "";
    const match = metadata.match(
      /^`([^`\r\n]+)` (?:line (\d+)|lines (\d+)-(\d+)) at commit `([a-f0-9]{12})` \(file hash `([a-f0-9]{12})`; excerpt hash `(sha256:[a-f0-9]{64})`\)\.$/u,
    );
    if (!match) {
      throw new Error(
        `Verified code example has invalid commit-bound metadata: ${metadata}`,
      );
    }
    const path = normalizeRepositoryPathV1(match[1] ?? "");
    const startLine = Number.parseInt(match[2] ?? match[3] ?? "0", 10);
    const endLine = Number.parseInt(match[2] ?? match[4] ?? "0", 10);
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine ||
      endLine - startLine + 1 > 20
    ) {
      throw new Error(
        `Verified code example range must contain 1-20 lines: ${startLine}-${endLine}.`,
      );
    }
    const openingFence = lines[index + 2] ?? "";
    const fenceMatch = openingFence.match(/^(`{3,})([^`]*)$/u);
    if (!fenceMatch) {
      throw new Error(`Verified code example is missing its opening fence: ${path}`);
    }
    const fence = fenceMatch[1] ?? "";
    let closingIndex = index + 3;
    while (closingIndex < lines.length && lines[closingIndex] !== fence) {
      closingIndex += 1;
    }
    if (closingIndex >= lines.length) {
      throw new Error(`Verified code example is missing its closing fence: ${path}`);
    }
    const code = lines.slice(index + 3, closingIndex).join("\n");
    if (!code.trim()) {
      throw new Error(`Verified code example is empty: ${path}`);
    }
    if (code.split("\n").length !== endLine - startLine + 1) {
      throw new Error(
        `Verified code example line count does not match ${path}:${startLine}-${endLine}.`,
      );
    }
    examples.push({
      path,
      startLine,
      endLine,
      commitPrefix: match[5] ?? "",
      artifactSha256Prefix: match[6] ?? "",
      codeSha256: match[7] ?? "",
      language: (fenceMatch[2] ?? "").trim(),
      code,
    });
    index = closingIndex;
  }
  return examples;
}

/**
 * Independent E2E readback: resolve every displayed snippet from the exact
 * local Git commit rather than trusting the note, worktree, or model. The
 * joined lanes separately prove that this same commit exists at the private
 * remote, so this closes the note -> immutable code link.
 */
export async function assertVerifiedCommitBoundCodeExamplesV1(input: {
  note: string;
  repositoryRoot: string;
  expectedCommitSha: string;
}): Promise<VerifiedCommitBoundCodeExampleV1[]> {
  const commitSha = input.expectedCommitSha.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commitSha)) {
    throw new Error("Verified reflection proof requires a full Git commit SHA.");
  }
  const examples = extractVerifiedCommitBoundCodeExamplesV1(input.note);
  if (examples.length < 1 || examples.length > 2) {
    throw new Error(
      `Completion reflection requires 1-2 verified code examples; observed ${examples.length}.`,
    );
  }
  await runGitV1(input.repositoryRoot, ["cat-file", "-e", `${commitSha}^{commit}`]);
  for (const example of examples) {
    if (example.commitPrefix !== commitSha.slice(0, 12)) {
      throw new Error(
        `Reflection example ${example.path} cites ${example.commitPrefix}, expected ${commitSha.slice(0, 12)}.`,
      );
    }
    const source = await runGitV1(input.repositoryRoot, [
      "cat-file",
      "blob",
      `${commitSha}:${example.path}`,
    ]);
    const normalizedSource = source.replace(/\r\n?/gu, "\n");
    const sourceLines = normalizedSource.split("\n");
    const expectedCode = sourceLines
      .slice(example.startLine - 1, example.endLine)
      .join("\n");
    if (example.code !== expectedCode) {
      throw new Error(
        `Reflection example ${example.path}:${example.startLine}-${example.endLine} does not match the exact commit.`,
      );
    }
    const artifactSha256 = createHash("sha256")
      .update(Buffer.from(source, "utf8"))
      .digest("hex");
    if (example.artifactSha256Prefix !== artifactSha256.slice(0, 12)) {
      throw new Error(
        `Reflection example ${example.path} file hash does not match the exact commit.`,
      );
    }
    const codeSha256 = `sha256:${createHash("sha256")
      .update(Buffer.from(example.code, "utf8"))
      .digest("hex")}`;
    if (example.codeSha256 !== codeSha256) {
      throw new Error(
        `Reflection example ${example.path} excerpt hash does not match its code.`,
      );
    }
  }
  return examples;
}

function normalizeRepositoryPathV1(value: string): string {
  const normalized = value.replace(/\\/gu, "/").trim();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.includes(":") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Verified code example path is unsafe: ${value}`);
  }
  return normalized;
}

async function runGitV1(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    timeout: 30_000,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout;
}
