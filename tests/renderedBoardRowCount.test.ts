import test from "node:test";
import assert from "node:assert/strict";

import { renderedBoardRowCount } from "../e2e/fixtures/desktopDelivery";

/**
 * Captured verbatim from a real DESKTOP-CHECKERS run: the model's delivered
 * game printed this when launched. Splitting only on whitespace dropped every
 * blank square and scored a perfectly good board zero, so the real output is
 * pinned here.
 */
const DELIVERED_PIPE_BOARD = [
  "CLI Checkers. Captures are mandatory. Multi-jumps are taken in one turn.",
  "Enter moves as 'b6-a3'. Capture chains use ':' or 'x' or '>' separators, e.g. 'b6:c3:a1'.",
  "Type 'quit' to resign.",
  "",
  "    a   b   c   d   e   f   g   h",
  "  +---+---+---+---+---+---+---+---+",
  "8 |   | b |   | b |   | b |   | b |",
  "  +---+---+---+---+---+---+---+---+",
  "7 | b |   | b |   | b |   | b |   |",
  "  +---+---+---+---+---+---+---+---+",
  "6 |   | b |   | b |   | b |   | b |",
  "  +---+---+---+---+---+---+---+---+",
  "5 |   |   |   |   |   |   |   |   |",
  "  +---+---+---+---+---+---+---+---+",
  "4 |   |   |   |   |   |   |   |   |",
  "  +---+---+---+---+---+---+---+---+",
  "3 | r |   | r |   | r |   | r |   |",
  "  +---+---+---+---+---+---+---+---+",
  "2 |   | r |   | r |   | r |   | r |",
  "  +---+---+---+---+---+---+---+---+",
  "1 | r |   | r |   | r |   | r |   |",
  "  +---+---+---+---+---+---+---+---+",
  "    a   b   c   d   e   f   g   h",
].join("\n");

const PLAIN_TOKEN_BOARD = [
  "8  . b . b . b . b",
  "7  b . b . b . b .",
  "6  . b . b . b . b",
  "5  . . . . . . . .",
  "4  . . . . . . . .",
  "3  r . r . r . r .",
  "2  . r . r . r . r",
  "1  r . r . r . r .",
].join("\n");

const FIXED_WIDTH_BLANK_CELL_BOARD = [
  "    A   B   C   D   E   F   G   H ",
  " 1      b       b       b       b ",
  " 2  b       b       b       b     ",
  " 3      b       b       b       b ",
  " 4                                ",
  " 5                                ",
  " 6  r       r       r       r     ",
  " 7      r       r       r       r ",
  " 8  r       r       r       r     ",
  "    A   B   C   D   E   F   G   H ",
].join("\r\n");

/**
 * Captured from a live desktop-checkers run. Only playable squares receive a
 * glyph and each logical square is two columns wide, so the row body is 16
 * characters rather than the wider four-column layouts above.
 */
const COMPACT_PLAYABLE_SQUARE_BOARD = [
  "   a b c d e f g h",
  "1    b   b   b   b ",
  "2  b   b   b   b   ",
  "3    b   b   b   b ",
  "4  .   .   .   .   ",
  "5    .   .   .   . ",
  "6  r   r   r   r   ",
  "7    r   r   r   r ",
  "8  r   r   r   r   ",
].join("\n");

/**
 * Captured from a second real-model run. This renderer labels both sides and
 * uses only spaces for empty rows; the right label must be removed without
 * greedily consuming the row's board-width whitespace.
 */
const MIRRORED_LABEL_BOARD = [
  "   h g f e d c b a",
  " 8     r     r     r     r  8",
  " 7  r     r     r     r     7",
  " 6     r     r     r     r  6",
  " 5                          5",
  " 4                          4",
  " 3  b     b     b     b     3",
  " 2     b     b     b     b  2",
  " 1  b     b     b     b     1",
  "   h g f e d c b a",
].join("\r\n");

/**
 * Captured from a third real-model run. Pipes bound the whole fixed-width row
 * instead of each cell, and only the four playable squares are printed.
 */
const OUTER_FRAME_FIXED_WIDTH_BOARD = [
  "    a b c d e f g h",
  "   +-----------------+",
  "8  |    b     b     b     b |",
  "7  | b     b     b     b    |",
  "6  |    b     b     b     b |",
  "5  | .     .     .     .    |",
  "4  |    .     .     .     . |",
  "3  | r     r     r     r    |",
  "2  |    r     r     r     r |",
  "1  | r     r     r     r    |",
  "   +-----------------+",
].join("\r\n");

const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";
const ANSI_RED_PIECE =
  "\u001b[48;5;52m \u001b[31m\u001b[1m\u25cf\u001b[0m\u001b[0m";
