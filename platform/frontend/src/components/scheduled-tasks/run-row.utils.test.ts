// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runHref, runRowKind } from "./run-row.utils";

describe("run-row.utils", () => {
  describe("runRowKind", () => {
    it('returns "open-chat" for a successful run with a conversation', () => {
      expect(runRowKind({ status: "success", chatConversationId: "c1" })).toBe(
        "open-chat",
      );
    });

    it('returns "open-chat" for a failed run WITH a conversation (its chat shows the prompt + error card)', () => {
      expect(runRowKind({ status: "failed", chatConversationId: "c1" })).toBe(
        "open-chat",
      );
    });

    it('returns "resolve" for a completed (legacy) run without a conversation', () => {
      expect(runRowKind({ status: "failed", chatConversationId: null })).toBe(
        "resolve",
      );
      expect(runRowKind({ status: "success", chatConversationId: null })).toBe(
        "resolve",
      );
    });

    it('returns "running" for an in-flight run without a conversation yet', () => {
      expect(runRowKind({ status: "running", chatConversationId: null })).toBe(
        "running",
      );
    });
  });

  describe("runHref", () => {
    it("returns the chat URL for a run with a conversation", () => {
      expect(
        runHref({
          triggerId: "t1",
          run: { id: "r1", status: "success", chatConversationId: "c1" },
        }),
      ).toBe("/chat/c1?scheduleTriggerId=t1&scheduleRunId=r1");
    });

    it("returns the chat URL for a failed run WITH a conversation", () => {
      expect(
        runHref({
          triggerId: "t1",
          run: { id: "r1", status: "failed", chatConversationId: "c1" },
        }),
      ).toBe("/chat/c1?scheduleTriggerId=t1&scheduleRunId=r1");
    });

    it("returns null for a completed run without a conversation", () => {
      expect(
        runHref({
          triggerId: "t1",
          run: { id: "r1", status: "failed", chatConversationId: null },
        }),
      ).toBe(null);
    });

    it("returns null for a running run", () => {
      expect(
        runHref({
          triggerId: "t1",
          run: { id: "r1", status: "running", chatConversationId: null },
        }),
      ).toBe(null);
    });
  });
});

describe("scheduled runtime navigation", () => {
  it.each([
    "running",
    "success",
    "failed",
  ])("opens the live runtime for a %s run", (status) => {
    const run = {
      id: "run-1",
      status,
      chatConversationId: null,
      runtimeTaskId: "task-1",
    };
    expect(runRowKind(run)).toBe("open-runtime");
    expect(runHref({ triggerId: "trigger-1", run })).toBe("/chat/runs/task-1");
  });
});
