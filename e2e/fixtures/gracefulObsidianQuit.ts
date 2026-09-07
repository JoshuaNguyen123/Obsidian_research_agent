/**
 * Ask the owned Obsidian to quit on its own before the harness kills it.
 *
 * Why: Obsidian keeps SecretStorage in Chromium DOMStorage, which the browser
 * process commits to disk on a delay; the plugin's data.json is written
 * straight through. `taskkill /F` inside that delay left data.json pointing at
 * a rotated Linear OAuth pair that never reached disk (2026-09-07, cohort 13
 * lost at its third lane). A normal shutdown commits DOMStorage first.
 *
 * How: `@electron/remote` is the main-process bridge Obsidian exposes to the
 * renderer; `app.quit()` through it closed the page in 28 ms when probed. The
 * call is deferred by a macrotask so the evaluate that requests it returns.
 * The teardown's own bounded wait decides whether the kill is still needed.
 */
export interface GracefulQuitPageLike {
  isClosed(): boolean;
  evaluate<R>(pageFunction: () => R): Promise<R>;
}

export type GracefulQuitOutcome =
  | "dispatched"
  | "unavailable"
  | "page_closed"
  | "failed";

export const GRACEFUL_QUIT_REQUEST_TIMEOUT_MS = 2_000;

export async function requestGracefulObsidianQuitV1(
  page: GracefulQuitPageLike | null,
  timeoutMs: number = GRACEFUL_QUIT_REQUEST_TIMEOUT_MS,
): Promise<GracefulQuitOutcome> {
  if (!page || page.isClosed()) return "page_closed";
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const delivered = await Promise.race([
      page.evaluate(() => {
        const bridge = (
          window as Window & { require?: (specifier: string) => unknown }
        ).require;
        if (typeof bridge !== "function") return false;
        type RemoteLike = { app?: { quit?: () => void } } | null | undefined;
        let remote: RemoteLike;
        try {
          remote = bridge("@electron/remote") as RemoteLike;
        } catch {
          return false;
        }
        const app = remote?.app;
        const quit = app?.quit;
        if (!app || typeof quit !== "function") return false;
        setTimeout(() => quit.call(app), 0);
        return true;
      }),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (delivered === "timeout") return "failed";
    return delivered ? "dispatched" : "unavailable";
  } catch {
    // A page that closed between the check and the evaluate, or an evaluate
    // torn down by the quit itself, both mean the request may have landed;
    // the caller's owned-exit wait is the only honest answer.
    return page.isClosed() ? "dispatched" : "failed";
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
