import { describe, expect, it } from "vitest";
import { runChatHref, runRowKind } from "./run-row.utils";

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

  describe("runChatHref", () => {
    it("returns the chat URL for a run with a conversation", () => {
      expect(
        runChatHref({
          triggerId: "t1",
          run: { id: "r1", status: "success", chatConversationId: "c1" },
        }),
      ).toBe("/chat/c1?scheduleTriggerId=t1&scheduleRunId=r1");
    });

    it("returns the chat URL for a failed run WITH a conversation", () => {
      expect(
        runChatHref({
          triggerId: "t1",
          run: { id: "r1", status: "failed", chatConversationId: "c1" },
        }),
      ).toBe("/chat/c1?scheduleTriggerId=t1&scheduleRunId=r1");
    });

    it("returns null for a completed run without a conversation", () => {
      expect(
        runChatHref({
          triggerId: "t1",
          run: { id: "r1", status: "failed", chatConversationId: null },
        }),
      ).toBe(null);
    });

    it("returns null for a running run", () => {
      expect(
        runChatHref({
          triggerId: "t1",
          run: { id: "r1", status: "running", chatConversationId: null },
        }),
      ).toBe(null);
    });
  });
});
