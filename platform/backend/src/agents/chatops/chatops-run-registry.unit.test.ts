import { describe, expect, test } from "vitest";
import { chatOpsRunRegistry } from "./chatops-run-registry";

const SLACK_THREAD = {
  provider: "slack",
  channelId: "C123",
  threadId: "1700000000.0001",
} as const;

describe("chatOpsRunRegistry", () => {
  test("cancelThread aborts every run registered for the thread", () => {
    const a = chatOpsRunRegistry.register(SLACK_THREAD);
    const b = chatOpsRunRegistry.register(SLACK_THREAD);

    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);

    const aborted = chatOpsRunRegistry.cancelThread(SLACK_THREAD);

    expect(aborted).toBe(2);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);

    a.unregister();
    b.unregister();
  });

  test("cancelThread only touches the matching thread", () => {
    const target = chatOpsRunRegistry.register(SLACK_THREAD);
    const other = chatOpsRunRegistry.register({
      ...SLACK_THREAD,
      threadId: "1700000000.9999",
    });

    chatOpsRunRegistry.cancelThread(SLACK_THREAD);

    expect(target.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);

    target.unregister();
    other.unregister();
  });

  test("the same thread key across providers is isolated", () => {
    const slack = chatOpsRunRegistry.register(SLACK_THREAD);
    const teams = chatOpsRunRegistry.register({
      ...SLACK_THREAD,
      provider: "ms-teams",
    });

    chatOpsRunRegistry.cancelThread(SLACK_THREAD);

    expect(slack.signal.aborted).toBe(true);
    expect(teams.signal.aborted).toBe(false);

    slack.unregister();
    teams.unregister();
  });

  test("an unregistered run is no longer cancellable", () => {
    const run = chatOpsRunRegistry.register(SLACK_THREAD);
    run.unregister();

    expect(chatOpsRunRegistry.cancelThread(SLACK_THREAD)).toBe(0);
    expect(run.signal.aborted).toBe(false);
  });

  test("cancelThread with no runs registered is a no-op", () => {
    expect(
      chatOpsRunRegistry.cancelThread({
        provider: "slack",
        channelId: "C-empty",
        threadId: "never-ran",
      }),
    ).toBe(0);
  });

  test("cancelThread does not double-count an already-aborted run", () => {
    const run = chatOpsRunRegistry.register(SLACK_THREAD);

    expect(chatOpsRunRegistry.cancelThread(SLACK_THREAD)).toBe(1);
    // A second mute of the same thread finds the run already aborted.
    expect(chatOpsRunRegistry.cancelThread(SLACK_THREAD)).toBe(0);

    run.unregister();
  });
});

describe("chatOpsRunRegistry supersede", () => {
  const TG_THREAD = {
    provider: "telegram",
    channelId: "1399696",
    threadId: "1399696",
  } as const;

  test("a newer same-sender run aborts the older one", () => {
    const older = chatOpsRunRegistry.register(TG_THREAD, {
      supersede: { senderId: "u1", sequence: 100 },
    });
    const newer = chatOpsRunRegistry.register(TG_THREAD, {
      supersede: { senderId: "u1", sequence: 101 },
    });

    expect(older.signal.aborted).toBe(true);
    expect(newer.signal.aborted).toBe(false);

    older.unregister();
    newer.unregister();
  });

  test("a stale run registering after a newer one is aborted immediately", () => {
    // Concurrent dispatch can invert registration order; the sequence decides.
    const newer = chatOpsRunRegistry.register(TG_THREAD, {
      supersede: { senderId: "u1", sequence: 101 },
    });
    const stale = chatOpsRunRegistry.register(TG_THREAD, {
      supersede: { senderId: "u1", sequence: 100 },
    });

    expect(newer.signal.aborted).toBe(false);
    expect(stale.signal.aborted).toBe(true);

    newer.unregister();
    stale.unregister();
  });

  test("does not touch other senders' runs in the same thread", () => {
    const alice = chatOpsRunRegistry.register(TG_THREAD, {
      supersede: { senderId: "alice", sequence: 100 },
    });
    const bob = chatOpsRunRegistry.register(TG_THREAD, {
      supersede: { senderId: "bob", sequence: 101 },
    });

    expect(alice.signal.aborted).toBe(false);
    expect(bob.signal.aborted).toBe(false);

    alice.unregister();
    bob.unregister();
  });

  test("runs registered without supersede are never superseded", () => {
    const plain = chatOpsRunRegistry.register(TG_THREAD);
    const followUp = chatOpsRunRegistry.register(TG_THREAD, {
      supersede: { senderId: "u1", sequence: 101 },
    });

    expect(plain.signal.aborted).toBe(false);
    expect(followUp.signal.aborted).toBe(false);

    plain.unregister();
    followUp.unregister();
  });
});
