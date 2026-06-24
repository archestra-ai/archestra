import { describe, expect, it } from "vitest";
import { runChatHref, runRowKind } from "./run-row.utils";

describe("run-row.utils", () => {
  describe("runRowKind", () => {
    it('returns "open-chat" for a successful run with a conversation', () => {
      expect(runRowKind({ status: "success", chatConversationId: "c1" })).toBe(
        "open-chat",
      );
    });

    it('returns "show-error" for a failed run without a conversation', () => {
      expect(runRowKind({ status: "failed", chatConversationId: null })).toBe(
        "show-error",
      );
    });

    it('returns "show-error" for a failed run even if a conversation exists', () => {
      expect(runRowKind({ status: "failed", chatConversationId: "c1" })).toBe(
        "show-error",
      );
    });

    it('returns "running" for a running run', () => {
      expect(runRowKind({ status: "running", chatConversationId: null })).toBe(
        "running",
      );
    });

    it('returns "running" for a successful run without a conversation yet', () => {
      expect(runRowKind({ status: "success", chatConversationId: null })).toBe(
        "running",
      );
    });
  });

  describe("runChatHref", () => {
    it("returns the chat URL for an openable run", () => {
      expect(
        runChatHref({
          projectId: "p1",
          triggerId: "t1",
          run: { id: "r1", status: "success", chatConversationId: "c1" },
        }),
      ).toBe("/chat/c1?scheduleTriggerId=t1&scheduleRunId=r1");
    });

    it("returns null for a failed run", () => {
      expect(
        runChatHref({
          projectId: "p1",
          triggerId: "t1",
          run: { id: "r1", status: "failed", chatConversationId: null },
        }),
      ).toBe(null);
    });

    it("returns null for a running run", () => {
      expect(
        runChatHref({
          projectId: "p1",
          triggerId: "t1",
          run: { id: "r1", status: "running", chatConversationId: null },
        }),
      ).toBe(null);
    });

    it("returns null for a successful run without a conversation", () => {
      expect(
        runChatHref({
          projectId: "p1",
          triggerId: "t1",
          run: { id: "r1", status: "success", chatConversationId: null },
        }),
      ).toBe(null);
    });
  });
});
