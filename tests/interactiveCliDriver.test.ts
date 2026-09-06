import assert from "node:assert/strict";
import test from "node:test";

import {
  CLI_DRIVER_RESPONSE_CAP,
  createCliDriverState,
  decideCliResponse,
} from "../e2e/fixtures/interactiveCliDriver";

test("a difficulty menu gets a menu answer, then the game's guesses follow its feedback", () => {
  const state = createCliDriverState();
  let transcript = "Welcome!\nDifficulty [easy/medium/hard]: ";
  assert.equal(decideCliResponse(state, transcript, transcript), "easy");

  let pending = "I'm thinking of a number between 1 and 100.\nYour guess: ";
  transcript += pending;
  assert.equal(decideCliResponse(state, pending, transcript), "50");

  pending = "Too high! Try again: ";
  transcript += pending;
  assert.equal(decideCliResponse(state, pending, transcript), "25");

  pending = "Too low! Guess: ";
  transcript += pending;
  assert.equal(decideCliResponse(state, pending, transcript), "37");

  pending = "Correct! You won in 3 tries. Play again? (y/n): ";
  transcript += pending;
  assert.equal(decideCliResponse(state, pending, transcript), "n");
});

test("a menu that rejects the first answer gets the next candidate, then the driver bows out", () => {
  const state = createCliDriverState();
  const prompt = "Choose difficulty level: ";
  const answers = new Set<string>();
  let last: string | null = "";
  for (let index = 0; index < 20 && last !== null; index += 1) {
    last = decideCliResponse(state, prompt, prompt);
    if (last !== null) answers.add(last);
  }
  assert.equal(last, null, "the driver never gives up on a menu it cannot satisfy");
  assert.ok(answers.has("easy") && answers.has("1"));
});

test("a game with no higher/lower feedback falls back to counting up from the low bound", () => {
  const state = createCliDriverState();
  const first = decideCliResponse(state, "Guess a number between 1 and 10: ", "Guess a number between 1 and 10: ");
  assert.equal(first, "5");
  // Two silent rounds keep bisecting the unchanged range; the third switches
  // to walking the range from the bottom (skipping the value already tried)
  // so a feedback-less game still ends.
  assert.equal(decideCliResponse(state, "Nope. Guess: ", "Nope. Guess: "), "5");
  assert.equal(decideCliResponse(state, "Nope. Guess: ", "Nope. Guess: "), "5");
  const walked: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    walked.push(String(decideCliResponse(state, "Nope. Guess: ", "Nope. Guess: ")));
  }
  assert.deepEqual(walked, ["1", "2", "3", "4", "6", "7"]);
});

test("the response cap closes stdin instead of answering forever", () => {
  const state = createCliDriverState();
  state.responses = CLI_DRIVER_RESPONSE_CAP;
  assert.equal(decideCliResponse(state, "Guess: ", "Guess: "), null);
});

test("name prompts and play-again prompts are answered by content", () => {
  const state = createCliDriverState();
  assert.equal(decideCliResponse(state, "What is your name? ", ""), "Player");
  assert.equal(decideCliResponse(state, "Would you like to play again? [y/n] ", ""), "n");
});

// --- startup silence must not establish a gameplay range -------------------
// A program that has printed nothing has not told the driver what game it is
// playing. The answer the driver sends into that silence is a guess about
// *what is being asked*, not a move in a round, and it must not fix the range
// the rest of the run bisects.

test("a speculative answer sent into startup silence does not fix the range", () => {
  const state = createCliDriverState();
  // Python's cold start on Windows can outlast the driver's startup wait, so
  // the driver answers before the program has said anything at all.
  const speculative = decideCliResponse(state, "", "");
  assert.notEqual(speculative, null, "the driver must still answer a silent read");

  // Only now does the program speak, and it names a range the speculative
  // answer knew nothing about.
  const pending =
    "Welcome!\nI'm thinking of a number between 1 and 1000.\nYour guess: ";
  assert.equal(
    decideCliResponse(state, pending, pending),
    "500",
    "the announced range must be learned even after a speculative answer",
  );
});

test("a speculative answer sent into startup silence is not a gameplay guess", () => {
  const state = createCliDriverState();
  decideCliResponse(state, "", "");
  assert.equal(
    state.lastGuess,
    null,
    "silence must not record a guess the program never asked for",
  );

  // The program's first feedback line therefore cannot be attributed to the
  // speculative answer: "too high" about nothing must not shrink the range.
  const pending =
    "Too high!\nI'm thinking of a number between 1 and 100.\nYour guess: ";
  assert.equal(decideCliResponse(state, pending, pending), "50");
});

test("a round transition re-learns the range instead of reusing the solved one", () => {
  const state = createCliDriverState();
  let pending = "I'm thinking of a number between 1 and 100.\nYour guess: ";
  assert.equal(decideCliResponse(state, pending, pending), "50");
  pending = "Too high!\nYour guess: ";
  assert.equal(decideCliResponse(state, pending, pending), "25");
  pending = "Too low!\nYour guess: ";
  assert.equal(decideCliResponse(state, pending, pending), "37");

  // The program starts a second round by itself, with a different range.
  pending =
    "Correct!\nRound 2: I'm thinking of a number between 1 and 20.\nYour guess: ";
  assert.equal(
    decideCliResponse(state, pending, pending),
    "10",
    "round two must be played on round two's range",
  );
});
