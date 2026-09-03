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
}

export const CLI_DRIVER_RESPONSE_CAP = 300;

const MENU_ANSWERS = ["easy", "1", "e", "medium", "2", "normal"];

export function createCliDriverState(): CliDriverState {
  return {
    low: 1,
    high: 100,
    lastGuess: null,
    feedbackSeen: false,
    guessesWithoutFeedback: 0,
    menuAttempts: 0,
    lastPrompt: "",
    repeats: 0,
    responses: 0,
    sequentialNext: null,
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
const RANGE_RE = /between\s+(\d{1,6})\s+and\s+(\d{1,6})|(\d{1,6})\s*(?:-|to)\s*(\d{1,6})/gu;

function learnRange(state: CliDriverState, transcript: string): void {
  if (state.lastGuess !== null) return;
  let match: RegExpExecArray | null;
  let found: [number, number] | null = null;
  RANGE_RE.lastIndex = 0;
  while ((match = RANGE_RE.exec(transcript)) !== null) {
    const lo = Number(match[1] ?? match[3]);
    const hi = Number(match[2] ?? match[4]);
    if (Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && lo < hi && hi <= 1_000_000) {
      found = [lo, hi];
    }
  }
  if (found) {
    state.low = found[0];
    state.high = found[1];
  }
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

  if (AGAIN_RE.test(lastLine)) return "n";
  if (NAME_RE.test(lastLine) && !NUMBER_WORD_RE.test(lastLine)) return "Player";

  const menuLike = MENU_RE.test(lastLine) && !GUESS_PROMPT_RE.test(lastLine);
  if (menuLike) {
    if (state.menuAttempts >= MENU_ANSWERS.length * 2) return null;
    const answer = MENU_ANSWERS[state.menuAttempts % MENU_ANSWERS.length];
    state.menuAttempts += 1;
    return answer;
  }

  learnRange(state, transcript.toLowerCase());

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

  // A win with no question attached: the game may still be reading one more
  // line (a "press enter" or an unlabelled play-again). "n" is harmless.
  if (WON_RE.test(text) && !GUESS_PROMPT_RE.test(lastLine)) return "n";

  // The same guess prompt repeating without feedback usually means the
  // program wanted something else on that line; after a few tries, bow out.
  if (state.repeats >= 12) return null;

  let guess: number;
  if (!state.feedbackSeen && state.guessesWithoutFeedback >= 3) {
    // No higher/lower feedback at all: walk the range from the bottom,
    // skipping the value bisection already tried.
    if (state.sequentialNext === null) state.sequentialNext = state.low;
    while (state.sequentialNext === state.lastGuess) state.sequentialNext += 1;
    guess = state.sequentialNext;
    state.sequentialNext += 1;
  } else {
    if (state.low > state.high) {
      state.low = 1;
      state.high = 1000;
    }
    guess = Math.floor((state.low + state.high) / 2);
  }
  state.lastGuess = guess;
  return String(guess);
}

export interface InteractiveCliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  responses: string[];
}

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
}): Promise<InteractiveCliRunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
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
      });
    };
    const deadline = setTimeout(() => {
      timedOut = true;
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
      schedule(600);
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
      if (stdout.length > 500_000) {
        child.kill("SIGKILL");
        return;
      }
      schedule(80);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 100_000) child.kill("SIGKILL");
    });
    child.on("error", (error) => finish(null, String(error)));
    child.on("close", (code) => finish(code));
    schedule(600);
  });
}
