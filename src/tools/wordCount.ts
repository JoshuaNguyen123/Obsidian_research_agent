export interface MarkdownWordCount {
  wordCount: number;
  characterCount: number;
  nonWhitespaceCharacterCount: number;
  lineCount: number;
  mode: "markdown_visible_text";
}

export function countMarkdownVisibleText(markdown: string): MarkdownWordCount {
  const visibleText = markdownToVisibleText(markdown);
  const words =
    visibleText.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu) ?? [];

  return {
    wordCount: words.length,
    characterCount: visibleText.length,
    nonWhitespaceCharacterCount: visibleText.replace(/\s/g, "").length,
    lineCount: markdown.length === 0 ? 0 : markdown.split(/\r\n|\r|\n/).length,
    mode: "markdown_visible_text",
  };
}

function markdownToVisibleText(markdown: string): string {
  let text = stripFrontmatter(markdown);

  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/~~~[\s\S]*?~~~/g, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_match, target: string) =>
    target.split("#")[0].split("/").pop() ?? target,
  );
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  text = text.replace(/[*_~>#|[\]()`]/g, " ");
  text = text.replace(/-{3,}/g, " ");

  return text.replace(/\s+/g, " ").trim();
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^(?:---|\+\+\+)\r?\n[\s\S]*?\r?\n(?:---|\+\+\+)\r?\n?/, "");
}
