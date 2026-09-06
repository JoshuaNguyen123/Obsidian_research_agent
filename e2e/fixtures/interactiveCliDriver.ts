import { spawn } from "node:child_process";

/**
 * Adaptive stdin driver for a delivered command-line game.
 *
 * The code-delivery lane used to pipe a fixed script (the numbers 1..1000,
 * then "n"/"quit") into the generated program. A perfectly good game that
 * asks "Difficulty [easy/medium/hard]:" before its first guess consumed the
 * whole script as invalid choices and died on EOF, so the lane went red on
 * the harness's assumption, not on the product's work. This driver reads the
 * program's prompts and answers by content: menus get a menu answer, "play
 * again?" gets "n", and guess prompts get a bisection that follows the
 * game's own higher/lower feedback (falling back to counting up when the
 * game gives no feedback). Everything is bounded: a response cap, an output
 * cap, and a wall-clock deadline.
 *
 * Two states are kept apart, because conflating them cost a campaign attempt.
 *
 * 1. Startup and menu selection. The program has not said what game it is
 *    playing yet. An answer sent here is a guess about *what is being asked*
 *    -- possibly a name, possibly a difficulty, possibly nothing at all --
 *    and it is not a move in a round. It must not record a guess, freeze the
 *    range, or let unattributable feedback narrow the bounds.
 * 2. A confirmed round. The program has asked for a guess, and the driver has
 *    committed one. Its bisection now owns the bounds, and only the program's
 *    own higher/lower feedback moves them.
 *
 * The range comes from the program: the announcement is re-read on every
 * chunk until the program's feedback starts constraining the search, and a
 * finished round resets the bounds so a second round is played on the range
 * the program announced for it, not on the collapsed bounds that solved the
 * first one.
 */

export interface CliDriverState {
  low: number;
  high: number;
  lastGuess: number | null;
  feedbackSeen: boolean;
  guessesWithoutFeedback: number;
  menuAttempts: number;
  lastPrompt: string;
  repeats: number;
  responses: number;
  /** Next value to try once the driver has given up on feedback-driven bisection. */
  sequentialNext: number | null;
  /** The bisection value the sequential walk must skip. */
  bisectionTried: number | null;
  /** The range the program itself announced; survives a round transition. */
  announcedLow: number | null;
  announcedHigh: number | null;
  /** Guesses committed in the current round. Speculative answers are not guesses. */
  roundGuesses: number;
  /** Rounds the program has said were solved. */
  roundsWon: number;
  /** Answers sent while the program had printed nothing at all. */
  speculativeResponses: number;
  /** Times the program's own feedback collapsed the range to nothing. */
  contradictions: number;
}

export const CLI_DRIVER_RESPONSE_CAP = 300;
/** Identical prompts in a row before the driver stops answering. */
export const CLI_DRIVER_REPEAT_CAP = 12;
/** Impossible feedback tolerated before the driver calls the program broken. */
export const CLI_DRIVER_CONTRADICTION_CAP = 2;
/**
 * Answer for a program that has printed nothing at all. It has to be
 * plausible in every slot it might land in -- a name, the first item of a
 * numbered menu, or an in-range first guess -- because the driver cannot yet
 * know which one it is. The recorded attempt-nine transcript is the argument
 * against a mid-range number: its "50" was read as a name, then as an invalid
 * difficulty, and the range it implied was wrong for the game that followed.
 */
export const CLI_DRIVER_SPECULATIVE_ANSWER = "1";

const DEFAULT_LOW = 1;
const DEFAULT_HIGH = 100;
const MENU_ANSWERS = ["easy", "1", "e", "medium", "2", "normal"];

export function createCliDriverState(): CliDriverState {
  return {
    low: DEFAULT_LOW,
    high: DEFAULT_HIGH,
    lastGuess: null,
    feedbackSeen: false,
    guessesWithoutFeedback: 0,
    menuAttempts: 0,
    lastPrompt: "",
    repeats: 0,
    responses: 0,
    sequentialNext: null,
    bisectionTried: null,
    announcedLow: null,
    announcedHigh: null,
    roundGuesses: 0,
    roundsWon: 0,
    speculativeResponses: 0,
    contradictions: 0,
  };
}

const AGAIN_RE =
  /play again|again\?|another (?:round|game|go)|one more|continue\?|\(y\/n\)|\[y\/n\]|yes\/no|y\/n/u;
