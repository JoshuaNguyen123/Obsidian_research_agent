export interface RenameReceiptLike {
  toolName?: string;
  operation?: string;
  path?: string;
  toPath?: string;
}

const PLACEHOLDER_NOTE_BASENAME = /^Untitled(?:\s+\d+)?$/i;

export function isPlaceholderNoteBasename(basename: string): boolean {
  return PLACEHOLDER_NOTE_BASENAME.test(basename.trim());
}

export function isMarkdownTitleContentIntent(prompt: string): boolean {
  return /\b(frontmatter|metadata|properties|h1|heading|markdown\s+title|title\s+field|yaml\s+title)\b/i.test(
    prompt,
  );
}

/**
 * Explicit user request to change the visible Obsidian file/tab title.
 * Does not match ordinary "write X with the title Y" generation prompts —
 * those rely on runner-owned placeholder auto-rename after writeback.
 */
export function isExplicitVisibleFileRenameIntent(prompt: string): boolean {
  if (isMarkdownTitleContentIntent(prompt)) {
    return false;
  }

  return /\b(retitle|rename)\b|\b(change|update|set|replace)\b[\s\S]{0,48}\b(?:the\s+)?(?:page\s+title|file\s+title|tab\s+title|visible\s+title|note\s+title|title)\b|\b(?:page\s+title|file\s+title|tab\s+title|visible\s+title)\b|\bcall\s+(?:this|the)\s+note\b|\btarget\s+\S+[\s\S]{0,100}\b(?:title|change|replace|move)\b|\b(?:move|put|place)\b[\s\S]{0,120}\btitle\b[\s\S]{0,80}\b(?:spot|place|top|page|file|tab)\b/i.test(
    prompt,
  );
}

export function isVisibleTitleRenameIntent(prompt: string): boolean {
  if (isMarkdownTitleContentIntent(prompt)) {
    return false;
  }

  if (isExplicitVisibleFileRenameIntent(prompt)) {
    return true;
  }

  return /\b(title|untitled)\b/i.test(prompt);
}

export function isTitleOnlyIntent(prompt: string): boolean {
  if (
    !isMarkdownTitleContentIntent(prompt) &&
    !isVisibleTitleRenameIntent(prompt)
  ) {
    return false;
  }

  const contentMutation =
    /\b(append|add|insert|write|draft|compose|generate|create|stream|essay|article|paragraph|report|brief|summary|content)\b/i.test(
      prompt,
    );
  const separateResearchAction =
    /(?:^|[,;.]|\b(?:and|then|also)\b)\s*(?:please\s+)?(?:perform|conduct|do|continue|start|deep\s+dive|(?:deep\s+|web\s+|online\s+)?research|investigate|search|browse|verify|compare|inspect|analy[sz]e|gather|cite|source|graph)\b/i.test(
      prompt,
    );

  return !contentMutation && !separateResearchAction;
}

export function extractRequestedVisibleTitle(
  prompt: string,
  currentMarkdown = "",
): string | null {
  const promptTitle =
    extractTitleAfterMarker(prompt, /\btitle\s+["']?([^"'\n.]+)["']?/i) ??
    extractTitleAfterMarker(prompt, /\bcalled\s+["']?([^"'\n.]+)["']?/i) ??
    extractTitleAfterMarker(prompt, /\bname(?:d)?\s+["']?([^"'\n.]+)["']?/i);
  if (promptTitle) {
    return promptTitle;
  }

  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(currentMarkdown)?.[1]?.trim();
  return heading && !/^untitled$/i.test(heading) ? heading : null;
}

export function verifyVisibleRenameReceipt(receipt: RenameReceiptLike): boolean {
  return (
    receipt.toolName === "rename_current_file" &&
    receipt.operation === "rename_current_file" &&
    typeof receipt.toPath === "string" &&
    receipt.toPath.trim().length > 0 &&
    receipt.toPath !== receipt.path
  );
}

function extractTitleAfterMarker(prompt: string, pattern: RegExp): string | null {
  const value = pattern.exec(prompt)?.[1]?.trim();
  if (!value) {
    return null;
  }

  return value
    .replace(/\s+(?:on|in|to)\s+(?:this|the|current)\s+(?:page|note|file).*$/i, "")
    .replace(/\s+with\s+\d+\s+words?.*$/i, "")
    .trim() || null;
}
