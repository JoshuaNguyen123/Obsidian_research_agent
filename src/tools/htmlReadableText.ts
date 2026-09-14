/**
 * Readable text out of an HTML page, with no DOM and no dependency.
 *
 * This exists so `web_fetch` has a transport that works without the Ollama
 * cloud retrieval endpoint. It is a reader, not a renderer: headings,
 * paragraphs, list items and block boundaries survive because passage
 * extraction and quote verification downstream are line- and
 * paragraph-oriented, and everything else becomes whitespace.
 *
 * Three decisions worth stating:
 *
 * - **Main content first.** When the page marks `<main>` or `<article>`, only
 *   that is read. Otherwise the whole body is read with nav, header, footer,
 *   aside and form removed. A site that marks neither gives us its chrome, and
 *   the usability gate downstream is what decides whether the result is worth
 *   citing.
 * - **Script, style and template content is dropped, not escaped.** Their text
 *   nodes are code, and code in a quote-verification corpus produces matches
 *   that mean nothing.
 * - **Bounded everywhere.** Entity decoding, tag stripping and whitespace
 *   collapsing all run over a capped string, so a hostile page cannot turn one
 *   fetch into unbounded work.
 */

/** Entities common in prose. Numeric forms are handled generically. */
const NAMED_ENTITIES_V1: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  deg: "°",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  eacute: "é",
  egrave: "è",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  szlig: "ß",
};

export function decodeHtmlEntitiesV1(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,31});/giu, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const codePoint = entity.startsWith("#x") || entity.startsWith("#X")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
        return match;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES_V1[entity.toLowerCase()] ?? match;
  });
}

/** `<title>` text, decoded and collapsed. */
export function htmlTitleV1(html: string): string {
  const match = /<title[^>]*>([\s\S]{0,500}?)<\/title>/iu.exec(html);
  if (!match) return "";
  return decodeHtmlEntitiesV1(match[1]!).replace(/\s+/gu, " ").trim();
}

function stripNonContentElements(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[\s\S]*?<\/\1>/giu, " ")
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/giu, " ");
}

function selectMainRegion(html: string): string {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/iu.exec(html);
  if (main && main[1]!.length > 200) return main[1]!;
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/iu.exec(html);
  if (article && article[1]!.length > 200) return article[1]!;
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/iu.exec(html);
  return body ? body[1]! : html;
}

export interface ReadableHtmlV1 {
  title: string;
  text: string;
  links: string[];
}

/**
 * Extract a readable document. `baseUrl` resolves relative links; a link that
 * cannot be resolved is dropped rather than guessed at.
 */
export function htmlToReadableTextV1(
  html: string,
  options: { baseUrl?: string; maxChars?: number; maxLinks?: number } = {},
): ReadableHtmlV1 {
  const maxChars = options.maxChars ?? 200_000;
  const source = html.length > maxChars * 4 ? html.slice(0, maxChars * 4) : html;
  const title = htmlTitleV1(source);
  const links = collectLinksV1(source, options.baseUrl, options.maxLinks ?? 50);
  const region = stripNonContentElements(selectMainRegion(source));
  const withBreaks = region
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|section|tr|li|h[1-6]|blockquote|pre|table|dd|dt)>/giu, "\n\n")
    .replace(/<li\b[^>]*>/giu, "\n- ")
    .replace(/<h1\b[^>]*>/giu, "\n\n# ")
    .replace(/<h2\b[^>]*>/giu, "\n\n## ")
    .replace(/<h3\b[^>]*>/giu, "\n\n### ")
    .replace(/<h([4-6])\b[^>]*>/giu, "\n\n#### ")
    .replace(/<t[dh]\b[^>]*>/giu, " | ");
  const text = decodeHtmlEntitiesV1(withBreaks.replace(/<[^>]+>/gu, " "))
    // Collapse runs of spaces and tabs but keep paragraph structure: the
    // passage extractor and the quote matcher both read block boundaries.
    .replace(/[ \t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return { title, text: text.slice(0, maxChars), links };
}

function collectLinksV1(
  html: string,
  baseUrl: string | undefined,
  maxLinks: number,
): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']{1,2000})["']/giu)) {
    const raw = decodeHtmlEntitiesV1(match[1]!).trim();
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel|data):/iu.test(raw)) {
      continue;
    }
    let resolved: string;
    try {
      resolved = baseUrl ? new URL(raw, baseUrl).toString() : new URL(raw).toString();
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    links.push(resolved);
    if (links.length >= maxLinks) break;
  }
  return links;
}

/** Content types this reader can turn into text. */
export function isReadableTextContentTypeV1(contentType: string | undefined): boolean {
  if (!contentType) return true; // Unlabelled: try, and let the usability gate judge.
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/xhtml+xml" ||
    type === "application/xml" ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}
