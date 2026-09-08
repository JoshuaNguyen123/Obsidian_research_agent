import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  runInteractiveCliProgram,
  type InteractiveCliRunResult,
} from "../e2e/fixtures/interactiveCliDriver";

/**
 * The same two-sided proof as tests/interactiveCliDriverPrograms.test.ts, on
 * the interpreter the delivery lane actually runs. Node child processes are
 * enough to pin the driver's logic and timing; Python is what pins the
 * assumptions the driver makes *about Python*: input() flushes its prompt
 * mid-line even when stdout is a pipe, a print() before a bare read does not,
 * and EOF on stdin raises EOFError with a traceback rather than exiting clean.
 *
 * These skip when python is not on PATH. The corpus next door never skips, so
 * a machine without python still runs the load-bearing half.
 */

const PY_DELAYED_MENU = `
import sys
import time

time.sleep(0.9)
name = input("Enter your name: ")
print("Hello, " + name + "!")
choice = input("Difficulty [easy/medium/hard]: ").strip().lower()
if choice in ("easy", "1"):
    low, high = 1, 10
elif choice in ("hard", "3"):
    low, high = 1, 1000
else:
    low, high = 1, 100
target = 7
print("I picked a number between {} and {}.".format(low, high))
attempts = 0
while attempts < 6:
    raw = input("Guess ({} left): ".format(6 - attempts))
    attempts += 1
    try:
        value = int(raw)
    except ValueError:
        print("That is not a number.")
        continue
    if value < low or value > high:
        print("Out of range.")
        continue
    if value > target:
        print("Too high!")
        continue
    if value < target:
        print("Too low!")
        continue
    print("Correct! You win in {} tries.".format(attempts))
    sys.exit(0)
print("Out of attempts! The number was {}.".format(target))
sys.exit(2)
`;

/**
 * The shape that ended cohort 2 on the real interpreter: input() validated
 * against a tuple of exact words, re-asking on anything else, and EOF on the
 * re-ask raises EOFError with exit 1.
 */
const PY_STRICT_YES_NO = `
import sys


def prompt_choice(prompt, choices):
    while True:
        raw = input(prompt).strip().lower()
        if raw in choices:
            return raw
        print("  Please type one of: " + ", ".join(choices) + ".")


print("NUMBER GUESSING GAME")
prompt_choice("Choose difficulty (easy / medium / hard): ", ("easy", "medium", "hard"))
print("I'm thinking of a number between 1 and 50.")
target = 46
attempts = 0
while attempts < 10:
    raw = input("Guess ({} left): ".format(10 - attempts))
    attempts += 1
    try:
        value = int(raw)
    except ValueError:
        print("Please enter a whole number.")
        continue
    if value > target:
        print("Too high!")
        continue
    if value < target:
        print("Too low!")
        continue
    print("Correct! You got it in {} attempt(s).".format(attempts))
    break
again = prompt_choice("\\nPlay again? (yes / no): ", ("yes", "no"))
if again == "yes":
    print("A second round was not requested.")
    sys.exit(3)
print("Thanks for playing!")
sys.exit(0)
`;

/** Correct game, but the prompt is a print() and the read is silent. */
const PY_SILENT_READ = `
import sys

print("Welcome to the Number Guessing Game!")
print("I picked a number between 1 and 100. Enter your guesses below.")
target = 42
attempts = 0
while attempts < 12:
    raw = sys.stdin.readline()
    if raw == "":
        print("No input.")
        sys.exit(3)
    attempts += 1
    try:
        value = int(raw.strip())
    except ValueError:
        continue
    if value > target:
        print("Too high!")
        continue
    if value < target:
        print("Too low!")
        continue
    print("Correct! You win in {} tries.".format(attempts))
    sys.exit(0)
print("Out of attempts! The number was {}.".format(target))
sys.exit(2)
`;

/** Broken: never accepts an answer, and dies on EOF the way Python does. */
const PY_NEVER_WINS = `
print("I picked a number between 1 and 100.")
while True:
    input("Your guess: ")
    print("Too low!")
`;

let workspace = "";
let pythonAvailable = false;

before(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "cli-driver-python-"));
  try {
    execFileSync("python", ["--version"], { timeout: 30_000, windowsHide: true });
    pythonAvailable = true;
  } catch {
    pythonAvailable = false;
  }
});

after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

async function playPython(
  name: string,
  source: string,
): Promise<InteractiveCliRunResult> {
  const file = path.join(workspace, `${name}.py`);
  await writeFile(file, source, "utf8");
  return runInteractiveCliProgram({
    command: "python",
    args: ["-X", "utf8", file],
    cwd: workspace,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    timeoutMs: 60_000,
  });
}

function describe(result: InteractiveCliRunResult): string {
  return JSON.stringify({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stopReason: result.stopReason,
    exchanges: result.exchanges,
    speculativeResponses: result.speculativeResponses,
    responses: result.responses,
    tail: result.stdout.trim().split(/\r?\n/u).slice(-4),
    stderr: result.stderr.trim().slice(0, 200),
  });
}

test("python: a slow start, a name, a difficulty menu and a 1-10 range are played to a win", async (t) => {
  if (!pythonAvailable) {
    t.skip("python is not on PATH");
    return;
  }
  const result = await playPython("delayed-menu", PY_DELAYED_MENU);
  assert.equal(result.timedOut, false, describe(result));
  assert.equal(result.exitCode, 0, describe(result));
  assert.match(result.stdout, /Correct! You win in \d+ tries\./u);
  assert.doesNotMatch(result.stdout, /Out of range\./u, describe(result));
  assert.ok(result.exchanges >= 3, describe(result));
});

test("python: a strict yes/no play-again prompt is declined in its own words", async (t) => {
  if (!pythonAvailable) {
    t.skip("python is not on PATH");
    return;
  }
  const result = await playPython("strict-yes-no", PY_STRICT_YES_NO);
  assert.equal(result.timedOut, false, describe(result));
  assert.equal(result.exitCode, 0, describe(result));
  assert.match(result.stdout, /Thanks for playing!/u, describe(result));
  assert.doesNotMatch(result.stdout, /Please type one of: yes, no/u, describe(result));
  assert.doesNotMatch(result.stderr, /EOFError/u, describe(result));
});

test("python: a printed prompt with a silent read is still answered", async (t) => {
  if (!pythonAvailable) {
    t.skip("python is not on PATH");
    return;
  }
  const result = await playPython("silent-read", PY_SILENT_READ);
  assert.equal(result.timedOut, false, describe(result));
  assert.equal(result.exitCode, 0, describe(result));
  assert.match(result.stdout, /Correct! You win in \d+ tries\./u);
});

test("python: a game that never accepts an answer is rejected with its own traceback", async (t) => {
  if (!pythonAvailable) {
    t.skip("python is not on PATH");
    return;
  }
  const result = await playPython("never-wins", PY_NEVER_WINS);
  assert.notEqual(result.exitCode, 0, describe(result));
  assert.equal(result.timedOut, false, describe(result));
  assert.doesNotMatch(result.stdout, /you win|correct/iu, describe(result));
  assert.match(result.stderr, /EOFError/u, describe(result));
  assert.ok(result.responses.length <= 60, describe(result));
});
