import { describe, expect, it } from "vitest";
import { resolveSharedConversationForkState } from "./shared-conversation-fork";

describe("resolveSharedConversationForkState", () => {
  it("reuses the shared conversation agent when the user can access it", () => {
    expect(
      resolveSharedConversationForkState({
        availableAgentIds: ["agent-a", "agent-b"],
        selectedAgentId: null,
        sharedConversationAgentId: "agent-b",
      }),
    ).toEqual({
      accessibleSharedAgentId: "agent-b",
      shouldPromptForAgentSelection: false,
      effectiveAgentId: "agent-b",
    });
  });

  it("falls back to the first available agent when the shared agent is unavailable", () => {
    expect(
      resolveSharedConversationForkState({
        availableAgentIds: ["agent-a", "agent-b"],
        selectedAgentId: null,
        sharedConversationAgentId: "agent-c",
      }),
    ).toEqual({
      accessibleSharedAgentId: null,
      shouldPromptForAgentSelection: true,
      effectiveAgentId: "agent-a",
    });
  });

  it("preserves an explicit user-selected agent", () => {
    expect(
      resolveSharedConversationForkState({
        availableAgentIds: ["agent-a", "agent-b"],
        selectedAgentId: "agent-a",
        sharedConversationAgentId: "agent-b",
      }),
    ).toEqual({
      accessibleSharedAgentId: "agent-b",
      shouldPromptForAgentSelection: false,
      effectiveAgentId: "agent-a",
    });
  });
});
