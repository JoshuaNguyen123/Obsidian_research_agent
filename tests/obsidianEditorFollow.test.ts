import assert from "node:assert/strict";
import test from "node:test";
import {
  followEditorStreamingEnd,
  setEditorValueFollowingStreamEnd,
  type StreamingFollowEditor,
} from "../src/obsidianEditorFollow";

test("setEditorValueFollowingStreamEnd scrolls to content end when followStreamingEnd is set", () => {
  const scrolls: Array<{ line: number; ch: number }> = [];
  let value = "";
  const editor: StreamingFollowEditor = {
    setValue: (next) => {
      value = next;
    },
    offsetToPos: (offset) => {
      assert.equal(offset, value.length);
      return { line: 2, ch: 5 };
    },
    scrollIntoView: (range, center) => {
      assert.equal(center, false);
      scrolls.push(range.to);
    },
  };

  setEditorValueFollowingStreamEnd(editor, "one\ntwo\nthree", {
    followStreamingEnd: true,
  });

  assert.equal(value, "one\ntwo\nthree");
  assert.deepEqual(scrolls, [{ line: 2, ch: 5 }]);
});

test("setEditorValueFollowingStreamEnd does not scroll without followStreamingEnd", () => {
  let scrolled = false;
  const editor: StreamingFollowEditor = {
    setValue: () => undefined,
    offsetToPos: () => ({ line: 0, ch: 0 }),
    scrollIntoView: () => {
      scrolled = true;
    },
  };

  setEditorValueFollowingStreamEnd(editor, "hello");
  assert.equal(scrolled, false);
});

test("followEditorStreamingEnd falls back to lastLine when offsetToPos is missing", () => {
  const scrolls: Array<{ line: number; ch: number }> = [];
  const editor: StreamingFollowEditor = {
    lastLine: () => 3,
    getLine: (line) => (line === 3 ? "tail" : ""),
    scrollIntoView: (range) => {
      scrolls.push(range.to);
    },
  };

  followEditorStreamingEnd(editor, "ignored");
  assert.deepEqual(scrolls, [{ line: 3, ch: 4 }]);
});
