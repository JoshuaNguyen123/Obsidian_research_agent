// Smoke the adaptive CLI driver against a real Python program:
//   npx tsx scripts/smoke-interactive-cli-driver.ts <path-to-game.py> [more.py ...]
// Prints the exit code, whether the deadline fired, the answers the driver
// gave, and the program's last output lines. Exits non-zero if any program
// exited red or timed out.
import { runInteractiveCliProgram } from "../e2e/fixtures/interactiveCliDriver";
import path from "node:path";

async function main(): Promise<number> {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("usage: smoke-interactive-cli-driver.ts <game.py> [...]");
    return 2;
  }
  let failures = 0;
  for (const target of targets) {
    const entryPoint = path.resolve(target);
    const startedAt = Date.now();
    const result = await runInteractiveCliProgram({
      command: "python",
      args: ["-X", "utf8", entryPoint],
      cwd: path.dirname(entryPoint),
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      timeoutMs: 30_000,
    });
    const ok = result.exitCode === 0 && !result.timedOut;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "OK " : "RED"} ${path.basename(entryPoint)} exit=${result.exitCode} timedOut=${result.timedOut} responses=${result.responses.length} ms=${Date.now() - startedAt}`,
    );
    console.log(`  answers: ${result.responses.join(" ")}`);
    console.log(`  tail: ${result.stdout.trim().split(/\r?\n/u).slice(-3).join(" | ")}`);
    if (result.stderr.trim()) console.log(`  stderr: ${result.stderr.trim().slice(0, 300)}`);
  }
  return failures === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