const NAME_RE = /\bname\b/u;
const NUMBER_WORD_RE = /number|guess|digit/u;
const MENU_RE =
  /difficulty|level|easy|medium|hard|choose (?:an? )?(?:option|mode)|select (?:an? )?(?:option|mode)|\bmenu\b|\bmode\b/u;
const GUESS_PROMPT_RE = /guess|enter (?:a |your )?number|pick a number|your number|try\b/u;
const TOO_HIGH_RE = /too high|too big|too large|\blower\b|\bsmaller\b|\bless\b|go down/u;
const TOO_LOW_RE = /too low|too small|\bhigher\b|\bbigger\b|\bgreater\b|\blarger\b|\bmore\b|go up/u;
const WON_RE = /correct|congrat|you won|you win|well done|got it|you guessed/u;
// "between 1 and 10" is the game telling the driver its range. A bare "1-10"
// is weaker evidence and only used when no explicit announcement is present,
// because "Difficulty [1-3]" is a list of choices, not a range of answers.
const RANGE_BETWEEN_RE = /\bbetween\s+(\d{1,6})\s+and\s+(\d{1,6})/gu;
const RANGE_LOOSE_RE = /(\[)?(\d{1,6})\s*(?:-|to)\s*(\d{1,6})(\])?/gu;

function candidateRanges(chunk: string): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  const push = (low: number, high: number): void => {
    if (
      Number.isSafeInteger(low) &&
      Number.isSafeInteger(high) &&
      low < high &&
      high <= 1_000_000
    ) {
      found.push([low, high]);
    }
  };
  let match: RegExpExecArray | null;
  RANGE_BETWEEN_RE.lastIndex = 0;
  while ((match = RANGE_BETWEEN_RE.exec(chunk)) !== null) {
    push(Number(match[1]), Number(match[2]));
  }
  if (found.length > 0) return found;
  RANGE_LOOSE_RE.lastIndex = 0;
  while ((match = RANGE_LOOSE_RE.exec(chunk)) !== null) {
    if (match[1] === "[" && match[4] === "]") continue;
    push(Number(match[2]), Number(match[3]));
  }
  return found;
}

function learnRange(state: CliDriverState, chunk: string): void {
  // Once the program's own higher/lower feedback has moved the bounds they are
  // the driver's deductions, and a "3 to 5" in a status line must not widen
  // them again. Until then every chunk may still name the real range: a
  // difficulty menu is chosen before the game announces what was selected.
  if (state.feedbackSeen) return;
  const candidates = candidateRanges(chunk);
  if (candidates.length === 0) return;
  // A chunk offering several ranges is a menu the driver has not answered yet
  // ("1) Easy (1 to 10) ... 3) Hard (1 to 100)"). Take the widest so no valid
  // answer is excluded; the game's own announcement replaces it a chunk later.
  let chosen = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate[1] - candidate[0] > chosen[1] - chosen[0]) chosen = candidate;
  }
  state.announcedLow = chosen[0];
  state.announcedHigh = chosen[1];
  state.low = chosen[0];
  state.high = chosen[1];
  state.sequentialNext = null;
  state.bisectionTried = null;
}

/** Begin a fresh round on the announced range, forgetting the solved one. */
function startNewRound(state: CliDriverState): void {
  state.low = state.announcedLow ?? DEFAULT_LOW;
  state.high = state.announcedHigh ?? DEFAULT_HIGH;
  state.lastGuess = null;
  state.feedbackSeen = false;
  state.guessesWithoutFeedback = 0;
  state.sequentialNext = null;
  state.bisectionTried = null;
  state.roundGuesses = 0;
}

/**
 * Decide the next stdin line for the program. `pending` is everything the
 * program printed since the last response; `transcript` is all of its
 * stdout so far. Returns null when the driver should close stdin instead.
 */
