import { hasDesignIntent } from "./codeDesignIntent";

export interface AutonomyScope {
  read: {
    currentNote: boolean;
    vault: boolean;
    folders: string[];
    files: string[];
    web: boolean;
  };
  write: {
    currentNote: boolean;
    folders: string[];
    files: string[];
    artifacts: boolean;
    researchMemory: boolean;
  };
  destructive: {
    replaceCurrentNote: boolean;
    deleteCurrentNote: boolean;
    deletePaths: boolean;
  };
}

export interface DeriveAutonomyScopeInput {
  vaultContext?: boolean;
  noteOutput?: boolean;
  explicitPersistence?: boolean;
  explicitMutation?: boolean;
  explicitDelete?: boolean;
}

export function createDefaultAutonomyScope(): AutonomyScope {
  return {
    read: {
      currentNote: false,
      vault: false,
      folders: [],
      files: [],
      web: false,
    },
    write: {
      currentNote: false,
      folders: [],
      files: [],
      artifacts: false,
      researchMemory: false,
    },
    destructive: {
      replaceCurrentNote: false,
      deleteCurrentNote: false,
      deletePaths: false,
    },
  };
}

export function deriveAutonomyScope(
  prompt: string,
  input: DeriveAutonomyScopeInput = {},
): AutonomyScope {
  const scope = createDefaultAutonomyScope();
  const mentionedFiles = extractMarkdownPathMentions(prompt);
  const mentionedFolders = extractFolderMentions(prompt, mentionedFiles);
  const broadVaultWriteTarget =
    /\b(all|whole|entire|every|my)\s+(vault|notes|files|folders|markdown files|md files)\b/i.test(
      prompt,
    ) ||
    /\b(vault|notes|files|folders|markdown files|md files)\b[\s\S]{0,80}\b(all|whole|entire|every)\b/i.test(
      prompt,
    );

  scope.read.currentNote =
    /\b(current|this|active|the)\s+(note|page|document|file|space)\b/i.test(prompt) ||
    /\bnotepage\b/i.test(prompt) ||
    input.noteOutput === true;
  scope.read.web =
    /\b(web|online|source|sources|citation|citations|latest|current|verify|verified|fact[-\s]?check|research|browser|page|url|click|scroll|navigate|open\s+page)\b/i.test(
      prompt,
    );
  scope.read.vault =
    input.vaultContext === true ||
    /\b(vault|folders|graph|backlinks?|related notes?|markdown files?|md files?|my notes|across notes|notes in|note graph)\b/i.test(
      prompt,
    ) ||
    mentionedFolders.length > 0 ||
    mentionedFiles.length > 0;
  scope.read.files = mentionedFiles;
  scope.read.folders = mentionedFolders;

  scope.write.currentNote =
    (input.noteOutput === true &&
      mentionedFiles.length === 0 &&
      !broadVaultWriteTarget) ||
    hasExplicitCurrentNoteMutationIntent(prompt);
  scope.write.researchMemory =
    /\b(remember|save|persist|store)\b[\s\S]{0,120}\b(research memory|memory)\b/i.test(
      prompt,
    ) ||
    /\b(experience memory|procedural memory|episodic memory|semantic memory|source memory|memory write|learned strategy)\b/i.test(
      prompt,
    ) ||
    /\bresearch memory\b/i.test(prompt);
  scope.write.artifacts =
    hasDesignIntent(prompt) ||
    /\b(canvas|svg|diagram|wireframe|preview|artifact|source note|templates?|design package|service blueprint|logistics system|project ideation|mind map|ui flow)\b/i.test(
      prompt,
    );
  scope.write.files =
    input.explicitMutation === true || input.explicitPersistence === true
      ? mentionedFiles
      : [];
  scope.write.folders =
    input.explicitMutation === true || input.explicitPersistence === true
      ? mentionedFolders
      : [];

  scope.destructive.replaceCurrentNote =
    /\b(replace|rewrite|clear|empty|delete all|overwrite|start\s+(?:fresh|cleanly)|reset|edit\s+over)\b[\s\S]{0,180}\b(note|page|document|file|space|contents?|text|writing)\b/i.test(
      prompt,
    ) ||
    /\b(note|page|document|file|space|contents?|text|writing)\b[\s\S]{0,180}\b(replace|rewrite|clear|empty|delete all|overwrite|start\s+(?:fresh|cleanly)|reset|edit\s+over)\b/i.test(
      prompt,
    ) ||
    /\bkeep\s+(?:the\s+)?(?:note|page|document|file)\b[\s\S]{0,180}\b(delete|remove|clear|empty)\b[\s\S]{0,120}\b(?:contents?|text|writing)\b/i.test(
      prompt,
    );
  scope.destructive.deleteCurrentNote =
    input.explicitDelete === true &&
    /\b(delete|trash|remove)\b[\s\S]{0,120}\b(current|this|active|the)\s+(note|page|document|file)\b/i.test(
      prompt,
    );
  scope.destructive.deletePaths =
    input.explicitDelete === true &&
    (/\b(delete|trash|remove)\b[\s\S]{0,120}\b(folder|file|path|directory|\.md)\b/i.test(
      prompt,
    ) ||
      mentionedFiles.length > 0 ||
      mentionedFolders.length > 0) &&
    !scope.destructive.deleteCurrentNote;

  return dedupeScope(scope);
}

