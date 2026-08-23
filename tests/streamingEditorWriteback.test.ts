import assert from "node:assert/strict";
import test from "node:test";
import {
  computeMinimalEditRange,
  hasStreamFollowDetached,
  setEditorValueFollowingStreamEnd,
  type StreamingFollowEditor,
} from "../src/obsidianEditorFollow";

/**
 * Structural stand-in for the Obsidian editor, with the whole streaming
 * surface. `src/obsidianEditorFollow.ts` is deliberately Obsidian-free, so a
 * fake editor is the only thing these paths ever need to be driven against.
 *
 * The caret behaviour is modelled on CodeMirror: `replaceRange` maps the
 * selection through the change, `setValue` drops it to the document start.
 */
function createFakeEditor(initial: string) {
  let value = initial;
  let anchor = 0;
  let head = 0;
  let scrollTop = 0;
  const scrolls: Array<{ line: number; ch: number }> = [];
  const setValueCalls: string[] = [];
  const rangedWrites: Array<{ from: number; to: number; text: string }> = [];

  const posToOffset = (pos: { line: number; ch: number }) => {
    const lines = value.split("\n");
    let offset = 0;
    for (let i = 0; i < pos.line && i < lines.length; i += 1) {
      offset += lines[i].length + 1;
    }
    return offset + pos.ch;
  };
  const offsetToPos = (offset: number) => {
    const clamped = Math.max(0, Math.min(offset, value.length));
    const before = value.slice(0, clamped);
    const line = before.split("\n").length - 1;
    const ch = clamped - (before.lastIndexOf("\n") + 1);
    return { line, ch };
  };

  const editor: StreamingFollowEditor = {
    getValue: () => value,
    setValue: (next: string) => {
      setValueCalls.push(next);
      value = next;
      anchor = 0;
      head = 0;
    },
    replaceRange: (
      replacement: string,
      from: { line: number; ch: number },
      to?: { line: number; ch: number },
    ) => {
      const fromOffset = posToOffset(from);
      const toOffset = to ? posToOffset(to) : fromOffset;
      rangedWrites.push({ from: fromOffset, to: toOffset, text: replacement });
      value = value.slice(0, fromOffset) + replacement + value.slice(toOffset);
      const shift = replacement.length - (toOffset - fromOffset);
      const map = (offset: number) =>
        offset <= fromOffset
          ? offset
          : offset >= toOffset
            ? offset + shift
            : fromOffset + replacement.length;
      anchor = map(anchor);
      head = map(head);
    },
    getCursor: (which) => offsetToPos(which === "anchor" ? anchor : head),
    setCursor: (pos) => {
      anchor = posToOffset(pos);
      head = anchor;
    },
    setSelection: (nextAnchor, nextHead) => {
      anchor = posToOffset(nextAnchor);
      head = nextHead ? posToOffset(nextHead) : anchor;
    },
    posToOffset,
    offsetToPos,
    getScrollInfo: () => ({ top: scrollTop, left: 0 }),
    scrollIntoView: (range) => {
      scrolls.push(range.to);
      scrollTop = posToOffset(range.to);
    },
  };

  return {
    editor,
    scrolls,
    setValueCalls,
    rangedWrites,
    getValue: () => value,
    getSelection: () => ({ anchor, head }),
    place: (offset: number) => {
      anchor = offset;
      head = offset;
    },
    select: (from: number, to: number) => {
      anchor = from;
      head = to;
    },
    scrollTo: (top: number) => {
      scrollTop = top;
    },
  };
}

test("computeMinimalEditRange returns a pure tail insertion for an append", () => {
  assert.deepEqual(computeMinimalEditRange("abc", "abcdef"), {
    from: 3,
    to: 3,
    text: "def",
  });
});

test("computeMinimalEditRange returns null when nothing changed", () => {
  assert.equal(computeMinimalEditRange("same", "same"), null);
});

test("computeMinimalEditRange inserts in the middle when a suffix is preserved", () => {
  // The shape of a streamed section edit: fixed prefix, growing body, fixed suffix.
  assert.deepEqual(
    computeMinimalEditRange("## H\nold\n## Next", "## H\nold body\n## Next"),
    { from: 8, to: 8, text: " body" },
  );
});

test("computeMinimalEditRange never splits a surrogate pair", () => {
  const previous = "a\u{1F600}";
  const edit = computeMinimalEditRange(previous, "a\u{1F600}\u{1F601}");
  assert.ok(edit);
  // Both emoji share the 0xD83D lead unit, so a naive prefix scan lands
  // between the surrogates and hands the editor an impossible offset.
  assert.ok(!/^[\uDC00-\uDFFF]/u.test(previous.slice(edit.from)));
  const applied =
    previous.slice(0, edit.from) + edit.text + previous.slice(edit.to);
  assert.equal(applied, "a\u{1F600}\u{1F601}");
});