export function decideCliResponse(
  state: CliDriverState,
  pending: string,
  transcript: string,
): string | null {
  if (state.responses >= CLI_DRIVER_RESPONSE_CAP) return null;
  const text = pending.toLowerCase();
  const prompt = pending.trim();
  // The question being asked is the last non-empty line; earlier lines are
  // banners and feedback ("Welcome to the Number Guessing Game!" must not
  // make a difficulty prompt look like a guess prompt).
  const lines = prompt.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const lastLine = (lines[lines.length - 1] ?? "").toLowerCase();
  state.repeats = prompt === state.lastPrompt ? state.repeats + 1 : 0;
  state.lastPrompt = prompt;
  state.responses += 1;

  // The same prompt over and over means the program wanted something the
  // driver cannot supply. Closing stdin ends the run instead of feeding it.
  if (state.repeats >= CLI_DRIVER_REPEAT_CAP) return null;

  // Startup silence: the program has printed nothing, so nothing is known
  // about it. This answer is speculative -- it may be read as a name, a menu
  // choice, or a guess -- and it must leave the gameplay state untouched, or
  // a program that announces "between 1 and 1000" a moment later is played
  // on the range the silence invented.
  if (prompt === "" && transcript.trim() === "") {
    state.speculativeResponses += 1;
    return CLI_DRIVER_SPECULATIVE_ANSWER;
  }

  // Feedback is only attributable to a guess the driver actually committed.
  if (state.lastGuess !== null) {
    if (TOO_HIGH_RE.test(text)) {
      state.high = Math.min(state.high, state.lastGuess - 1);
      state.feedbackSeen = true;
      state.guessesWithoutFeedback = 0;
    } else if (TOO_LOW_RE.test(text)) {
      state.low = Math.max(state.low, state.lastGuess + 1);
      state.feedbackSeen = true;
      state.guessesWithoutFeedback = 0;
    } else {
      state.guessesWithoutFeedback += 1;
    }
  }

  // A solved round is the one supported reset point: bounds that identify the
  // previous answer are worthless for the next one. A win claimed before the
  // driver ever guessed is a rules banner, not a round.
  const roundEnded = state.roundGuesses > 0 && WON_RE.test(text);
  if (roundEnded) {
    state.roundsWon += 1;
    startNewRound(state);
  }

  learnRange(state, text);

  if (AGAIN_RE.test(lastLine)) return "n";
  if (NAME_RE.test(lastLine) && !NUMBER_WORD_RE.test(lastLine)) return "Player";

  const menuLike = MENU_RE.test(lastLine) && !GUESS_PROMPT_RE.test(lastLine);
  if (menuLike) {
    if (state.menuAttempts >= MENU_ANSWERS.length * 2) return null;
    const answer = MENU_ANSWERS[state.menuAttempts % MENU_ANSWERS.length]!;
    state.menuAttempts += 1;
    return answer;
  }

  // A win with no question attached: the game may still be reading one more
  // line (a "press enter" or an unlabelled play-again). "n" is harmless.
  if (roundEnded && !GUESS_PROMPT_RE.test(lastLine)) return "n";

  if (state.low > state.high) {
    // The program's own feedback ruled out every value it offered. Give it a
    // bounded second chance on the announced range, then stop: a game that
    // cannot be won is a result, not something to keep answering.
    state.contradictions += 1;
    if (state.contradictions > CLI_DRIVER_CONTRADICTION_CAP) return null;
    state.low = state.announcedLow ?? DEFAULT_LOW;
    state.high = state.announcedHigh ?? DEFAULT_HIGH;
    state.feedbackSeen = false;
    state.guessesWithoutFeedback = 0;
    state.sequentialNext = null;
    state.bisectionTried = null;
  }

  let guess: number;
  if (!state.feedbackSeen && state.guessesWithoutFeedback >= 3) {
    // No higher/lower feedback at all: walk the range from the bottom,
    // skipping the one value bisection already tried (repeatedly).
    if (state.sequentialNext === null) {
      state.sequentialNext = state.low;
      state.bisectionTried = state.lastGuess;
    }
    while (state.sequentialNext === state.bisectionTried) state.sequentialNext += 1;
    // Walking past the top of the range would only send answers the program
    // already said were invalid.
    if (state.sequentialNext > state.high) return null;
    guess = state.sequentialNext;
    state.sequentialNext += 1;
  } else {
    guess = Math.floor((state.low + state.high) / 2);
  }
  state.lastGuess = guess;
  state.roundGuesses += 1;
  return String(guess);
}

export interface InteractiveCliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  responses: string[];
  /**
   * Times the program printed something new after the driver answered it.
   * Zero means the program never read a line the driver wrote, so nothing it
   * printed is evidence that it is interactive at all.
   */
  exchanges: number;
  /** Answers sent while the program had printed nothing at all. */
  speculativeResponses: number;
  stopReason: "exit" | "timeout" | "output_limit" | "spawn_error";
}

