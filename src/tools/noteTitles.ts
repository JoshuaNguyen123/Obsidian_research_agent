export interface FrontmatterBlock {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
}

export interface Heading {
  start: number;
  end: number;
  text: string;
}

interface Line {
  start: number;
  end: number;
  textEnd: number;
  text: string;
}

export function detectFrontmatter(markdown: string): FrontmatterBlock | null {
  const lines = getLines(markdown);
  const firstLine = lines[0];

  if (!firstLine || firstLine.text !== "---") {
    return null;
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.text === "---") {
      return {
        start: firstLine.start,
        end: line.textEnd,
        contentStart: firstLine.end,
        contentEnd: line.start,
      };
    }
  }

  return null;
}

export function getFrontmatterTitle(markdown: string): string | null {
  const frontmatter = detectFrontmatter(markdown);
  if (!frontmatter) {
    return null;
  }

  const titleLine = findFrontmatterTitleLine(markdown, frontmatter);
  return titleLine ? parseYamlTitleValue(titleLine.value) : null;
}

export function getFirstH1(markdown: string): Heading | null {
  const frontmatter = detectFrontmatter(markdown);
  const bodyStart = frontmatter ? frontmatter.end : 0;
  const lines = getLines(markdown.slice(bodyStart), bodyStart);
  let fence: string | null = null;

  for (const line of lines) {
    const trimmedStart = line.text.trimStart();
    const fenceMarker = getFenceMarker(trimmedStart);

    if (fence) {
      if (fenceMarker === fence) {
        fence = null;
      }
      continue;
    }

    if (fenceMarker) {
      fence = fenceMarker;
      continue;
    }

    const match = /^(?: {0,3})#(?:[ \t]+)(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(
      line.text,
    );
    if (match) {
      return {
        start: line.start,
        end: line.textEnd,
        text: match[1].trim(),
      };
    }
  }

  return null;
}

export function replaceFrontmatterTitle(
  markdown: string,
  title: string,
): string {
  const frontmatter = detectFrontmatter(markdown);
  if (!frontmatter) {
    return markdown;
  }

  const formattedTitle = formatYamlTitle(title);
  const titleLine = findFrontmatterTitleLine(markdown, frontmatter);

  if (titleLine) {
    return `${markdown.slice(0, titleLine.valueStart)}${formattedTitle}${markdown.slice(
      titleLine.valueEnd,
    )}`;
  }

  return `${markdown.slice(0, frontmatter.contentStart)}title: ${formattedTitle}${getEol(
    markdown,
  )}${markdown.slice(frontmatter.contentStart)}`;
}

export function replaceFirstH1(markdown: string, title: string): string {
  const heading = getFirstH1(markdown);
  if (!heading) {
    return markdown;
  }

  return `${markdown.slice(0, heading.start)}# ${title}${markdown.slice(
    heading.end,
  )}`;
}

export function insertH1AfterFrontmatter(
  markdown: string,
  title: string,
): string {
  const frontmatter = detectFrontmatter(markdown);
  const eol = getEol(markdown);
  const heading = `# ${title}`;

  if (!frontmatter) {
    return markdown.length > 0 ? `${heading}${eol}${eol}${markdown}` : `${heading}${eol}`;
  }

  const afterFrontmatter = markdown.slice(frontmatter.end);
  const body = afterFrontmatter.replace(/^(?:\r?\n)+/, "");
  return `${markdown.slice(0, frontmatter.end)}${eol}${eol}${heading}${
    body.length > 0 ? `${eol}${eol}${body}` : eol
  }`;
}

export function retitleNoteMarkdown(markdown: string, title: string): string {
  const frontmatter = detectFrontmatter(markdown);
  const withFrontmatterTitle = frontmatter
    ? replaceFrontmatterTitle(markdown, title)
    : markdown;
  const heading = getFirstH1(withFrontmatterTitle);

  if (heading) {
    return replaceFirstH1(withFrontmatterTitle, title);
  }

  return insertH1AfterFrontmatter(withFrontmatterTitle, title);
}

/** Safe Obsidian note basename from a free-form title (no path separators). */
export function sanitizeFileBasename(title: string): string {
  return title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();
}

function findFrontmatterTitleLine(
  markdown: string,
  frontmatter: FrontmatterBlock,
):
  | {
      value: string;
      valueStart: number;
      valueEnd: number;
    }
  | null {
  const lines = getLines(
    markdown.slice(frontmatter.contentStart, frontmatter.contentEnd),
    frontmatter.contentStart,
  );

  for (const line of lines) {
    const match = /^title\s*:(.*)$/i.exec(line.text);
    if (!match) {
      continue;
    }

    const colonIndex = line.text.indexOf(":");
    const valueStart = line.start + colonIndex + 1 + countLeadingWhitespace(match[1]);
    return {
      value: line.text.slice(colonIndex + 1).trim(),
      valueStart,
      valueEnd: line.textEnd,
    };
  }

  return null;
}

function parseYamlTitleValue(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function formatYamlTitle(title: string): string {
  if (/^[^\s:[\]{}#,&*!?|>'"%@`][^:[\]{}#\n\r]*$/.test(title)) {
    return title;
  }

  return JSON.stringify(title);
}

function getFenceMarker(trimmedStart: string): string | null {
  const match = /^(```+|~~~+)/.exec(trimmedStart);
  if (!match) {
    return null;
  }

  return match[1].startsWith("`") ? "```" : "~~~";
}

function countLeadingWhitespace(value: string): number {
  const match = /^[ \t]*/.exec(value);
  return match ? match[0].length : 0;
}

function getEol(markdown: string): string {
  return markdown.includes("\r\n") ? "\r\n" : "\n";
}

function getLines(markdown: string, offset = 0): Line[] {
  const lines: Line[] = [];
  const pattern = /.*(?:\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(markdown)) !== null) {
    const raw = match[0];
    if (raw.length === 0) {
      break;
    }

    const newlineLength = raw.endsWith("\r\n")
      ? 2
      : raw.endsWith("\n") || raw.endsWith("\r")
        ? 1
        : 0;
    const start = offset + match.index;
    const end = start + raw.length;
    const textEnd = end - newlineLength;
    lines.push({
      start,
      end,
      textEnd,
      text: raw.slice(0, raw.length - newlineLength),
    });
  }

  return lines;
}
