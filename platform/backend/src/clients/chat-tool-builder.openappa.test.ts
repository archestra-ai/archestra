import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { expect, it, vi } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { approveToolResult } from "@/openappa/service";
import { buildMcpGatewayTool, type ChatToolContext } from "./chat-tool-builder";

vi.mock("@/openappa/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/openappa/service")>()),
  openappaEnabled: () => true,
  checkToolCalls: vi.fn(async () => ({
    refusalMessage: "[appa] Blocked: recipient is outside Finance.",
  })),
  approveToolResult: vi.fn(),
}));
vi.mock("@/archestra-mcp-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/archestra-mcp-server")>()),
  executeArchestraTool: vi.fn(),
}));

it("returns a blocked tool result and continues to the model explanation without executing the tool", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      const hasResult = prompt.some((message) => message.role === "tool");
      if (hasResult) {
        expect(JSON.stringify(prompt)).toContain(
          "recipient is outside Finance",
        );
        expect(JSON.stringify(prompt)).toContain("The tool was not executed");
      }
      return {
        content: hasResult
          ? [
              {
                type: "text",
                text: "The email was blocked because the recipient is outside Finance.",
              },
            ]
          : [
              {
                type: "tool-call",
                toolCallId: "blocked-email",
                toolName: "archestra__send_email",
                input: '{"to":"engineering.reader@acmeinc.com"}',
              },
            ],
        finishReason: {
          unified: hasResult ? "stop" : "tool-calls",
          raw: undefined,
        },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const result = await generateText({
    model,
    prompt: "Email the budget summary to Engineering.",
    tools: {
      archestra__send_email: buildMcpGatewayTool({
        mcpTool: {
          name: "archestra__send_email",
          inputSchema: {
            type: "object",
            properties: { to: { type: "string" } },
          },
        },
        ctx: {
          organizationId: "org",
          userId: "user",
          conversationId: "conversation",
          agentId: "agent",
          agentName: "Assistant",
        } as ChatToolContext,
      }),
    },
    stopWhen: stepCountIs(2),
  });
  expect(result.steps).toHaveLength(2);
  expect(result.steps[0].toolResults[0].output).toContain("[appa] Blocked");
  expect(result.text).toContain("recipient is outside Finance");
  expect(executeArchestraTool).not.toHaveBeenCalled();
  expect(approveToolResult).not.toHaveBeenCalled();
});