/** Quiet periods, in milliseconds, that decide when the program is waiting. */
export interface InteractiveCliTiming {
  /** Silence tolerated before answering a program that has printed nothing. */
  startupQuietMs: number;
  /** Quiet period after output that stops mid-line: a prompt is waiting. */
  promptQuietMs: number;
  /** Quiet period after output that ends with a newline: more may follow. */
  lineQuietMs: number;
  /** Quiet period after the driver answers and the program prints nothing. */
  silentReadMs: number;
}

/**
 * Startup dominates these numbers: a cold Python interpreter on Windows can
 * take seconds to reach its first prompt, and answering before it does puts a
 * line in the pipe that the program's first real question then eats. Output
 * that ends with a newline gets a long quiet period because a banner and the
 * question after it are often two writes; output that stops mid-line is a
 * prompt (Python's input() flushes without a newline) and answers quickly.
 */
export const CLI_DRIVER_TIMING: InteractiveCliTiming = {
  startupQuietMs: 4_000,
  promptQuietMs: 250,
  lineQuietMs: 900,
  silentReadMs: 1_200,
};

const OUTPUT_CAP = 500_000;
const STDERR_CAP = 100_000;

/**
 * Run a program and drive its stdin adaptively until it exits, the deadline
 * passes, or the driver gives up. Prompts are detected by a short quiet
 * period after output (Python's input() flushes its prompt even when piped);
 * a program that reads without printing still gets an answer after a longer
 * quiet period, so a silent prompt cannot hang the run.
 */
export function runInteractiveCliProgram(options: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  timing?: Partial<InteractiveCliTiming>;
}): Promise<InteractiveCliRunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timing: InteractiveCliTiming = { ...CLI_DRIVER_TIMING, ...options.timing };
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      // Prompt detection needs the program's output promptly; Python
      // block-buffers stdout on a pipe unless told otherwise (input() flushes,
      // a bare print() before sys.stdin.readline() does not).
      env: { ...(options.env ?? process.env), PYTHONUNBUFFERED: "1" },
    });
    const state = createCliDriverState();
    const responses: string[] = [];
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let closed = false;
    let exchanges = 0;
    let answeredBeforeOutput = 0;
    let stopReason: InteractiveCliRunResult["stopReason"] = "exit";
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (exitCode: number | null, extraStderr = "") => {
      if (closed) return;
      closed = true;
      if (idleTimer !== null) clearTimeout(idleTimer);
      clearTimeout(deadline);
      resolve({
        stdout,
        stderr: extraStderr ? `${stderr}\n${extraStderr}` : stderr,
        exitCode,
        timedOut,
        responses,
        exchanges,
        speculativeResponses: state.speculativeResponses,
        stopReason,
      });
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      stopReason = "timeout";
      child.kill("SIGKILL");
    }, timeoutMs);

    const respond = () => {
      idleTimer = null;
      if (closed || child.stdin.destroyed || !child.stdin.writable) return;
      const answer = decideCliResponse(state, pending, stdout);
      pending = "";
      if (answer === null) {
        child.stdin.end();
        return;
      }
      responses.push(answer);
      child.stdin.write(`${answer}\n`);
      // A program that reads its next line without printing anything still
      // gets an answer; otherwise the next prompt reschedules sooner.
      schedule(timing.silentReadMs);
    };
    const schedule = (ms: number) => {
      if (closed) return;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(respond, ms);
    };

    child.stdin.on("error", () => {
      // EPIPE after the program exited: nothing left to answer.
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      pending += chunk;
      if (responses.length > answeredBeforeOutput) {
        exchanges += 1;
        answeredBeforeOutput = responses.length;
      }
      if (stdout.length > OUTPUT_CAP) {
        stopReason = "output_limit";
        child.kill("SIGKILL");
        return;
      }
      // Output that stops mid-line is a prompt waiting for an answer. Output
      // that ends with a newline may be a banner with its question still to
      // come, so wait long enough for the rest of the turn to arrive.
      schedule(/\n[ \t]*$/u.test(pending) ? timing.lineQuietMs : timing.promptQuietMs);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > STDERR_CAP) {
        stopReason = "output_limit";
        child.kill("SIGKILL");
      }
    });
    child.on("error", (error) => {
      stopReason = "spawn_error";
      finish(null, String(error));
    });
    child.on("close", (code) => finish(code));
    schedule(timing.startupQuietMs);
  });
}
