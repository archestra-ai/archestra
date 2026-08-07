import { describe, expect, test } from "vitest";
import { pickAllowedRumAttributes } from "./rum.ee";

describe("pickAllowedRumAttributes", () => {
  test("strips entity ids and free text from product events", () => {
    expect(
      pickAllowedRumAttributes("archestra.message_sent", {
        conversationId: "52092964-0000-4000-8000-000000000000",
        agentId: "7ea04b80-0000-4000-8000-000000000000",
        messageLength: 42,
        fileCount: 0,
        hasSkill: false,
      }),
    ).toEqual({ messageLength: 42, fileCount: 0, hasSkill: false });

    expect(
      pickAllowedRumAttributes("archestra.mcp_server_installation_failed", {
        serverId: "b7b3a1de-0000-4000-8000-000000000000",
        serverName: "Internal Payments MCP",
        errorMessage: "connect ECONNREFUSED 10.0.0.5:8080",
        stage: "runtime",
      }),
    ).toEqual({ stage: "runtime" });
  });

  test("keeps the page-view navigation attributes and nothing else", () => {
    expect(
      pickAllowedRumAttributes("archestra.page_view", {
        "url.path": "/chat/:id",
        referrerPath: "/chat",
        smuggled: "x",
      }),
    ).toEqual({ "url.path": "/chat/:id", referrerPath: "/chat" });
  });

  test("returns undefined when nothing survives or nothing was sent", () => {
    expect(
      pickAllowedRumAttributes("session.start", { smuggled: "x" }),
    ).toBeUndefined();
    expect(
      pickAllowedRumAttributes("archestra.page_view", undefined),
    ).toBeUndefined();
  });
});
