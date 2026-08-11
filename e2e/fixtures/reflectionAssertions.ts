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
  const visible = raw
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const countable = visible.replace(/https?:\/\/[^\s)]+/giu, " ");
  const words =
    countable.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) ?? [];
  return { count: starts.length, visible, wordCount: words.length };
}
