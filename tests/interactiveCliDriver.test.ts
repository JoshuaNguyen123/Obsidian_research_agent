import assert from "node:assert/strict";
import test from "node:test";

import {
  CLI_DRIVER_RESPONSE_CAP,
  CLI_DRIVER_SPECULATIVE_ANSWER,
  chooseDeclineAnswer,
  createCliDriverState,
  decideCliResponse,
  offeredChoiceTokens,
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

// --- play-again is declined in the program's own vocabulary ----------------
// Cohort 2 of the 504-mission qualification (2026-09-06) was lost at
// occurrence 77: "Play again? (yes / no)" accepted only those words, the
// driver answered "n" thirteen times, the repeat cap closed stdin, and a
// correct game died on EOFError.

test("the offered tokens of a yes/no prompt are read in every common spelling", () => {
  assert.deepEqual(offeredChoiceTokens("Play again? (yes / no): "), ["yes", "no"]);
  assert.deepEqual(offeredChoiceTokens("Again? [Y/N] "), ["Y", "N"]);
  assert.deepEqual(offeredChoiceTokens("Continue? (y|n) "), ["y", "n"]);
  assert.deepEqual(offeredChoiceTokens("Please type one of: yes, no."), ["yes", "no"]);
  assert.deepEqual(offeredChoiceTokens("Enter yes or no: "), ["yes", "no"]);
  assert.deepEqual(offeredChoiceTokens("Play again? "), [], "nothing offered");
  assert.deepEqual(offeredChoiceTokens("Play again? (type your answer) "), [], "prose is not a token list");
  assert.deepEqual(offeredChoiceTokens("Continue? [1=yes, 2=no] "), [], "key=value pairs are not copied");
});

test("a strict yes/no play-again prompt gets the word it offers, verbatim", () => {
  const state = createCliDriverState();
  assert.equal(decideCliResponse(state, "Correct! You got it.\n\nPlay again? (yes / no): ", ""), "no");
  const rejected = "  Please type one of: yes, no.\n\nPlay again? (yes / no): ";
  assert.equal(decideCliResponse(state, rejected, ""), "no", "the re-ask names the tokens on the line before the prompt");
  assert.equal(decideCliResponse(createCliDriverState(), "Play again? [Y/N] ", ""), "N", "case copied from the offer");
  assert.equal(decideCliResponse(createCliDriverState(), "One more round? (y/n): ", ""), "n");
});

test("with nothing offered the decline ladder escalates and stays bounded", () => {
  const state = createCliDriverState();
  assert.equal(chooseDeclineAnswer(state, "Play again?"), "n");
  assert.equal(chooseDeclineAnswer(state, "Play again?"), "no");
  assert.equal(chooseDeclineAnswer(state, "Play again?"), "N");
  for (let index = 0; index < 20; index += 1) chooseDeclineAnswer(state, "Play again?");
  assert.equal(chooseDeclineAnswer(state, "Play again?"), "0", "the last rung repeats; the repeat cap ends the run");
  assert.equal(chooseDeclineAnswer(state, "Play again? (yes/no)"), "no", "an offer always wins over the ladder");
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

// --- the attempt-nine transcript, as a regression fixture ------------------
// The prompts below are quoted from the immutable campaign diagnostic
// docs/eval/qualification/2026-09-04/acceptable90-0f63c50-complete/
// code-delivery-attempt-9-driver-replay-0f63c50.json (a deterministic
// reconstruction of a removed generated program, not a rerun of it). The
// recorded driver answered "50" three times into silence, then "51" forever
// against a game whose numbers ran 1..10. The assertions below are about the
// property that failed -- an in-range guess inside the game's own budget --
// not about reproducing one program's output.

const ATTEMPT_NINE_STARTUP = [
  "",
  "",
  "",
  "What is your name? Choose a difficulty:\n1) Easy (1 to 10)\n2) Medium (1 to 50)\n3) Hard (1 to 100)\nDifficulty [1-3]: ",
  "Invalid choice. Please enter 1, 2, or 3.\nDifficulty [1-3]: ",
];

test("a difficulty menu's choice list is not mistaken for the game's range", () => {
  const state = createCliDriverState();
  let transcript = "";
  for (const pending of ATTEMPT_NINE_STARTUP) {
    transcript += pending;
    decideCliResponse(state, pending, transcript);
  }
  // "Difficulty [1-3]" is a list of options. Reading it as the answer range
  // would leave the driver unable to reach the number the game picked.
  assert.equal(state.announcedHigh, 100, "the widest offered range is the safe assumption");
  assert.equal(state.speculativeResponses, 3);
});

test("the attempt-nine game is solved in range and inside its four-guess budget", () => {
  for (let target = 1; target <= 10; target += 1) {
    const state = createCliDriverState();
    let transcript = "";
    for (const pending of ATTEMPT_NINE_STARTUP) {
      transcript += pending;
      const answer = decideCliResponse(state, pending, transcript);
      assert.notEqual(answer, null, "the driver must keep answering during startup");
    }

    let pending =
      "I picked a number between 1 and 10.\nYou have at most 4 guesses.\nGuess (4 left): ";
    let guesses = 0;
    let won = false;
    while (guesses < 8 && !won) {
      transcript += pending;
      const answer = decideCliResponse(state, pending, transcript);
      const value = Number.parseInt(String(answer), 10);
      assert.ok(
        Number.isInteger(value),
        `target ${target}: expected a numeric guess, got ${String(answer)}`,
      );
      assert.ok(
        value >= 1 && value <= 10,
        `target ${target}: guess ${value} is outside the range the game announced`,
      );
      guesses += 1;
      if (value === target) {
        won = true;
        break;
      }
      const left = 4 - guesses;
      pending = `${value > target ? "Too high!" : "Too low!"}\nGuess (${left} left): `;
    }
    assert.ok(won, `target ${target}: never guessed`);
    assert.ok(
      guesses <= 4,
      `target ${target}: needed ${guesses} guesses, the game allows 4`,
    );
  }
});

test("startup silence answers with a value that fits a name, a menu or a guess", () => {
  const state = createCliDriverState();
  assert.equal(decideCliResponse(state, "", ""), CLI_DRIVER_SPECULATIVE_ANSWER);
  assert.equal(state.speculativeResponses, 1);
  assert.equal(state.roundGuesses, 0, "silence is not a round");
});

test("a banner alone is answered as a guess, so coalescing a split prompt is the runner's job", () => {
  // This is the negative half of the chunked-prompt proof in
  // tests/interactiveCliDriverPrograms.test.ts: the decision function has no
  // way to know a question is still coming, so the quiet period that waits
  // for it is load-bearing, not incidental.
  const state = createCliDriverState();
  const banner = "Welcome to the Number Guessing Game!\n";
  assert.match(String(decideCliResponse(state, banner, banner)), /^\d+$/u);
});

test("impossible feedback ends the run instead of being answered forever", () => {
  const state = createCliDriverState();
  let pending = "I'm thinking of a number between 1 and 100.\nYour guess: ";
  let answers = 0;
  let last: string | null = "";
  while (answers < CLI_DRIVER_RESPONSE_CAP && last !== null) {
    last = decideCliResponse(state, pending, pending);
    if (last === null) break;
    answers += 1;
    // Every guess is "too low", including the top of the range.
    pending = "Too low!\nYour guess: ";
  }
  assert.equal(last, null, "the driver must stop answering a game it cannot win");
  assert.ok(answers < 60, `gave ${answers} answers before giving up`);
});
