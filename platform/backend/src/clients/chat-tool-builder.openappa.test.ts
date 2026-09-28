import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import config from "@/config";
import { afterEach, expect, test } from "@/test";
import {
  buildMcpGatewayTool,
  buildUnsafeContextBoundaryResult,
  type ChatToolContext,
} from "./chat-tool-builder";
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
    config.openappa = {
      ...config.openappa,
      enabled,
      yellEnabled: false,
      offerSigningSecret: "",
    };
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

// Chat runs the pre-OpenAPPA result policies on its own path rather than
// through `evaluateIfContextIsTrusted`, so it needs its own stand-down check.
// Without one, a chat tool result keeps carrying a boundary and the transcript
// keeps drawing "Sensitive context below" after the guardrail is off.
for (const enabled of [false, true]) {
  test(`chat tool results carry a boundary only while the old guardrail runs (openappa=${enabled})`, async ({
    makeAgent,
  }) => {
    config.openappa = { ...config.openappa, enabled };
    const agent = await makeAgent();

    const result = await buildUnsafeContextBoundaryResult({
      toolCallId: "call-1",
      // No policy covers this tool, which the old guardrail treats as untrusted.
      toolName: "some_server__fetch_page",
      toolOutput: [{ type: "text", text: "page text" }],
      agentId: agent.id,
      considerContextUntrusted: false,
    });

    if (enabled) {
      expect(result.unsafeContextBoundary).toBeUndefined();
      expect(result._meta).toBeUndefined();
    } else {
      expect(result.unsafeContextBoundary).toMatchObject({
        kind: "tool_result",
        reason: "tool_result_marked_untrusted",
        toolCallId: "call-1",
      });
    }
  });
}
