/**
 * Bounded text helpers for the XML-ish payloads the scholarly APIs return
 * (arXiv Atom entries, Crossref JATS abstracts). Deliberately regex-based: the
 * plugin ships with zero runtime dependencies and there is no DOM shared by the
 * Node test runner and the Obsidian renderer, so a parser would mean either a
 * dependency or two implementations. Every helper is defensive — a malformed
 * fragment yields an empty string rather than throwing.
 *
 * Shared by `citationTools.ts` (resolve_citation) and `freeSearchProviders.ts`
 * (the keyless arXiv/Crossref fallbacks) so the two never drift.
 */

/** Read the first `<tag>…</tag>` body out of an XML fragment. */
export function xmlText(fragment: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "u").exec(fragment);
  return match?.[1] ?? "";
}

/** Collapse every whitespace run to a single space and trim. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** Strip JATS/HTML markup from an abstract, leaving readable prose. */
export function stripJats(value: string): string {
  return collapseWhitespace(value.replace(/<[^>]+>/gu, " "));
}

/** Decode the small set of XML entities the scholarly APIs actually emit. */
export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_match, code: string) => {
      const point = Number(code);
      return Number.isInteger(point) && point > 0 && point < 0x110000
        ? String.fromCodePoint(point)
        : "";
    })
    // Ampersand last so a decoded entity is never re-decoded.
    .replace(/&amp;/gu, "&");
}

/** Split an Atom document into its `<entry>` bodies, bounded by `limit`. */
export function atomEntries(xml: string, limit: number): string[] {
  const entries: string[] = [];
  const bound = Math.max(0, Math.floor(limit));
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gu)) {
    if (entries.length >= bound) break;
    const body = match[1];
    if (typeof body === "string" && body.trim()) entries.push(body);
  }
  return entries;
}
