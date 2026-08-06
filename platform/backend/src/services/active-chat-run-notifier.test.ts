import { vi } from "vitest";
import { afterEach, beforeEach, expect, test } from "@/test";

const originalEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  process.env.ARCHESTRA_DATABASE_URL =
    "postgresql://user:pass@localhost:5432/db";
});

afterEach(() => {
  process.env = originalEnv;
});

test("an event notification wakes only the run it names", async () => {
  const { InMemoryActiveChatRunNotifier } = await import(
    "./active-chat-run-notifier"
  );
  const notifier = new InMemoryActiveChatRunNotifier();

  let otherWoken = false;
  const other = notifier
    .waitForEvent({ runId: "run-2", timeoutMs: 150 })
    .then(() => {
      otherWoken = true;
    });
  const target = notifier.waitForEvent({ runId: "run-1", timeoutMs: 60_000 });

  await notifier.notifyEvent("run-1");
  await target;

  expect(otherWoken).toBe(false);
  await other;
});

test("stop and event notifications do not cross", async () => {
  const { InMemoryActiveChatRunNotifier } = await import(
    "./active-chat-run-notifier"
  );
  const notifier = new InMemoryActiveChatRunNotifier();

  // Same run id on both channels: a stop must not be mistaken for an event.
  let eventWoken = false;
  const event = notifier
    .waitForEvent({ runId: "run-1", timeoutMs: 150 })
    .then(() => {
      eventWoken = true;
    });
  const stop = notifier.waitForStop({ runId: "run-1", timeoutMs: 60_000 });

  await notifier.notifyStop("run-1");
  await stop;

  expect(eventWoken).toBe(false);
  await event;
});

test("a wait still ends on its timeout when nothing is notified", async () => {
  // Notifications are not durable, so this is what keeps a stream correct when
  // one is missed.
  const { InMemoryActiveChatRunNotifier } = await import(
    "./active-chat-run-notifier"
  );
  const notifier = new InMemoryActiveChatRunNotifier();

  await expect(
    notifier.waitForEvent({ runId: "run-1", timeoutMs: 10 }),
  ).resolves.toBeUndefined();
});

test("an aborted wait returns without waiting out the timeout", async () => {
  const { InMemoryActiveChatRunNotifier } = await import(
    "./active-chat-run-notifier"
  );
  const notifier = new InMemoryActiveChatRunNotifier();
  const controller = new AbortController();

  const waiting = notifier.waitForStop({
    runId: "run-1",
    timeoutMs: 60_000,
    abortSignal: controller.signal,
  });
  controller.abort();

  await expect(waiting).resolves.toBeUndefined();
});

test("the polling notifier never wakes early, only on the timeout", async () => {
  const { PollingActiveChatRunNotifier } = await import(
    "./active-chat-run-notifier"
  );
  const notifier = new PollingActiveChatRunNotifier();

  let woken = false;
  const waiting = notifier
    .waitForEvent({ runId: "run-1", timeoutMs: 120 })
    .then(() => {
      woken = true;
    });

  await notifier.notifyEvent("run-1");
  expect(woken).toBe(false);

  await waiting;
  expect(woken).toBe(true);
});

test("createActiveChatRunNotifier opens a listener by default", async () => {
  delete process.env.ARCHESTRA_CHAT_ACTIVE_RUN_POLLING_COMPATIBILITY_ENABLED;

  const { createActiveChatRunNotifier, PollingActiveChatRunNotifier } =
    await import("./active-chat-run-notifier");

  const notifier = createActiveChatRunNotifier();

  expect(notifier).not.toBeInstanceOf(PollingActiveChatRunNotifier);
  await notifier.close?.();
});

test("createActiveChatRunNotifier skips the listener in compatibility mode", async () => {
  process.env.ARCHESTRA_CHAT_ACTIVE_RUN_POLLING_COMPATIBILITY_ENABLED = "true";

  const { createActiveChatRunNotifier, PollingActiveChatRunNotifier } =
    await import("./active-chat-run-notifier");

  expect(createActiveChatRunNotifier()).toBeInstanceOf(
    PollingActiveChatRunNotifier,
  );
});
