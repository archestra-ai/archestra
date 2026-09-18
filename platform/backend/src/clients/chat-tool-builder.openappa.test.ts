import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import config from "@/config";
import { afterEach, expect, test } from "@/test";
import { buildMcpGatewayTool, type ChatToolContext } from "./chat-tool-builder";
import { ToolCallRepeatTracker } from "./tool-call-repeat-tracker";

const native = vi.hoisted(() => ({
  initializeOpenappa: vi.fn(() => {
    throw new Error("Chat must not initialize APPA");
  }),
  dispatchHook: vi.fn(() => {
    throw new Error("Chat must not dispatch APPA hooks");
  }),
}));
vi.mock("@archestra/openappa-rs", () => native);
vi.mock("@/hooks/hook-dispatcher-service", () => ({
  hookDispatcherService: {
    fire: vi.fn(async () => ({ decision: "allow", runs: [] })),
  },
}));
afterEach(() => vi.clearAllMocks());

for (const enabled of [false, true]) {
  test(`Chat executes released calls and keeps normal results without APPA hooks (enabled=${enabled})`, async ({
    makeAgent,
    makeUser,
    makeConversation,
    seedAndAssignArchestraTools,
  }) => {
    config.llmProxy.plugins = enabled ? ["appa"] : [];
    config.openappa = { enabled, yellEnabled: false, offerSigningSecret: "" };
    const agent = await makeAgent();
    const user = await makeUser();
    await seedAndAssignArchestraTools(agent.id);
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: agent.organizationId,
    });
    const toolName = archestraMcpBranding.getToolName("whoami");
    const model = new MockLanguageModelV3({
      doGenerate: async ({ prompt }) => {
        const hasResult = prompt.some((message) => message.role === "tool");
        if (hasResult) expect(JSON.stringify(prompt)).toContain(agent.id);
        return {
          content: hasResult
            ? [{ type: "text", text: "Finished" }]
            : [
                {
                  type: "tool-call",
                  toolCallId: "released-call",
                  toolName,
                  input: "{}",
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
      prompt: "Check my identity.",
      tools: {
        [toolName]: buildMcpGatewayTool({
          mcpTool: {
            name: toolName,
            inputSchema: {
              type: "object",
              properties: { to: { type: "string" } },
            },
          },
          ctx: {
            organizationId: agent.organizationId,
            userId: user.id,
            conversationId: conversation.id,
            agentId: agent.id,
            agentName: agent.name,
            repeatTracker: new ToolCallRepeatTracker(),
          } as ChatToolContext,
        }),
      },
      stopWhen: stepCountIs(2),
    });
    expect(result.steps).toHaveLength(2);
    expect(result.text).toBe("Finished");
    expect(JSON.stringify(result.steps[0].toolResults)).toContain(agent.id);
    expect(native.initializeOpenappa).not.toHaveBeenCalled();
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });
}
