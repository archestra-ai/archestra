import { describe, expect, test } from "vitest";
import { buildAgentNameMap, enrichSessionRows } from "./logs-table.utils";

describe("buildAgentNameMap", () => {
  test("maps agent ids to names once for row lookups", () => {
    const map = buildAgentNameMap([
      { id: "agent-1", name: "Agent One" },
      { id: "agent-2", name: "Agent Two" },
    ]);

    expect(map.get("agent-1")).toBe("Agent One");
    expect(map.get("agent-2")).toBe("Agent Two");
    expect(map.has("missing")).toBe(false);
  });
});

describe("enrichSessionRows", () => {
  test("precomputes display fields for session rows", () => {
    const rows = enrichSessionRows([
      {
        sessionId: "session-1",
        interactionId: "interaction-1",
        conversationTitle: "Chat title",
        claudeCodeTitle: null,
        sessionSource: "archestra_chat",
        lastInteractionRequest: null,
        lastInteractionType: null,
      },
      {
        sessionId: "session-2",
        interactionId: "interaction-2",
        conversationTitle: null,
        claudeCodeTitle: "Claude task",
        sessionSource: "claude_code",
        lastInteractionRequest: null,
        lastInteractionType: null,
      },
    ]);

    expect(rows[0]).toMatchObject({
      conversationTitle: "Chat title",
      isArchestraChat: "session-1",
      isClaudeCodeSession: false,
      displayText: "",
    });
    expect(rows[1]).toMatchObject({
      isArchestraChat: null,
      isClaudeCodeSession: true,
      displayText: "Claude task",
    });
  });
});