test("streamed flush writes only the delta and leaves an earlier caret alone", () => {
  const fake = createFakeEditor("Existing note.\n");
  fake.place(5); // reader's caret sits inside the existing text

  const mode = setEditorValueFollowingStreamEnd(
    fake.editor,
    "Existing note.\nStreamed paragraph one.",
    { followStreamingEnd: true, streamKey: "s1" },
  );

  assert.equal(mode, "ranged");
  assert.deepEqual(fake.rangedWrites, [
    { from: 15, to: 15, text: "Streamed paragraph one." },
  ]);
  assert.deepEqual(
    fake.setValueCalls,
    [],
    "a streamed flush must not replace the whole editor buffer",
  );
  assert.deepEqual(fake.getSelection(), { anchor: 5, head: 5 });
});

test("streamed flush preserves a caret that sits after the insertion point", () => {
  const fake = createFakeEditor("## H\nold\n## Next");
  const caret = "## H\nold\n## Ne".length;
  fake.place(caret);

  setEditorValueFollowingStreamEnd(fake.editor, "## H\nold body\n## Next", {});

  assert.equal(fake.getValue(), "## H\nold body\n## Next");
  assert.deepEqual(fake.getSelection(), {
    anchor: caret + " body".length,
    head: caret + " body".length,
  });
});

test("streamed flush preserves a selection across the delta write", () => {
  const fake = createFakeEditor("Existing note.\n");
  fake.select(2, 8);

  setEditorValueFollowingStreamEnd(fake.editor, "Existing note.\nmore", {});

  assert.deepEqual(fake.getSelection(), { anchor: 2, head: 8 });
});

test("full-buffer fallback restores the caret the replace destroyed", () => {
  const fake = createFakeEditor("Existing note.\n");
  fake.place(5);
  // An editor without replaceRange still has to keep the reader's place.
  const editor: StreamingFollowEditor = {
    getValue: fake.editor.getValue,
    setValue: fake.editor.setValue,
    getCursor: fake.editor.getCursor,
    setCursor: fake.editor.setCursor,
    posToOffset: fake.editor.posToOffset,
    offsetToPos: fake.editor.offsetToPos,
  };

  const mode = setEditorValueFollowingStreamEnd(
    editor,
    "Existing note.\nStreamed.",
    {},
  );

  assert.equal(mode, "full_replace");
  assert.deepEqual(fake.setValueCalls, ["Existing note.\nStreamed."]);
  assert.deepEqual(fake.getSelection(), { anchor: 5, head: 5 });
});

test("identical content is not written to the editor at all", () => {
  const fake = createFakeEditor("Unchanged.");

  const mode = setEditorValueFollowingStreamEnd(fake.editor, "Unchanged.", {});

  assert.equal(mode, "unchanged");
  assert.deepEqual(fake.rangedWrites, []);
  assert.deepEqual(fake.setValueCalls, []);
});

/** Streamed paragraphs long enough to move a viewport by a visible amount. */
const paragraph = (n: number) =>
  `Paragraph ${n}: ${"streamed sentence. ".repeat(4)}\n`;

test("stream following gives up for the rest of the stream once the reader scrolls away", () => {
  const fake = createFakeEditor("");
  let content = "";

  for (const n of [1, 2]) {
    content += paragraph(n);
    setEditorValueFollowingStreamEnd(fake.editor, content, {
      followStreamingEnd: true,
      streamKey: "s1",
    });
  }
  assert.equal(fake.scrolls.length, 2);
  assert.equal(hasStreamFollowDetached(fake.editor, "s1"), false);

  // Reader scrolls back up to re-read something while the stream continues.
  fake.scrollTo(0);

  for (const n of [3, 4]) {
    content += paragraph(n);
    setEditorValueFollowingStreamEnd(fake.editor, content, {
      followStreamingEnd: true,
      streamKey: "s1",
    });
  }

  assert.equal(hasStreamFollowDetached(fake.editor, "s1"), true);
  assert.equal(
    fake.scrolls.length,
    2,
    "viewport was yanked back after the reader scrolled away",
  );
  assert.equal(
    fake.getValue(),
    content,
    "detaching the viewport must not stop the note from being written",
  );
});

test("a new stream re-attaches viewport following", () => {
  const fake = createFakeEditor("");
  setEditorValueFollowingStreamEnd(fake.editor, paragraph(1), {
    followStreamingEnd: true,
    streamKey: "s1",
  });
  fake.scrollTo(0);
  setEditorValueFollowingStreamEnd(fake.editor, paragraph(1) + paragraph(2), {
    followStreamingEnd: true,
    streamKey: "s1",
  });
  assert.equal(hasStreamFollowDetached(fake.editor, "s1"), true);

  const scrollsBefore = fake.scrolls.length;
  setEditorValueFollowingStreamEnd(fake.editor, `${paragraph(1)}next stream`, {
    followStreamingEnd: true,
    streamKey: "s2",
  });

  assert.equal(hasStreamFollowDetached(fake.editor, "s2"), false);
  assert.equal(fake.scrolls.length, scrollsBefore + 1);
});
