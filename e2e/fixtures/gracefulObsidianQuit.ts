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

/**
 * How long the DISPATCH may take, and nothing else. `app.quit()` only starts an
 * asynchronous shutdown — Electron still has to run before-quit and will-quit,
 * unload the renderer, and only then does the browser process commit
 * DOMStorage — so this bound says when to stop waiting for an ANSWER, never
 * when to stop waiting for the app to go. The exit budget is the caller's
 * owned-exit wait, and it starts here.
 */
export const GRACEFUL_QUIT_REQUEST_TIMEOUT_MS = 2_000;

/**
 * May the quit have reached the application?
 *
 * Only "unavailable" proves it did not: that outcome comes from a healthy
 * renderer answering, in full, that `@electron/remote` is not there to call.
 * Every other outcome is compatible with a quit that IS in flight. A renderer
 * being torn down by the very quit we asked for cannot answer the evaluate that
 * asked for it — a hung or throwing evaluate and a page that has already closed
 * are the NORMAL signatures of success, not failures.
 *
 * Reading them as failures is what let a caller treat the 2s dispatch bound as
 * the whole graceful budget and fire `taskkill /F` at ~2s, straight into
 * Chromium's delayed DOMStorage commit — the exact race that lost a rotated
 * Linear OAuth pair on 2026-09-07 and that this module exists to remove. The
 * caller's bounded owned-exit wait is the honest arbiter: it returns the moment
 * the root is actually gone, so waiting on a host that was never quitting costs
 * that bound once, while killing into a live shutdown costs the secret store.
 */
export function gracefulQuitMayHaveReachedAppV1(
  outcome: GracefulQuitOutcome,
): boolean {
  return outcome !== "unavailable";
}

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
