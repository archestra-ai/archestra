import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { vi } from "vitest";
import { describe, expect, test } from "@/test";
import * as chatClient from "./chat-mcp-client";

describe("chat-mcp-client tool caching", () => {
  test("reuses cached tool definitions for the same agent", async () => {
    const agentId = "agent-cache-test";
    chatClient.clearChatMcpClient(agentId);
    chatClient.__test.clearToolCache(agentId);

    const mockClient = {
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: "lookup_email",
            description: "Lookup email",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
      callTool: vi.fn(),
      close: vi.fn(),
    };

    chatClient.__test.setCachedClient(agentId, mockClient as unknown as Client);

    const first = await chatClient.getChatMcpTools(agentId);
    expect(Object.keys(first)).toEqual(["lookup_email"]);

    const second = await chatClient.getChatMcpTools(agentId);

    expect(second).toBe(first);
    expect(mockClient.listTools).toHaveBeenCalledTimes(1);
    chatClient.clearChatMcpClient(agentId);
    chatClient.__test.clearToolCache(agentId);
  });
});
