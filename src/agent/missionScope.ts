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
    (input.noteOutput === true && !broadVaultWriteTarget) ||
    /\b(append|write|save|insert|stream|add|paste|copy|edit|revise|update|retitle|rename|link|connect)\b[\s\S]{0,160}\b(note|page|document|file|section|heading)\b/i.test(
      prompt,
    ) ||
    /\b(note|page|document|file|section|heading)\b[\s\S]{0,160}\b(append|write|save|insert|stream|add|paste|copy|edit|revise|update|retitle|rename|link|connect)\b/i.test(
      prompt,
    );
  scope.write.researchMemory =
    /\b(remember|save|persist|store)\b[\s\S]{0,120}\b(research memory|memory)\b/i.test(
      prompt,
    ) ||
    /\b(experience memory|procedural memory|episodic memory|semantic memory|source memory|memory write|learned strategy)\b/i.test(
      prompt,
    ) ||
    /\bresearch memory\b/i.test(prompt);
  scope.write.artifacts =
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

function extractMarkdownPathMentions(prompt: string): string[] {
  const matches = prompt.match(/[A-Za-z0-9 .@()[\]_-]+(?:\/[A-Za-z0-9 .@()[\]_-]+)+\.md\b/g) ?? [];
  return matches.map((match) => normalizeMentionedPath(match)).filter(Boolean);
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
  const pathFolders = prompt.match(/[A-Za-z0-9 .@()[\]_-]+(?:\/[A-Za-z0-9 .@()[\]_-]+)+(?!\.md\b)/g) ?? [];
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
