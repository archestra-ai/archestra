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