export function isBroadUnscopedVaultMutation(scope: AutonomyScope): boolean {
  const hasWriteTarget =
    scope.write.currentNote ||
    scope.write.files.length > 0 ||
    scope.write.folders.length > 0 ||
    scope.write.artifacts ||
    scope.write.researchMemory ||
    scope.destructive.replaceCurrentNote ||
    scope.destructive.deleteCurrentNote ||
    scope.destructive.deletePaths;

  return scope.read.vault && !hasWriteTarget;
}

function dedupeScope(scope: AutonomyScope): AutonomyScope {
  return {
    read: {
      ...scope.read,
      folders: dedupeStrings(scope.read.folders),
      files: dedupeStrings(scope.read.files),
    },
    write: {
      ...scope.write,
      folders: dedupeStrings(scope.write.folders),
      files: dedupeStrings(scope.write.files),
    },
    destructive: scope.destructive,
  };
}

export function extractMarkdownPathMentions(prompt: string): string[] {
  const path = String.raw`[A-Za-z0-9 .@()[\]_-]+?(?:\/[A-Za-z0-9 .@()[\]_-]+?)+\.md`;
  const quoted = [...prompt.matchAll(new RegExp(String.raw`["'\x60](${path})["'\x60]`, "giu"))]
    .map((match) => match[1] ?? "");
  const movePairs = [
    ...prompt.matchAll(
      new RegExp(
        String.raw`\b(?:move|rename)\s+(${path})\s+to\s+(${path})(?=\s*[,.;]|\s+then\b|\s*$)`,
        "giu",
      ),
    ),
  ].flatMap((match) => [match[1] ?? "", match[2] ?? ""]);
  const labeled = [
    ...prompt.matchAll(
      new RegExp(
        String.raw`\b(?:markdown\s+file|file|note|path)\s+(?:(?:named|called|at|to|into)\s+)?(${path})\b`,
        "giu",
      ),
    ),
  ].map((match) => match[1] ?? "");
  const mutationTargets = [
    ...prompt.matchAll(
      new RegExp(
        String.raw`\b(?:create|make|delete|trash|remove|read|inspect|open)\s+(?:(?:a|the)\s+)?(?:(?:exact|new|markdown)\s+)*(?:(?:file|note|path)\s+)?(?:at\s+|named\s+|called\s+)?(${path})(?=\s+(?:with|containing|and|then|only)\b|\s*[,.;:]|\s*$)`,
        "giu",
      ),
    ),
  ].map((match) => match[1] ?? "");
  const relocationTargets = [
    ...prompt.matchAll(
      new RegExp(
        String.raw`\b(?:move|relocate|rename)\b[\s\S]{0,160}?\bto\s+(?:(?:the|a)\s+)?(?:(?:file|note|path)\s+)?(${path})(?=\s+(?:with|containing|and|then|only)\b|\s*[,.;:]|\s*$)`,
        "giu",
      ),
    ),
  ].map((match) => match[1] ?? "");
  const destinationTargets = [
    ...prompt.matchAll(
      new RegExp(
        String.raw`\binto\s+(?:(?:the|a|an)\s+)?(?:(?:existing|new|exact)\s+)?(?:(?:markdown\s+)?(?:file|note|path)\s+)?(${path})(?=\s+(?:with|containing|and|then|only|for|using)\b|\s*[,.;:]|\s*$)`,
        "giu",
      ),
    ),
  ].map((match) => match[1] ?? "");
  // Unquoted paths containing spaces are ambiguous with surrounding prose.
  // Accept them only after a resource label above. Compact slash paths remain
  // safe to recognize without a label.
  const compact =
    prompt.match(/[A-Za-z0-9.@()[\]_-]+(?:\/[A-Za-z0-9.@()[\]_-]+)+\.md\b/gu) ?? [];
  const explicit = [
    ...quoted,
    ...movePairs,
    ...labeled,
    ...mutationTargets,
    ...relocationTargets,
    ...destinationTargets,
  ]
    .map((match) => normalizeMentionedPath(match))
    .filter(Boolean);
  return dedupeStrings([
    ...explicit,
    ...compact.filter(
      (candidate) =>
        !explicit.some(
          (explicitPath) =>
            explicitPath === candidate || explicitPath.endsWith(candidate),
        ),
    ),
  ]
    .map((match) => normalizeMentionedPath(match))
    .filter(Boolean));
}