const ANSI_BLUE_PIECE =
  "\u001b[48;5;52m \u001b[34m\u001b[1m\u25cf\u001b[0m\u001b[0m";
const ANSI_EMPTY = "\u001b[48;5;230m  \u001b[0m";
const ansiRow = (
  label: number,
  cells: readonly string[],
): string =>
  `${ANSI_DIM} ${label} |${ANSI_RESET}${cells.join(" ")}${ANSI_DIM}|${ANSI_RESET}`;

/**
 * Captured shape from a fourth real-model run. Each square and piece carries
 * ANSI SGR color/style sequences, while the printable board remains the same
 * bounded outer-frame layout.
 */
const ANSI_COLORED_OUTER_FRAME_BOARD = [
  `${ANSI_DIM}    a b c d e f g h${ANSI_RESET}`,
  `${ANSI_DIM}   +-----------------+${ANSI_RESET}`,
  ansiRow(8, [
    ANSI_EMPTY,
    ANSI_BLUE_PIECE,
    ANSI_EMPTY,
    ANSI_BLUE_PIECE,
    ANSI_EMPTY,
    ANSI_BLUE_PIECE,
    ANSI_EMPTY,
    ANSI_BLUE_PIECE,
  ]),
  ansiRow(7, [
    ANSI_BLUE_PIECE,
    ANSI_EMPTY,
    ANSI_BLUE_PIECE,
    ANSI_EMPTY,
    ANSI_BLUE_PIECE,
    ANSI_EMPTY,
    ANSI_BLUE_PIECE,
    ANSI_EMPTY,
  ]),
  ansiRow(6, [
    ANSI_EMPTY,
    ANSI_BLUE_PIECE,
    ANSI_EMPTY,
    ANSI_BLUE_PIECE,
    ANSI_EMPTY,
    ANSI_BLUE_PIECE,
    ANSI_EMPTY,
    ANSI_BLUE_PIECE,
  ]),
  ansiRow(5, Array.from({ length: 8 }, () => ANSI_EMPTY)),
  ansiRow(4, Array.from({ length: 8 }, () => ANSI_EMPTY)),
  ansiRow(3, [
    ANSI_RED_PIECE,
    ANSI_EMPTY,
    ANSI_RED_PIECE,
    ANSI_EMPTY,
    ANSI_RED_PIECE,
    ANSI_EMPTY,
    ANSI_RED_PIECE,
    ANSI_EMPTY,
  ]),
  ansiRow(2, [
    ANSI_EMPTY,
    ANSI_RED_PIECE,
    ANSI_EMPTY,
    ANSI_RED_PIECE,
    ANSI_EMPTY,
    ANSI_RED_PIECE,
    ANSI_EMPTY,
    ANSI_RED_PIECE,
  ]),
  ansiRow(1, [
    ANSI_RED_PIECE,
    ANSI_EMPTY,
    ANSI_RED_PIECE,
    ANSI_EMPTY,
    ANSI_RED_PIECE,
    ANSI_EMPTY,
    ANSI_RED_PIECE,
    ANSI_EMPTY,
  ]),
  `${ANSI_DIM}   +-----------------+${ANSI_RESET}`,
].join("\r\n");

test("a real pipe-delimited board counts eight rows", () => {
  assert.equal(renderedBoardRowCount(DELIVERED_PIPE_BOARD), 8);
});

test("a plain token board counts eight rows", () => {
  assert.equal(renderedBoardRowCount(PLAIN_TOKEN_BOARD), 8);
});

test("a real fixed-width board with whitespace-only empty rows counts eight rows", () => {
  assert.equal(renderedBoardRowCount(FIXED_WIDTH_BLANK_CELL_BOARD), 8);
});

test("a compact four-playable-square board counts eight rows", () => {
  assert.equal(renderedBoardRowCount(COMPACT_PLAYABLE_SQUARE_BOARD), 8);
});

test("a mirrored-label fixed-width board counts all eight rows", () => {
  assert.equal(renderedBoardRowCount(MIRRORED_LABEL_BOARD), 8);
});

test("an outer-frame fixed-width board counts all eight rows", () => {
  assert.equal(renderedBoardRowCount(OUTER_FRAME_FIXED_WIDTH_BOARD), 8);
});

test("an ANSI-colored Unicode board counts all eight printable rows", () => {
  assert.equal(renderedBoardRowCount(ANSI_COLORED_OUTER_FRAME_BOARD), 8);
});

test("ordinary prose and prompts are not counted as board rows", () => {
  assert.equal(
    renderedBoardRowCount(
      [
        "Welcome to checkers!",
        "Choose an opponent: 1) human 2) computer",
        "Your move (e.g. b6-a3): ",
        "Invalid move. Captures are mandatory.",
      ].join("\n"),
    ),
    0,
  );
  assert.equal(renderedBoardRowCount(""), 0);
});
