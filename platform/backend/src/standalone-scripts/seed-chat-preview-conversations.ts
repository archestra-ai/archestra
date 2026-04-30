import {
  type SeededChatPreviewScenario,
  seededChatPreviewScenarios,
} from "@shared";
import db, { schema } from "@/database";
import logger from "@/logging";
import { AgentModel } from "@/models";

export const CHAT_PREVIEW_AGENT_NAME = "Chat Preview Agent";

export async function seedChatPreviewConversations(params: {
  userId: string;
  organizationId: string;
}): Promise<{
  agentId: string;
  conversationCount: number;
  messageCount: number;
  chatErrorCount: number;
}> {
  const agent = await AgentModel.getDefaultProfile();

  if (!agent) {
    throw "No default profile agent";
  }

  let messageCount = 0;
  let chatErrorCount = 0;

  for (const scenario of seededChatPreviewScenarios) {
    await seedScenario({
      scenario,
      userId: params.userId,
      organizationId: params.organizationId,
      agentId: agent.id,
    });

    messageCount += scenario.messages.length;
    chatErrorCount += scenario.chatErrors?.length ?? 0;
  }

  logger.info(
    {
      agentId: agent.id,
      conversationCount: seededChatPreviewScenarios.length,
      messageCount,
      chatErrorCount,
    },
    "Seeded chat preview conversations",
  );

  return {
    agentId: agent.id,
    conversationCount: seededChatPreviewScenarios.length,
    messageCount,
    chatErrorCount,
  };
}

async function seedScenario(params: {
  scenario: SeededChatPreviewScenario;
  userId: string;
  organizationId: string;
  agentId: string;
}): Promise<void> {
  const { scenario, userId, organizationId, agentId } = params;
  const timelineDates = [
    ...scenario.messages.map((message, index) =>
      getMessageCreatedAt(message, index),
    ),
    ...(scenario.chatErrors?.map((error) => new Date(error.createdAt)) ?? []),
  ];
  if (timelineDates.length === 0) {
    timelineDates.push(new Date(Date.UTC(2026, 3, 23, 10, 0, 0)));
  }
  const createdAt = new Date(Math.min(...timelineDates.map(Number)));
  const updatedAt = new Date(Math.max(...timelineDates.map(Number)));

  await db.insert(schema.conversationsTable).values({
    id: scenario.conversationId,
    userId,
    organizationId,
    agentId,
    title: scenario.title,
    selectedModel: "gpt-5.4-mini",
    selectedProvider: "openai",
    createdAt,
    updatedAt,
  });

  if (scenario.messages.length > 0) {
    await db.insert(schema.messagesTable).values(
      scenario.messages.map((message, index) => ({
        conversationId: scenario.conversationId,
        role: message.role,
        content: message,
        createdAt: getMessageCreatedAt(message, index),
        updatedAt: null,
      })),
    );
  }

  if (scenario.chatErrors && scenario.chatErrors.length > 0) {
    await db.insert(schema.conversationChatErrorsTable).values(
      scenario.chatErrors.map((chatError) => ({
        conversationId: scenario.conversationId,
        error: chatError.error,
        createdAt: new Date(chatError.createdAt),
      })),
    );
  }
}

function getMessageCreatedAt(
  message: {
    metadata?: unknown;
  },
  index: number,
): Date {
  const metadata =
    typeof message.metadata === "object" && message.metadata !== null
      ? (message.metadata as { createdAt?: unknown })
      : {};
  const createdAt = metadata.createdAt;

  if (typeof createdAt === "string" || createdAt instanceof Date) {
    return new Date(createdAt);
  }

  return new Date(Date.UTC(2026, 3, 23, 10, 0, index));
}