/**
 * Extracts a bounded, explicit new-file set from phrases such as
 * "Add only README.md, src/app.ts, and tests/app.test.ts." The strict
 * only/exactly wording is intentional: ordinary prose and unrelated note or
 * provider paths must never manufacture extra repository mutations.
 */
export function extractExplicitNewWorkspaceFilePaths(prompt: string): string[] {
  if (prompt.length > 100_000 || prompt.includes("\0")) return [];
  const introductions = [
    ...prompt.matchAll(
      /\b(?:add|create|make)\s+(?:(?:only|exactly)\s+|(?:the\s+)?exact\s+(?:new\s+)?files?\s*:?[ \t]*)/giu,
    ),
  ];
  const paths: string[] = [];
  for (const introduction of introductions) {
    const introductionIndex = introduction.index ?? 0;
    const prefix = prompt.slice(Math.max(0, introductionIndex - 100), introductionIndex);
    if (/(?:\bdo\s+not\b|\bdon't\b|\bnever\b|\bwithout\b)[\s\S]{0,80}$/iu.test(prefix)) {
      continue;
    }
    const start = introductionIndex + introduction[0].length;
    const remainder = prompt.slice(start, Math.min(prompt.length, start + 4_000));
    const boundary = /[!?;\r\n]|\.\s+(?=[A-Z])|\b(?:and\s+then|then|after\s+that)\b/iu.exec(
      remainder,
    );
    const clause = remainder.slice(0, boundary?.index ?? remainder.length);
    for (const match of clause.matchAll(
      /(?:^|[\s,("'\x60])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})(?=$|[\s,):."'\x60])/gu,
    )) {
      const candidate = match[1] ?? "";
      if (!isSafeExplicitWorkspaceFilePath(candidate)) continue;
      paths.push(candidate);
    }
  }
  return dedupeStrings(paths);
}

/**
 * Extracts only repository-relative files that an affirmative clause explicitly
 * asks the agent to read, inspect, review, or open. This is intentionally
 * narrower than generic path recognition: protected validation inputs may
 * constrain a code mission, but merely mentioning or preserving a path must
 * never manufacture read authority.
 */
export function extractExplicitWorkspaceReadFilePaths(prompt: string): string[] {
  if (prompt.length > 100_000 || prompt.includes("\0")) return [];
  const paths: string[] = [];
  for (const clause of prompt.split(/[!?;\r\n]+|\.\s+(?=[A-Z])/gu)) {
    for (const match of clause.matchAll(
      /\b(?:read|inspect|review|open)\b(?:[ \t]+(?:the|this|that|exact|existing|protected|workspace|repository|source|file|contract|validator|validation)){0,8}[ \t]+((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})\b/giu,
    )) {
      const actionIndex = match.index ?? 0;
      const prefix = clause.slice(Math.max(0, actionIndex - 100), actionIndex);
      if (
        /(?:\bdo\s+not\b|\bdon't\b|\bnever\b|\bwithout\b)[\s\S]{0,80}$/iu.test(
          prefix,
        )
      ) {
        continue;
      }
      const candidate = match[1] ?? "";
      if (isSafeExplicitWorkspaceFilePath(candidate)) paths.push(candidate);
    }
  }
  return dedupeStrings(paths);
}

function isSafeExplicitWorkspaceFilePath(value: string): boolean {
  if (!value || value.length > 240 || value.includes("\\") || value.includes(":")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      /^[A-Za-z0-9_.-]+$/u.test(segment),
  );
}

/**
 * Returns true only when an explicit current-note target and its mutation verb
 * occur in the same natural-language clause. Merely reading the current note
 * must not authorize a later mutation whose clause targets another vault path.
 */
export function hasExplicitCurrentNoteMutationIntent(prompt: string): boolean {
  const clauses = prompt.split(
    /(?:[.;!?\n]+|,\s*|\b(?:and\s+then|then)\b)/giu,
  );
  const mutation =
    /\b(?:append|write|save|insert|stream|add|paste|copy|edit|revise|update|retitle|rename|link|connect|undo|restore|revert|rollback|roll\s+back|replace|rewrite|reset|overwrite|clear|delete|remove|trash|empty)\b/iu;
  const currentTarget =
    /\b(?:current|this|active)\s+(?:note|file|markdown|document|page|section|heading)\b|\b(?:note|file|markdown|document|page|section|heading)\b[\s\S]{0,40}\b(?:current|this|active)\b/iu;
  return clauses.some(
    (clause) => mutation.test(clause) && currentTarget.test(clause),
  );
}

function extractFolderMentions(prompt: string, files: string[]): string[] {
  const folders = files
    .map((file) => {
      const slash = file.lastIndexOf("/");
      return slash > 0 ? file.slice(0, slash) : "";
    })
    .filter(Boolean);
  const quotedFolders = [
    ...prompt.matchAll(/\b(?:folder|folders|directory|directories)\s+(?:named|called)?\s*["'`]([^"'`]+)["'`]/gi),
  ].map((match) => normalizeMentionedPath(match[1]));
  // Space-bearing folders are derived from an exact Markdown path or an
  // explicitly quoted folder. Treat only compact slash paths as standalone
  // folder mentions so ordinary sentences cannot become write authority.
  const promptWithoutFiles = files.reduce(
    (current, file) => current.split(file).join(" "),
    prompt,
  );
  const pathFolders =
    promptWithoutFiles.match(
      /[A-Za-z0-9.@()[\]_-]+(?:\/[A-Za-z0-9.@()[\]_-]+)+(?![A-Za-z0-9.@()[\]_-])/gu,
    ) ?? [];
  return [
    ...folders,
    ...quotedFolders,
    ...pathFolders.map((match) => normalizeMentionedPath(match)),
  ].filter(Boolean);
}

function normalizeMentionedPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^["'`]+|["'`.,:;!?]+$/g, "")
    .replace(/^\/+|\/+$/g, "");
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
