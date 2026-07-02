import { beforeEach, describe, expect, test } from "vitest";
import {
  setPendingProjectChatHandoff,
  takePendingProjectChatHandoff,
} from "./pending-project-chat-handoff";

// The store is a module-level singleton; overwrite it with a sentinel and drain
// that before each test so cases don't leak state into one another.
beforeEach(() => {
  setPendingProjectChatHandoff({ conversationId: "__reset__", prompt: "" });
  takePendingProjectChatHandoff("__reset__");
});

describe("pendingProjectChatHandoff", () => {
  test("returns the stashed handoff for its conversation and clears it", () => {
    setPendingProjectChatHandoff({
      conversationId: "conv-1",
      prompt: "Say hi",
    });

    expect(takePendingProjectChatHandoff("conv-1")).toEqual({
      conversationId: "conv-1",
      prompt: "Say hi",
    });

    // One-shot: a second take for the same conversation finds nothing.
    expect(takePendingProjectChatHandoff("conv-1")).toBeNull();
  });

  test("does not surrender the handoff to a different conversation id", () => {
    setPendingProjectChatHandoff({
      conversationId: "conv-1",
      prompt: "Say hi",
    });

    // An unrelated /chat/<id> open must not drain another chat's opening prompt.
    expect(takePendingProjectChatHandoff("conv-2")).toBeNull();
    // And the handoff is still available for the conversation it belongs to.
    expect(takePendingProjectChatHandoff("conv-1")?.prompt).toBe("Say hi");
  });

  test("a later handoff replaces an abandoned earlier one", () => {
    setPendingProjectChatHandoff({ conversationId: "conv-1", prompt: "first" });
    setPendingProjectChatHandoff({
      conversationId: "conv-2",
      prompt: "second",
    });

    // The abandoned first handoff is gone; only the latest survives.
    expect(takePendingProjectChatHandoff("conv-1")).toBeNull();
    expect(takePendingProjectChatHandoff("conv-2")?.prompt).toBe("second");
  });

  test("returns null when nothing is stashed", () => {
    expect(takePendingProjectChatHandoff("conv-1")).toBeNull();
  });
});
