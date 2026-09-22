/**
 * System notifications for the two moments a user who walked away needs to
 * know about: an approval card is waiting, and a mission settled.
 *
 * The hands-off wave raised an Obsidian `Notice` for a finished mission when
 * the pane was hidden or the window unfocused. A Notice is drawn inside the
 * Obsidian window, so in exactly the case it was for (the user is in another
 * app) nobody saw it. Worse, an approval card waits `approvalTimeoutMs`
 * (default two minutes) and then parks the run; nothing told an absent user
 * the clock had started.
 *
 * Rules:
 * - Only when the Obsidian window is not focused. A focused user already sees
 *   the card or the completion row, and a second channel is noise.
 * - Never for a user who turned the setting off.
 * - Content is built by the caller from recorded facts (tool name, receipts,
 *   stop reason), never model prose, so a notification cannot carry text a
 *   page or a model put there.
 * - Failure is silent: a notification is a courtesy, never a dependency.
 */

export type DesktopNotificationOutcomeV1 =
  | "raised"
  | "disabled"
  | "window_focused"
  | "unavailable"
  | "denied";

export interface DesktopNotificationInputV1 {
  title: string;
  body: string;
  /** Replaces an earlier notification with the same tag instead of stacking. */
  tag: string;
}

interface NotificationLike {
  onclick: ((this: unknown, event: unknown) => unknown) | null;
  close(): void;
}

export interface NotificationConstructorLikeV1 {
  new (title: string, options?: { body?: string; tag?: string; silent?: boolean }): NotificationLike;
  permission: "granted" | "denied" | "default";
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
}

export interface DesktopNotificationEnvV1 {
  enabled: boolean;
  windowFocused: boolean;
  /** Defaults to the renderer's global `Notification`. */
  Notification?: NotificationConstructorLikeV1 | null;
  /** Called when the user clicks the notification. */
  onClick?: () => void;
}

const MAX_BODY_CHARS = 180;

export async function raiseDesktopNotificationV1(
  input: DesktopNotificationInputV1,
  env: DesktopNotificationEnvV1,
): Promise<DesktopNotificationOutcomeV1> {
  if (!env.enabled) return "disabled";
  if (env.windowFocused) return "window_focused";
  const Ctor =
    env.Notification === undefined
      ? ((globalThis as { Notification?: NotificationConstructorLikeV1 }).Notification ?? null)
      : env.Notification;
  if (!Ctor) return "unavailable";
  try {
    let permission = Ctor.permission;
    if (permission === "default" && typeof Ctor.requestPermission === "function") {
      permission = await Ctor.requestPermission();
    }
    if (permission !== "granted") return "denied";
    const notification = new Ctor(input.title, {
      body: boundBody(input.body),
      tag: input.tag,
    });
    notification.onclick = () => {
      env.onClick?.();
      notification.close();
    };
    return "raised";
  } catch {
    return "unavailable";
  }
}

/** The window's focus as the renderer reports it; unknown counts as focused. */
export function isWindowFocusedV1(): boolean {
  return typeof document !== "undefined" && typeof document.hasFocus === "function"
    ? document.hasFocus()
    : true;
}

/** Title and body for a waiting approval card, from the request's own fields. */
export function approvalNotificationV1(input: {
  toolName: string;
  action: string;
  expiresAtMs: number;
  nowMs: number;
}): DesktopNotificationInputV1 {
  const seconds = Math.max(0, Math.round((input.expiresAtMs - input.nowMs) / 1000));
  const wait =
    seconds >= 90 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`;
  return {
    title: "Agentic Researcher needs your approval",
    body: `${input.action || input.toolName} is waiting. The run parks itself in ${wait} if nobody answers.`,
    tag: "agentic-researcher-approval",
  };
}

function boundBody(body: string): string {
  const flat = body.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_BODY_CHARS ? `${flat.slice(0, MAX_BODY_CHARS - 1)}…` : flat;
}
