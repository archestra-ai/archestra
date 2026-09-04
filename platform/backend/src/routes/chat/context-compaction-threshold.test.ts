import { ModelModel } from "@/models";
import { expect, test } from "@/test";
import type { ChatMessage } from "@/types";
import { compactMessagesForChat } from "./context-compaction";

test("auto-compaction includes chat-override tool schemas in its context threshold", async ({
  makeAgent,
  makeConversation,
}) => {
  const modelId = "global.anthropic.claude-sonnet-5-threshold-test";
  const model = await ModelModel.create({
    externalId: `bedrock/${modelId}`,
    provider: "bedrock",
    modelId,
    description: "Bedrock context threshold test model",
    contextLength: 1_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    ignored: false,
    lastSyncedAt: new Date(),
  });
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
    modelId: model.id,
  });
  const messages: ChatMessage[] = [
    {
      id: "earlier-user-message",
      role: "user",
      parts: [{ type: "text", text: "Earlier question." }],
    },
    {
      id: "earlier-assistant-message",
      role: "assistant",
      parts: [{ type: "text", text: "Earlier answer." }],
    },
    {
      id: "current-user-message",
      role: "user",
      parts: [{ type: "text", text: "Continue." }],
    },
  ];
  const baseParams = {
    conversationId: conversation.id,
    organizationId: conversation.organizationId,
    userId: conversation.userId,
    agentId: agent.id,
    provider: "bedrock" as const,
    selectedModel: modelId,
    modelId: model.id,
    messages,
    trigger: "auto" as const,
  };

  const belowThreshold = await compactMessagesForChat(baseParams);
  expect(belowThreshold.reason).toBe("below_threshold");

  const abortController = new AbortController();
  abortController.abort();
  const overThreshold = await compactMessagesForChat({
    ...baseParams,
    tools: {
      large_schema_tool: {
        description: "A tool with a large schema.",
        inputSchema: {
          jsonSchema: {
            type: "object",
            properties: {
              payload: {
                type: "string",
                description: "schema context ".repeat(1_000),
              },
            },
          },
        },
      },
    },
    abortSignal: abortController.signal,
  });

  // The aborted result proves the threshold was crossed without invoking a
  // summarization model. Before tool schemas were counted this stayed below
  // the threshold and returned `below_threshold`.
  expect(overThreshold.reason).toBe("aborted");
});
