import assert from "node:assert/strict";
import test from "node:test";

import { ApprovalBroker } from "../src/agent/approvalBroker";
import { normalizeAgentSettings } from "../src/agent/settingsNormalize";
import {
  approvalNotificationV1,
  raiseDesktopNotificationV1,
  type NotificationConstructorLikeV1,
} from "../src/ui/desktopNotifications";

/**
 * A Notice is drawn inside the Obsidian window, so a user in another app never
 * saw the "mission done" toast meant for them, and nothing at all told them an
 * approval card had started a two-minute clock.
 */

function fakeNotification(permission: "granted" | "denied" | "default", grantOnRequest = true) {
  const raised: { title: string; body?: string; tag?: string }[] = [];
  let requested = 0;
  class Fake {
    static permission = permission;
    static async requestPermission() {
      requested += 1;
      Fake.permission = grantOnRequest ? "granted" : "denied";
      return Fake.permission;
    }
    onclick: ((this: unknown, event: unknown) => unknown) | null = null;
    constructor(title: string, options?: { body?: string; tag?: string }) {
      raised.push({ title, body: options?.body, tag: options?.tag });
    }
    close() {}
  }
  return {
    Ctor: Fake as unknown as NotificationConstructorLikeV1,
    raised,
    requested: () => requested,
  };
}

const input = { title: "Agentic Researcher", body: "Mission done: appended 2 sections", tag: "t" };

test("an unfocused window with the setting on gets a system notification", async () => {
  const fake = fakeNotification("granted");
  const outcome = await raiseDesktopNotificationV1(input, {
    enabled: true,
    windowFocused: false,
    Notification: fake.Ctor,
  });
  assert.equal(outcome, "raised");
  assert.deepEqual(fake.raised, [{ title: "Agentic Researcher", body: input.body, tag: "t" }]);
});

test("a focused window, a disabled setting, or a missing API raises nothing", async () => {
  const fake = fakeNotification("granted");
  assert.equal(
    await raiseDesktopNotificationV1(input, { enabled: true, windowFocused: true, Notification: fake.Ctor }),
    "window_focused",
  );
  assert.equal(
    await raiseDesktopNotificationV1(input, { enabled: false, windowFocused: false, Notification: fake.Ctor }),
    "disabled",
  );
  assert.equal(
    await raiseDesktopNotificationV1(input, { enabled: true, windowFocused: false, Notification: null }),
    "unavailable",
  );
  assert.equal(fake.raised.length, 0);
});

test("permission is asked for once when undecided and respected when refused", async () => {
  const asks = fakeNotification("default", true);
  assert.equal(
    await raiseDesktopNotificationV1(input, { enabled: true, windowFocused: false, Notification: asks.Ctor }),
    "raised",
  );
  assert.equal(asks.requested(), 1);

  const refuses = fakeNotification("default", false);
  assert.equal(
    await raiseDesktopNotificationV1(input, { enabled: true, windowFocused: false, Notification: refuses.Ctor }),
    "denied",
  );
  assert.equal(refuses.raised.length, 0);
});

test("the approval notification names the action and the time left before the run parks", () => {
  const note = approvalNotificationV1({
    toolName: "linear_create_issue",
    action: "Create Linear issue",
    expiresAtMs: 120_000,
    nowMs: 0,
  });
  assert.equal(note.title, "Agentic Researcher needs your approval");
  assert.match(note.body, /Create Linear issue is waiting/u);
  assert.match(note.body, /parks itself in 2 minutes/u);
});

test("the broker tells an observer about every waiting approval, and an observer cannot break it", async () => {
  const broker = new ApprovalBroker();
  const seen: string[] = [];
  const stop = broker.observe((request) => seen.push(request.toolName));
  broker.observe(() => {
    throw new Error("a broken observer must not affect the decision");
  });
  const request = {
    runId: "run-1",
    toolName: "linear_create_issue",
    action: "Create Linear issue",
    reason: "external write",
    policyTags: [],
  };
  const pending = broker.request(request as never, { timeoutMs: 50 });
  assert.deepEqual(seen, ["linear_create_issue"]);
  assert.equal(await pending, "expired");

  stop();
  await broker.request(request as never, { timeoutMs: 10 });
  assert.equal(seen.length, 1, "an unsubscribed observer hears nothing");
});

test("notifications default on, and an explicit off survives normalization", () => {
  assert.equal(normalizeAgentSettings({}, "new_install").desktopNotificationsEnabled, true);
  assert.equal(
    normalizeAgentSettings({ desktopNotificationsEnabled: false }, "existing_install")
      .desktopNotificationsEnabled,
    false,
  );
});
